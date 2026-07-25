//! Sidecar lifecycle: spawn the FastAPI agent, capture its loopback port via
//! the `ZOC_STUDIO_AGENT_PORT=<n>` stdout handshake, then keep it alive
//! with a health-poll loop and exponential-backoff restart. Sidecar stdout
//! and stderr are tee'd to `~/.zoc-studio/logs/agent.log` so the user can
//! inspect crashes without leaving the app.
//!
//! Lifecycle events are surfaced on the `agent://status` Tauri event so the
//! UI can render a banner when the sidecar is restarting.

use std::io::Write;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::{oneshot, watch, Notify};
use tokio::time::sleep;

use crate::workspace::WorkspaceState;

const READY_PREFIX: &str = "ZOC_STUDIO_AGENT_PORT=";
const HEALTH_INTERVAL: Duration = Duration::from_secs(5);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(3);
const MIN_BACKOFF: Duration = Duration::from_millis(500);
const MAX_BACKOFF: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug)]
struct Termination {
    code: Option<i32>,
    signal: Option<i32>,
}

struct SpawnedSidecar {
    port: u16,
    termination: oneshot::Receiver<Termination>,
}

#[derive(Debug, thiserror::Error)]
#[error("agent sidecar exited before announcing port: code={code:?}, signal={signal:?}")]
struct EarlyExit {
    code: Option<i32>,
    signal: Option<i32>,
}

#[derive(Debug, PartialEq, Eq)]
struct SidecarLoss {
    reason: String,
    exit_code: Option<i32>,
    intentional: bool,
}

#[derive(Default, Clone, Debug, Serialize)]
pub struct AgentStatus {
    pub port: Option<u16>,
    pub running: bool,
    pub restarts: u32,
    pub last_error: Option<String>,
    /// Lifecycle phase the UI renders from. `crashed` means the sidecar exited
    /// unexpectedly and a restart is in flight (§11.1).
    pub status: AgentPhase,
    /// Path of the crash report written for the most recent crash, if any.
    pub crash_report: Option<String>,
}

/// Coarse sidecar lifecycle phase surfaced on `agent://status` (§11.1).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentPhase {
    #[default]
    Starting,
    Running,
    Crashed,
    Stopped,
}

/// A persisted crash report (`~/.zoc-studio/crashes/<timestamp>.json`, §11.1).
///
/// Written locally and never transmitted: the Diagnostics panel copies it to the
/// clipboard so the user decides what leaves the machine.
#[derive(Clone, Debug, Serialize)]
pub struct CrashReport {
    pub timestamp: String,
    pub exit_code: Option<i32>,
    pub reason: String,
    pub last_log_lines: Vec<String>,
    pub rust_version: String,
    pub app_version: String,
    pub os_info: String,
}

/// How many trailing log lines a crash report captures.
const CRASH_LOG_LINES: usize = 100;

#[derive(Default)]
pub struct AgentSupervisor {
    pub status: Mutex<AgentStatus>,
    pub child: Mutex<Option<CommandChild>>,
    pub shutdown_tx: Mutex<Option<watch::Sender<bool>>>,
    restart_notify: Notify,
}

impl AgentSupervisor {
    pub fn current(&self) -> AgentStatus {
        self.status.lock().clone()
    }

    /// Restart the child while leaving the supervisor loop active. The health
    /// poll observes the terminated child and the next spawn receives the
    /// current authoritative workspace environment.
    pub fn restart(&self) {
        {
            let mut status = self.status.lock();
            status.running = false;
            status.port = None;
            status.status = AgentPhase::Starting;
        }
        // Publish the restart intent before killing the process. The health
        // task can then classify a simultaneously arriving Terminated event as
        // intentional instead of writing a false crash report.
        self.restart_notify.notify_one();
        if let Some(child) = self.child.lock().take() {
            let _ = child.kill();
        }
    }

    /// Best-effort shutdown: drop the child handle (sends SIGTERM on Unix /
    /// terminates on Windows) and stop the supervisor task.
    pub fn shutdown(&self) {
        if let Some(tx) = self.shutdown_tx.lock().take() {
            let _ = tx.send(true);
        }
        if let Some(child) = self.child.lock().take() {
            let _ = child.kill();
        }
        let mut status = self.status.lock();
        status.running = false;
        status.status = AgentPhase::Stopped;
    }
}

/// Spawn the supervisor task. Returns immediately; the task lives for the
/// app lifetime and restarts the sidecar on crash or health failure.
pub fn supervise<R: Runtime>(app: AppHandle<R>, sup: Arc<AgentSupervisor>) {
    let (tx, mut rx) = watch::channel(false);
    *sup.shutdown_tx.lock() = Some(tx);
    let log_path = log_file_path();

    tauri::async_runtime::spawn(async move {
        let mut backoff = MIN_BACKOFF;
        let mut restarts: u32 = 0;
        loop {
            if *rx.borrow() {
                break;
            }
            match spawn_once(&app, &sup, &log_path).await {
                Ok(mut spawned) => {
                    {
                        let mut status = sup.status.lock();
                        status.port = Some(spawned.port);
                        status.running = true;
                        status.last_error = None;
                        status.status = AgentPhase::Running;
                    }
                    let _ = app.emit("agent://status", sup.current());
                    backoff = MIN_BACKOFF;

                    // Observe the real process termination event alongside the
                    // health poll. This preserves the non-zero exit code and
                    // keeps draining stdout/stderr after the port handshake.
                    let loss = health_poll_until_dead(
                        spawned.port,
                        &mut rx,
                        &sup,
                        &mut spawned.termination,
                    )
                    .await;
                    if *rx.borrow() {
                        break;
                    }
                    if loss.intentional {
                        tracing::info!(reason = %loss.reason, "agent sidecar restart requested");
                        let mut status = sup.status.lock();
                        status.port = None;
                        status.running = false;
                        status.last_error = None;
                        status.status = AgentPhase::Starting;
                        status.crash_report = None;
                    } else {
                        tracing::warn!(reason = %loss.reason, exit_code = ?loss.exit_code, "agent sidecar lost; restarting");
                        // Capture the tail now, before the restart adds new
                        // startup lines to the same log.
                        let report = write_crash_report(&log_path, loss.exit_code, &loss.reason);
                        let last_error =
                            last_log_line(&log_path).unwrap_or_else(|| loss.reason.clone());
                        {
                            let mut status = sup.status.lock();
                            status.port = None;
                            status.running = false;
                            status.last_error = Some(last_error);
                            status.status = AgentPhase::Crashed;
                            status.crash_report =
                                report.as_ref().map(|p| p.to_string_lossy().to_string());
                        }
                    }
                    let _ = app.emit("agent://status", sup.current());
                }
                Err(err) => {
                    let exit_code = err.downcast_ref::<EarlyExit>().and_then(|e| e.code);
                    let msg = format!("{err:#}");
                    tracing::error!(error = %msg, exit_code = ?exit_code, "agent sidecar spawn failed");
                    let report = write_crash_report(&log_path, exit_code, &msg);
                    {
                        let mut status = sup.status.lock();
                        status.port = None;
                        status.running = false;
                        status.last_error = Some(msg);
                        status.status = AgentPhase::Crashed;
                        status.crash_report =
                            report.as_ref().map(|p| p.to_string_lossy().to_string());
                    }
                    let _ = app.emit("agent://status", sup.current());
                }
            }
            // Drop any lingering child handle before backing off.
            if let Some(child) = sup.child.lock().take() {
                let _ = child.kill();
            }
            restarts = restarts.saturating_add(1);
            sup.status.lock().restarts = restarts;
            let _ = app.emit("agent://status", sup.current());

            tokio::select! {
                _ = sleep(backoff) => {}
                _ = rx.changed() => { break; }
            }
            backoff = (backoff * 2).min(MAX_BACKOFF);
        }
        tracing::info!("agent supervisor exiting");
    });
}

async fn spawn_once<R: Runtime>(
    app: &AppHandle<R>,
    sup: &Arc<AgentSupervisor>,
    log_path: &std::path::Path,
) -> Result<SpawnedSidecar> {
    let shell = app.shell();
    let mut cmd = shell
        .sidecar("zoc-studio-agent")
        .context("sidecar binary not configured")?;
    // Bundled hotpath sits next to the main executable (Tauri externalBin
    // layout). Pin the agent to that path so we never fall back to PATH or
    // a developer's repo target/ when running an installed build.
    if let Some(hp) = bundled_hotpath_path() {
        cmd = cmd.env("ZOC_STUDIO_HOTPATH_BIN", hp);
    }
    cmd = cmd.env(
        "ZOC_STUDIO_LLAMACPP_STATE_PATH",
        runtime_state_path().to_string_lossy().to_string(),
    );
    let workspace = app.state::<Arc<WorkspaceState>>();
    if let Some(root) = workspace.get() {
        cmd = cmd.env("ZOC_STUDIO_WORKSPACE", root.to_string_lossy().to_string());
    }
    let (mut events, child) = cmd.spawn().context("failed to spawn agent sidecar")?;
    *sup.child.lock() = Some(child);

    let mut log = open_log(log_path).ok();
    while let Some(event) = events.recv().await {
        match event {
            CommandEvent::Stdout(buf) | CommandEvent::Stderr(buf) => {
                for piece in record_sidecar_output(&mut log, &buf) {
                    if let Some(rest) = piece.strip_prefix(READY_PREFIX) {
                        let raw = rest.trim();
                        match raw.parse::<u16>() {
                            Ok(port) if port > 0 => {
                                let (termination_tx, termination) = oneshot::channel();
                                tauri::async_runtime::spawn(async move {
                                    let mut sender = Some(termination_tx);
                                    while let Some(event) = events.recv().await {
                                        match event {
                                            CommandEvent::Stdout(buf)
                                            | CommandEvent::Stderr(buf) => {
                                                record_sidecar_output(&mut log, &buf);
                                            }
                                            CommandEvent::Error(error) => {
                                                record_sidecar_message(
                                                    &mut log,
                                                    &format!("sidecar event error: {error}"),
                                                );
                                            }
                                            CommandEvent::Terminated(payload) => {
                                                if let Some(tx) = sender.take() {
                                                    let _ = tx.send(Termination {
                                                        code: payload.code,
                                                        signal: payload.signal,
                                                    });
                                                }
                                                return;
                                            }
                                            _ => {}
                                        }
                                    }
                                    if let Some(tx) = sender.take() {
                                        let _ = tx.send(Termination {
                                            code: None,
                                            signal: None,
                                        });
                                    }
                                });
                                return Ok(SpawnedSidecar { port, termination });
                            }
                            Ok(_) => {
                                tracing::warn!(
                                    target: "agent_sidecar",
                                    "ignoring port handshake with port 0: {piece}"
                                );
                            }
                            Err(err) => {
                                tracing::warn!(
                                    target: "agent_sidecar",
                                    "could not parse port handshake `{raw}`: {err}; full line: {piece}"
                                );
                            }
                        }
                    }
                }
            }
            CommandEvent::Error(error) => {
                record_sidecar_message(&mut log, &format!("sidecar event error: {error}"));
            }
            CommandEvent::Terminated(payload) => {
                return Err(EarlyExit {
                    code: payload.code,
                    signal: payload.signal,
                }
                .into());
            }
            _ => {}
        }
    }
    anyhow::bail!("agent sidecar stream ended before announcing port")
}

fn record_sidecar_output(log: &mut Option<std::fs::File>, buf: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(buf);
    let lines: Vec<String> = text.lines().map(ToOwned::to_owned).collect();
    for piece in &lines {
        record_sidecar_message(log, piece);
    }
    lines
}

fn record_sidecar_message(log: &mut Option<std::fs::File>, message: &str) {
    if let Some(file) = log {
        let _ = writeln!(file, "{} {}", chrono::Utc::now().to_rfc3339(), message);
    }
    tracing::debug!(target: "agent_sidecar", "{}", message);
}

async fn health_poll_until_dead(
    port: u16,
    shutdown: &mut watch::Receiver<bool>,
    sup: &Arc<AgentSupervisor>,
    termination: &mut oneshot::Receiver<Termination>,
) -> SidecarLoss {
    let client = reqwest::Client::builder()
        .timeout(HEALTH_TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let url = format!("http://127.0.0.1:{port}/health");
    let mut failures = 0u32;
    loop {
        tokio::select! {
            biased;
            _ = shutdown.changed() => {
                return SidecarLoss {
                    reason: "shutdown".into(),
                    exit_code: None,
                    intentional: true,
                };
            }
            _ = sup.restart_notify.notified() => {
                return SidecarLoss {
                    reason: "workspace changed".into(),
                    exit_code: None,
                    intentional: true,
                };
            }
            terminated = &mut *termination => {
                let termination = terminated.unwrap_or(Termination {
                    code: None,
                    signal: None,
                });
                let reason = match (termination.code, termination.signal) {
                    (Some(code), _) => format!("agent sidecar exited with code {code}"),
                    (None, Some(signal)) => format!("agent sidecar terminated by signal {signal}"),
                    (None, None) => "agent sidecar event stream ended".to_string(),
                };
                return SidecarLoss {
                    reason,
                    exit_code: termination.code,
                    intentional: false,
                };
            }
            _ = sleep(HEALTH_INTERVAL) => {}
        }
        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => failures = 0,
            Ok(resp) => {
                failures += 1;
                if failures >= 3 {
                    return SidecarLoss {
                        reason: format!("health http {} x{failures}", resp.status()),
                        exit_code: None,
                        intentional: false,
                    };
                }
            }
            Err(err) => {
                failures += 1;
                if failures >= 3 {
                    return SidecarLoss {
                        reason: format!("health unreachable: {err}"),
                        exit_code: None,
                        intentional: false,
                    };
                }
            }
        }
    }
}

/// Resolve the bundled `zoc-studio-hotpath` binary that Tauri ships as an
/// `externalBin` alongside the main executable. Returns `None` only if the
/// platform-specific path can't be determined or the binary is missing —
/// callers treat that as "fall back to env/PATH" (dev mode).
fn bundled_hotpath_path() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let name = if cfg!(windows) {
        "zoc-studio-hotpath.exe"
    } else {
        "zoc-studio-hotpath"
    };
    let candidate = dir.join(name);
    if candidate.exists() {
        Some(candidate)
    } else {
        None
    }
}

fn log_file_path() -> std::path::PathBuf {
    let base = dirs::home_dir()
        .map(|h| h.join(".zoc-studio").join("logs"))
        .unwrap_or_else(|| std::path::PathBuf::from("./logs"));
    let _ = std::fs::create_dir_all(&base);
    base.join("agent.log")
}

/// Directory holding crash reports (`~/.zoc-studio/crashes`, §11.1).
pub fn crash_dir() -> std::path::PathBuf {
    let base = dirs::home_dir()
        .map(|h| h.join(".zoc-studio").join("crashes"))
        .unwrap_or_else(|| std::path::PathBuf::from("./crashes"));
    let _ = std::fs::create_dir_all(&base);
    base
}

/// Read the last `count` lines of `path`.
///
/// Reads the whole file and keeps a bounded tail. Agent logs are rotated by
/// size elsewhere and a crash path is not hot, so the simple approach is
/// preferable to seek-based scanning here.
pub fn tail_lines(path: &std::path::Path, count: usize) -> Vec<String> {
    let Ok(contents) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let lines: Vec<&str> = contents.lines().collect();
    let start = lines.len().saturating_sub(count);
    lines[start..].iter().map(|s| s.to_string()).collect()
}

fn last_log_line(path: &std::path::Path) -> Option<String> {
    tail_lines(path, 1).pop()
}

/// Build a crash report from the current environment and log tail.
pub fn build_crash_report(
    log_path: &std::path::Path,
    exit_code: Option<i32>,
    reason: &str,
) -> CrashReport {
    CrashReport {
        timestamp: chrono::Utc::now().to_rfc3339(),
        exit_code,
        reason: reason.to_string(),
        last_log_lines: tail_lines(log_path, CRASH_LOG_LINES),
        // Recorded at compile time: the running binary has no rustc available.
        rust_version: option_env!("CARGO_PKG_RUST_VERSION")
            .unwrap_or("unknown")
            .to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os_info: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
    }
}

/// Persist a crash report and return its path.
///
/// Failures are swallowed: a crash report that cannot be written must not
/// interfere with restarting the sidecar, which is the user-visible priority.
fn write_crash_report(
    log_path: &std::path::Path,
    exit_code: Option<i32>,
    reason: &str,
) -> Option<std::path::PathBuf> {
    let report = build_crash_report(log_path, exit_code, reason);
    let dir = crash_dir();
    // Colons are illegal in Windows filenames, so flatten the RFC3339 stamp.
    let stamp = report.timestamp.replace([':', '.'], "-");
    let path = dir.join(format!("{stamp}.json"));
    let json = serde_json::to_string_pretty(&report).ok()?;
    match std::fs::write(&path, json) {
        Ok(()) => {
            tracing::info!(path = %path.display(), "wrote agent crash report");
            Some(path)
        }
        Err(err) => {
            tracing::warn!(error = %err, "could not write crash report");
            None
        }
    }
}

/// List persisted crash reports, newest first (§11.1 Diagnostics panel).
#[tauri::command]
pub fn agent_crash_reports() -> Vec<serde_json::Value> {
    let dir = crash_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut reports: Vec<(String, serde_json::Value)> = entries
        .flatten()
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
        .filter_map(|entry| {
            let path = entry.path();
            let text = std::fs::read_to_string(&path).ok()?;
            let mut value: serde_json::Value = serde_json::from_str(&text).ok()?;
            let name = path.file_name()?.to_string_lossy().to_string();
            if let Some(map) = value.as_object_mut() {
                map.insert("file".into(), serde_json::Value::String(name.clone()));
                map.insert(
                    "path".into(),
                    serde_json::Value::String(path.to_string_lossy().to_string()),
                );
            }
            Some((name, value))
        })
        .collect();
    // Filenames are lexicographically sortable timestamps.
    reports.sort_by(|a, b| b.0.cmp(&a.0));
    reports.into_iter().map(|(_, value)| value).collect()
}

/// Delete every persisted crash report.
#[tauri::command]
pub fn agent_crash_reports_clear() -> Result<u32, String> {
    let dir = crash_dir();
    let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    let mut removed = 0u32;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|x| x.to_str()) == Some("json")
            && std::fs::remove_file(&path).is_ok()
        {
            removed += 1;
        }
    }
    Ok(removed)
}

/// Restart the sidecar on demand (the crash banner's "Retry" affordance).
#[tauri::command]
pub fn agent_restart(state: tauri::State<'_, Arc<AgentSupervisor>>) {
    state.restart();
}

fn runtime_state_path() -> std::path::PathBuf {
    let base = dirs::home_dir()
        .map(|h| h.join(".zoc-studio"))
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let _ = std::fs::create_dir_all(&base);
    base.join("llamacpp-runtime.json")
}

fn open_log(path: &std::path::Path) -> Result<std::fs::File> {
    Ok(std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_log(lines: usize) -> tempfile::NamedTempFile {
        let mut file = tempfile::NamedTempFile::new().expect("temp log");
        for i in 0..lines {
            writeln!(file, "line {i}").expect("write");
        }
        file.flush().expect("flush");
        file
    }

    #[test]
    fn tail_lines_returns_the_last_n_lines() {
        let file = temp_log(150);
        let tail = tail_lines(file.path(), 100);
        assert_eq!(tail.len(), 100);
        assert_eq!(tail.first().unwrap(), "line 50");
        assert_eq!(tail.last().unwrap(), "line 149");
    }

    #[test]
    fn tail_lines_handles_short_and_missing_files() {
        let file = temp_log(3);
        assert_eq!(tail_lines(file.path(), 100).len(), 3);
        assert!(tail_lines(std::path::Path::new("/nope/missing.log"), 10).is_empty());
    }

    #[test]
    fn crash_report_captures_context_and_log_tail() {
        let file = temp_log(200);
        let report = build_crash_report(file.path(), Some(9), "health unreachable");

        assert_eq!(report.exit_code, Some(9));
        assert_eq!(report.reason, "health unreachable");
        assert_eq!(report.last_log_lines.len(), CRASH_LOG_LINES);
        assert_eq!(report.app_version, env!("CARGO_PKG_VERSION"));
        assert!(report.os_info.contains(std::env::consts::OS));
        // Timestamp must be RFC3339 so filenames sort chronologically.
        assert!(report.timestamp.contains('T'));
    }

    #[test]
    fn crash_report_serialises_to_the_documented_shape() {
        let file = temp_log(1);
        let report = build_crash_report(file.path(), None, "boom");
        let json: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&report).unwrap()).unwrap();

        for key in [
            "timestamp",
            "exit_code",
            "reason",
            "last_log_lines",
            "rust_version",
            "app_version",
            "os_info",
        ] {
            assert!(json.get(key).is_some(), "missing {key}");
        }
    }

    #[test]
    fn agent_phase_serialises_lowercase() {
        assert_eq!(
            serde_json::to_string(&AgentPhase::Crashed).unwrap(),
            "\"crashed\""
        );
        assert_eq!(
            serde_json::to_string(&AgentPhase::Running).unwrap(),
            "\"running\""
        );
    }

    #[test]
    fn default_status_starts_in_starting_phase() {
        let status = AgentStatus::default();
        assert_eq!(status.status, AgentPhase::Starting);
        assert!(status.crash_report.is_none());
    }

    #[test]
    fn early_exit_preserves_the_process_code() {
        let error: anyhow::Error = EarlyExit {
            code: Some(23),
            signal: None,
        }
        .into();
        assert_eq!(
            error.downcast_ref::<EarlyExit>().and_then(|e| e.code),
            Some(23)
        );
    }

    #[tokio::test]
    async fn termination_event_reaches_crash_report_path_with_exit_code() {
        let (termination_tx, mut termination_rx) = oneshot::channel();
        termination_tx
            .send(Termination {
                code: Some(17),
                signal: None,
            })
            .expect("send termination");
        let (_shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let supervisor = Arc::new(AgentSupervisor::default());

        let loss =
            health_poll_until_dead(9, &mut shutdown_rx, &supervisor, &mut termination_rx).await;

        assert_eq!(loss.exit_code, Some(17));
        assert!(!loss.intentional);
        assert!(loss.reason.contains("17"));
    }

    #[tokio::test]
    async fn intentional_restart_wins_a_simultaneous_termination() {
        let (termination_tx, mut termination_rx) = oneshot::channel();
        termination_tx
            .send(Termination {
                code: Some(9),
                signal: None,
            })
            .expect("send termination");
        let (_shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let supervisor = Arc::new(AgentSupervisor::default());
        supervisor.restart_notify.notify_one();

        let loss =
            health_poll_until_dead(9, &mut shutdown_rx, &supervisor, &mut termination_rx).await;

        assert!(loss.intentional);
        assert_eq!(loss.exit_code, None);
        assert_eq!(loss.reason, "workspace changed");
    }
}
