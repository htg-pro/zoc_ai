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
    health_poll_until_dead_inner(
        port,
        shutdown,
        &sup.restart_notify,
        termination,
        "agent sidecar",
    )
    .await
}

/// Watch one child until it dies, is asked to restart, or the app shuts down.
///
/// Shared by both supervisors. It takes the `Notify` rather than the supervisor
/// so neither concrete status type leaks in — the loop's whole job is to
/// classify *why* a child went away, and that classification is identical for
/// the Python sidecar and the Node runtime.
///
/// `subject` appears in the reason string, which the crash report records and
/// the status banner shows, so a user reading "exited with code 1" can tell
/// which process they are reading about.
async fn health_poll_until_dead_inner(
    port: u16,
    shutdown: &mut watch::Receiver<bool>,
    restart_notify: &Notify,
    termination: &mut oneshot::Receiver<Termination>,
    subject: &str,
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
            _ = restart_notify.notified() => {
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
                    (Some(code), _) => format!("{subject} exited with code {code}"),
                    (None, Some(signal)) => format!("{subject} terminated by signal {signal}"),
                    (None, None) => format!("{subject} event stream ended"),
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

// ══════════════════════════════════════════════════════════════════════════
// Agent_Runtime supervisor — zoc-agent-chat-rebuild R3.1, R3.2, R3.4, R3.7,
// R3.8, R3.9
// ══════════════════════════════════════════════════════════════════════════
//
// Mirrors the Python supervisor above rather than generalising it. The shapes
// are the same — `Mutex<Status>`, `Mutex<Option<CommandChild>>`, a
// `watch::Sender<bool>` shutdown channel, 500 ms → 30 s backoff, crash reports
// through `build_crash_report` — but the two children differ in every detail
// that matters: a different handshake prefix, a different log file, a different
// status event, and one of them holds a bearer token the other has no concept
// of. A shared generic would have to be parameterised on all four, and the
// parameter list would be longer than the duplication it removed.

/// The line the Node runtime prints on stdout as its first output (R3.2).
const RUNTIME_READY_PREFIX: &str = "ZOC_RUNTIME_PORT=";

/// Bytes of CSPRNG material behind the per-launch bearer token (R3.4).
const RUNTIME_TOKEN_BYTES: usize = 32;

/// What one line of child output turned out to be (R3.2).
///
/// Three outcomes rather than an `Option<u16>` so the two failure shapes stay
/// distinguishable in the log: a line that announced an unusable port is a
/// runtime bug worth reading, and a line that was never a handshake at all is
/// just ordinary output.
#[derive(Debug, PartialEq, Eq)]
enum ReadyLine {
    /// Not a handshake line.
    Other,
    /// A handshake line carrying a usable port.
    Port(u16),
    /// A handshake line that could not be used, with the reason for the log.
    Unusable(String),
}

/// Classify one line of child output against a port-handshake prefix.
///
/// Both supervisors tee into `~/.zoc-studio/logs/`, so the prefix is matched
/// exactly and neither child's handshake can satisfy the other's supervisor.
fn classify_ready_line(line: &str, prefix: &str) -> ReadyLine {
    let Some(rest) = line.strip_prefix(prefix) else {
        return ReadyLine::Other;
    };
    let raw = rest.trim();
    match raw.parse::<u16>() {
        Ok(port) if port > 0 => ReadyLine::Port(port),
        Ok(_) => ReadyLine::Unusable(format!("port 0 in `{line}`")),
        Err(err) => ReadyLine::Unusable(format!("could not parse `{raw}`: {err}")),
    }
}

/// Endpoint handed to the renderer by `agent_runtime_endpoint()` (R3.4).
#[derive(Clone, Debug, Serialize)]
pub struct RuntimeEndpoint {
    pub port: Option<u16>,
    /// The per-launch bearer token. Held only in supervisor memory and never
    /// written to disk, so a stolen config file yields nothing.
    pub token: Option<String>,
    pub status: AgentPhase,
}

#[derive(Default, Clone, Debug, Serialize)]
pub struct RuntimeStatus {
    pub port: Option<u16>,
    pub running: bool,
    pub restarts: u32,
    pub last_error: Option<String>,
    /// `crashed` is what the Chat_Surface's runtime-status subscriber reads to
    /// mark the active Run failed with `runtime_unavailable` (R3.8).
    pub status: AgentPhase,
    pub crash_report: Option<String>,
}

#[derive(Default)]
pub struct AgentRuntimeSupervisor {
    pub status: Mutex<RuntimeStatus>,
    pub child: Mutex<Option<CommandChild>>,
    pub shutdown_tx: Mutex<Option<watch::Sender<bool>>>,
    /// The live launch token. Rotated on every spawn: a restart invalidates
    /// every credential the previous child's peers were holding, which is the
    /// point of scoping it to a launch rather than to the app.
    token: Mutex<Option<String>>,
    restart_notify: Notify,
}

impl AgentRuntimeSupervisor {
    pub fn current(&self) -> RuntimeStatus {
        self.status.lock().clone()
    }

    /// The renderer- and runtime-facing endpoint (R3.4).
    pub fn endpoint(&self) -> RuntimeEndpoint {
        let status = self.status.lock().clone();
        RuntimeEndpoint {
            port: status.port,
            // The token is withheld until the child is actually running. Handing
            // out a token for a dead port invites the renderer to spend its
            // readiness budget authenticating against nothing.
            token: if status.running {
                self.token.lock().clone()
            } else {
                None
            },
            status: status.status,
        }
    }

    /// Test-only: hold a launch token without spawning a child.
    ///
    /// The real token is minted by the spawn path and never leaves supervisor
    /// state, which is what makes `runtime_secret_get`'s authenticated path
    /// otherwise untestable — a test cannot spawn the packaged runtime binary.
    #[cfg(test)]
    pub(crate) fn install_token_for_test(&self, token: &str) {
        *self.token.lock() = Some(token.to_string());
    }

    /// Constant-time check used by `runtime_secret_get` (R14.10, task 4.2).
    pub fn token_matches(&self, presented: &str) -> bool {
        let held = self.token.lock().clone();
        match held {
            Some(token) => constant_time_eq(token.as_bytes(), presented.as_bytes()),
            None => false,
        }
    }

    pub fn restart(&self) {
        {
            let mut status = self.status.lock();
            status.running = false;
            status.port = None;
            status.status = AgentPhase::Starting;
        }
        self.restart_notify.notify_one();
        if let Some(child) = self.child.lock().take() {
            let _ = child.kill();
        }
    }

    /// R3.7: the same shutdown path already proven for the Python sidecar —
    /// drop the child handle (SIGTERM on Unix, terminate on Windows) and stop
    /// the supervisor task, leaving no orphan.
    pub fn shutdown(&self) {
        if let Some(tx) = self.shutdown_tx.lock().take() {
            let _ = tx.send(true);
        }
        if let Some(child) = self.child.lock().take() {
            let _ = child.kill();
        }
        // Drop the token on the way out so a post-shutdown reader gets nothing.
        *self.token.lock() = None;
        let mut status = self.status.lock();
        status.running = false;
        status.status = AgentPhase::Stopped;
    }
}

/// Compare two byte strings without leaking their contents through timing.
///
/// Length is compared first and returns early, which does leak length — that is
/// acceptable here because the token's length is a compile-time constant and
/// therefore not a secret. What must not leak is the *content*.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// base64url without padding, per RFC 4648 §5.
///
/// Hand-written rather than pulled from a crate: this is the one function
/// standing between CSPRNG bytes and a bearer token, it is twenty lines, and a
/// reviewer of a security-relevant change can read all of it.
fn base64url_nopad(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity((bytes.len() * 4 + 2) / 3);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        let indices = [
            (triple >> 18) & 0x3f,
            (triple >> 12) & 0x3f,
            (triple >> 6) & 0x3f,
            triple & 0x3f,
        ];
        // 3 input bytes → 4 chars, 2 → 3, 1 → 2. No padding is emitted.
        let emit = chunk.len() + 1;
        for index in indices.iter().take(emit) {
            out.push(ALPHABET[*index as usize] as char);
        }
    }
    out
}

/// Mint a fresh per-launch bearer token (R3.4).
fn mint_runtime_token() -> Result<String> {
    let mut bytes = [0u8; RUNTIME_TOKEN_BYTES];
    getrandom::getrandom(&mut bytes)
        .map_err(|err| anyhow::anyhow!("CSPRNG unavailable, refusing to start runtime: {err}"))?;
    Ok(base64url_nopad(&bytes))
}

fn runtime_log_file_path() -> std::path::PathBuf {
    let base = dirs::home_dir()
        .map(|h| h.join(".zoc-studio").join("logs"))
        .unwrap_or_else(|| std::path::PathBuf::from("./logs"));
    let _ = std::fs::create_dir_all(&base);
    base.join("agent-runtime.log")
}

/// Spawn the Agent_Runtime supervisor task.
///
/// `workspace_services_port` is read from the Python supervisor's status on
/// every spawn rather than captured once, because the Python sidecar restarts
/// independently and a captured port goes stale the first time it does.
pub fn supervise_runtime<R: Runtime>(
    app: AppHandle<R>,
    sup: Arc<AgentRuntimeSupervisor>,
    python: Arc<AgentSupervisor>,
) {
    let (tx, mut rx) = watch::channel(false);
    *sup.shutdown_tx.lock() = Some(tx);
    let log_path = runtime_log_file_path();

    tauri::async_runtime::spawn(async move {
        let mut backoff = MIN_BACKOFF;
        let mut restarts: u32 = 0;
        loop {
            if *rx.borrow() {
                break;
            }
            match runtime_spawn_once(&app, &sup, &python, &log_path).await {
                Ok(mut spawned) => {
                    {
                        let mut status = sup.status.lock();
                        status.port = Some(spawned.port);
                        status.running = true;
                        status.last_error = None;
                        status.status = AgentPhase::Running;
                    }
                    let _ = app.emit("runtime://status", sup.current());
                    backoff = MIN_BACKOFF;

                    let loss = health_poll_until_dead_inner(
                        spawned.port,
                        &mut rx,
                        &sup.restart_notify,
                        &mut spawned.termination,
                        "agent runtime",
                    )
                    .await;
                    if *rx.borrow() {
                        break;
                    }
                    if loss.intentional {
                        tracing::info!(reason = %loss.reason, "agent runtime restart requested");
                        let mut status = sup.status.lock();
                        status.port = None;
                        status.running = false;
                        status.last_error = None;
                        status.status = AgentPhase::Starting;
                        status.crash_report = None;
                    } else {
                        tracing::warn!(reason = %loss.reason, exit_code = ?loss.exit_code, "agent runtime lost; restarting");
                        let report = write_crash_report(&log_path, loss.exit_code, &loss.reason);
                        let last_error =
                            last_log_line(&log_path).unwrap_or_else(|| loss.reason.clone());
                        let mut status = sup.status.lock();
                        status.port = None;
                        status.running = false;
                        status.last_error = Some(last_error);
                        status.status = AgentPhase::Crashed;
                        status.crash_report =
                            report.as_ref().map(|p| p.to_string_lossy().to_string());
                    }
                    let _ = app.emit("runtime://status", sup.current());
                }
                Err(err) => {
                    let exit_code = err.downcast_ref::<EarlyExit>().and_then(|e| e.code);
                    let msg = format!("{err:#}");
                    tracing::error!(error = %msg, exit_code = ?exit_code, "agent runtime spawn failed");
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
                    let _ = app.emit("runtime://status", sup.current());
                }
            }
            if let Some(child) = sup.child.lock().take() {
                let _ = child.kill();
            }
            restarts = restarts.saturating_add(1);
            sup.status.lock().restarts = restarts;
            let _ = app.emit("runtime://status", sup.current());

            tokio::select! {
                _ = sleep(backoff) => {}
                _ = rx.changed() => { break; }
            }
            backoff = (backoff * 2).min(MAX_BACKOFF);
        }
        tracing::info!("agent runtime supervisor exiting");
    });
}

async fn runtime_spawn_once<R: Runtime>(
    app: &AppHandle<R>,
    sup: &Arc<AgentRuntimeSupervisor>,
    python: &Arc<AgentSupervisor>,
    log_path: &std::path::Path,
) -> Result<SpawnedSidecar> {
    // Mint the token before the spawn so the child's environment can carry it
    // and the renderer's `agent_runtime_endpoint()` can hand out the same value.
    let token = mint_runtime_token()?;

    let shell = app.shell();
    let mut cmd = shell
        .sidecar("zoc-studio-agent-runtime")
        .context("agent runtime sidecar binary not configured")?;

    cmd = cmd.env("ZOC_RUNTIME_TOKEN", token.clone());

    // Workspace_Services is the retained Python surface. Reading its port here
    // rather than at supervisor start is deliberate: it restarts on its own
    // schedule and a captured port is stale after the first restart.
    let services_port = python.status.lock().port;
    let services_url = match services_port {
        Some(port) => format!("http://127.0.0.1:{port}"),
        // Not an error: the runtime tolerates a workspace service that is not
        // up yet, and every workspace tool call is already written to convert a
        // transport failure into a retryable tool result rather than a crash
        // (R6.6). Failing the spawn here would take the whole chat surface down
        // for a condition that resolves itself in a few hundred milliseconds.
        None => "http://127.0.0.1:0".to_string(),
    };
    cmd = cmd.env("ZOC_WORKSPACE_SERVICES_URL", services_url);

    let workspace = app.state::<Arc<WorkspaceState>>();
    let root = workspace
        .get()
        .map(|root| root.to_string_lossy().to_string())
        .unwrap_or_default();
    cmd = cmd.env("ZOC_STUDIO_WORKSPACE", root);

    // R14.10: where the runtime fetches one provider key per Run. Absent when
    // the loopback key service could not bind, in which case the runtime falls
    // back to an empty secret source and cloud Runs report `no_key_configured`
    // — an accurate failure rather than a silent one.
    if let Some(bridge) = app.try_state::<Arc<crate::runtime_bridge::RuntimeBridge>>() {
        if let Some(secret_url) = bridge.secret_url() {
            cmd = cmd.env("ZOC_DESKTOP_KEY_URL", secret_url);
        }
        if let Some(base) = bridge.base_url() {
            cmd = cmd.env("ZOC_DESKTOP_BRIDGE_URL", base);
        }
    }

    let (mut events, child) = cmd.spawn().context("failed to spawn agent runtime")?;
    *sup.child.lock() = Some(child);

    let mut log = open_log(log_path).ok();
    while let Some(event) = events.recv().await {
        match event {
            CommandEvent::Stdout(buf) | CommandEvent::Stderr(buf) => {
                for piece in record_sidecar_output(&mut log, &buf) {
                    match classify_ready_line(&piece, RUNTIME_READY_PREFIX) {
                        ReadyLine::Other => continue,
                        ReadyLine::Port(port) => {
                            // Publish the token only once the handshake proves
                            // the child is alive and listening.
                            *sup.token.lock() = Some(token);
                            let (termination_tx, termination) = oneshot::channel();
                            tauri::async_runtime::spawn(async move {
                                let mut sender = Some(termination_tx);
                                while let Some(event) = events.recv().await {
                                    match event {
                                        CommandEvent::Stdout(buf) | CommandEvent::Stderr(buf) => {
                                            record_sidecar_output(&mut log, &buf);
                                        }
                                        CommandEvent::Error(error) => {
                                            record_sidecar_message(
                                                &mut log,
                                                &format!("runtime event error: {error}"),
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
                        ReadyLine::Unusable(why) => tracing::warn!(
                            target: "agent_runtime",
                            "ignoring runtime port handshake: {why}"
                        ),
                    }
                }
            }
            CommandEvent::Error(error) => {
                record_sidecar_message(&mut log, &format!("runtime event error: {error}"));
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
    anyhow::bail!("agent runtime stream ended before announcing port")
}

/// The endpoint handoff (R3.4). Registered in the renderer capability set.
#[tauri::command]
pub fn agent_runtime_endpoint(
    state: tauri::State<'_, Arc<AgentRuntimeSupervisor>>,
) -> RuntimeEndpoint {
    state.endpoint()
}

#[tauri::command]
pub fn agent_runtime_status(state: tauri::State<'_, Arc<AgentRuntimeSupervisor>>) -> RuntimeStatus {
    state.current()
}

/// Restart the runtime on demand — the crash banner's control (R3.8).
#[tauri::command]
pub fn runtime_restart(state: tauri::State<'_, Arc<AgentRuntimeSupervisor>>) {
    state.restart();
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

    // ── Agent_Runtime supervisor ──────────────────────────────────────────
    // zoc-agent-chat-rebuild R3.1, R3.2, R3.4, R3.7, R3.8

    #[test]
    fn base64url_matches_the_rfc4648_vectors_without_padding() {
        // RFC 4648 §10, minus the padding §5 permits omitting.
        for (input, expected) in [
            ("", ""),
            ("f", "Zg"),
            ("fo", "Zm8"),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg"),
            ("fooba", "Zm9vYmE"),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64url_nopad(input.as_bytes()), expected, "for {input:?}");
        }
    }

    #[test]
    fn base64url_uses_the_url_safe_alphabet() {
        // The one byte triple that produces both of the two characters
        // standard base64 and base64url disagree on.
        assert_eq!(base64url_nopad(&[0xfb, 0xff, 0xfe]), "-__-");
    }

    #[test]
    fn launch_token_is_32_random_bytes_of_url_safe_base64() {
        let token = mint_runtime_token().expect("CSPRNG");

        // 32 bytes at 6 bits per character, unpadded.
        assert_eq!(token.len(), 43);
        assert!(
            token
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "token must survive an Authorization header verbatim: {token}"
        );
        assert!(!token.contains('='), "no padding");
    }

    #[test]
    fn each_launch_mints_a_fresh_token() {
        let a = mint_runtime_token().expect("CSPRNG");
        let b = mint_runtime_token().expect("CSPRNG");
        assert_ne!(a, b);
    }

    #[test]
    fn constant_time_eq_agrees_with_equality() {
        assert!(constant_time_eq(b"", b""));
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(!constant_time_eq(b"abc", b""));
    }

    #[test]
    fn endpoint_withholds_the_token_until_the_child_is_running() {
        let sup = AgentRuntimeSupervisor::default();
        *sup.token.lock() = Some("tok".into());

        // Starting: a port is not yet known and the token buys nothing.
        let before = sup.endpoint();
        assert_eq!(before.status, AgentPhase::Starting);
        assert!(before.token.is_none());
        assert!(before.port.is_none());

        {
            let mut status = sup.status.lock();
            status.running = true;
            status.port = Some(45_123);
            status.status = AgentPhase::Running;
        }
        let after = sup.endpoint();
        assert_eq!(after.token.as_deref(), Some("tok"));
        assert_eq!(after.port, Some(45_123));
        assert_eq!(after.status, AgentPhase::Running);
    }

    #[test]
    fn token_matches_refuses_before_the_handshake() {
        let sup = AgentRuntimeSupervisor::default();

        // The interesting case: an empty presented credential against an absent
        // held token must be a refusal, not a vacuous match.
        assert!(!sup.token_matches(""));
        assert!(!sup.token_matches("anything"));

        *sup.token.lock() = Some("s3cret".into());
        assert!(sup.token_matches("s3cret"));
        assert!(!sup.token_matches("s3crey"));
        assert!(!sup.token_matches("s3cret "));
        assert!(!sup.token_matches(""));
    }

    #[test]
    fn shutdown_stops_the_runtime_and_drops_the_token() {
        let sup = AgentRuntimeSupervisor::default();
        let (tx, rx) = watch::channel(false);
        *sup.shutdown_tx.lock() = Some(tx);
        *sup.token.lock() = Some("tok".into());
        {
            let mut status = sup.status.lock();
            status.running = true;
            status.port = Some(45_123);
            status.status = AgentPhase::Running;
        }

        sup.shutdown();

        // R3.7: the supervisor task is told to stop, so no restart races the
        // window teardown and no child is left behind.
        assert!(*rx.borrow());
        assert_eq!(sup.current().status, AgentPhase::Stopped);
        assert!(!sup.current().running);
        assert!(sup.token.lock().is_none());
        assert!(!sup.token_matches("tok"));
    }

    #[test]
    fn runtime_status_carries_no_token_field() {
        // The `runtime://status` payload. A token field here would broadcast the
        // bearer capability to every listener on the event, so its absence is
        // pinned rather than left to review.
        let sup = AgentRuntimeSupervisor::default();
        *sup.token.lock() = Some("s3cret".into());
        let json = serde_json::to_string(&sup.current()).unwrap();

        assert!(!json.contains("token"), "{json}");
        assert!(!json.contains("s3cret"), "{json}");

        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        let object = value.as_object().expect("status is an object");
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "crash_report",
                "last_error",
                "port",
                "restarts",
                "running",
                "status"
            ]
        );
    }

    #[test]
    fn runtime_status_reports_the_crashed_phase() {
        // R3.8: `crashed` is the value the Chat_Surface subscriber keys off to
        // fail the active Run with `runtime_unavailable`.
        let sup = AgentRuntimeSupervisor::default();
        {
            let mut status = sup.status.lock();
            status.status = AgentPhase::Crashed;
            status.last_error = Some("agent runtime exited with code 1".into());
        }
        let json = serde_json::to_string(&sup.current()).unwrap();
        assert!(json.contains("\"crashed\""), "{json}");
    }

    #[test]
    fn crash_report_never_carries_the_launch_token() {
        // The report is built from the log tail, and the token is never written
        // to the log — so this asserts the whole path, not just the shape.
        let token = mint_runtime_token().expect("CSPRNG");
        let mut file = tempfile::NamedTempFile::new().expect("temp log");
        writeln!(file, "ZOC_RUNTIME_PORT=45123").unwrap();
        writeln!(file, "runtime event error: connection reset").unwrap();
        file.flush().unwrap();

        let report = build_crash_report(file.path(), Some(1), "agent runtime exited with code 1");
        let json = serde_json::to_string(&report).unwrap();

        assert!(!json.contains(&token));
        assert!(!json.contains("ZOC_RUNTIME_TOKEN"));
    }

    #[test]
    fn runtime_handshake_line_is_parsed_off_the_child_output() {
        assert_eq!(
            classify_ready_line("ZOC_RUNTIME_PORT=45123", RUNTIME_READY_PREFIX),
            ReadyLine::Port(45_123)
        );
        // Trailing whitespace survives a line-buffered writer.
        assert_eq!(
            classify_ready_line("ZOC_RUNTIME_PORT= 45123 ", RUNTIME_READY_PREFIX),
            ReadyLine::Port(45_123)
        );
        assert_eq!(
            classify_ready_line("listening on loopback", RUNTIME_READY_PREFIX),
            ReadyLine::Other
        );
        assert!(matches!(
            classify_ready_line("ZOC_RUNTIME_PORT=0", RUNTIME_READY_PREFIX),
            ReadyLine::Unusable(_)
        ));
        assert!(matches!(
            classify_ready_line("ZOC_RUNTIME_PORT=not-a-port", RUNTIME_READY_PREFIX),
            ReadyLine::Unusable(_)
        ));
        assert!(matches!(
            classify_ready_line("ZOC_RUNTIME_PORT=70000", RUNTIME_READY_PREFIX),
            ReadyLine::Unusable(_)
        ));
    }

    #[test]
    fn the_two_supervisors_do_not_read_each_others_handshake() {
        // Both children tee into ~/.zoc-studio/logs/, and both supervisors scan
        // every line they emit. A prefix that matched loosely would let the
        // Python sidecar's port be handed out as the runtime's.
        assert_eq!(
            classify_ready_line("ZOC_STUDIO_AGENT_PORT=8000", RUNTIME_READY_PREFIX),
            ReadyLine::Other
        );
        assert_eq!(
            classify_ready_line("ZOC_RUNTIME_PORT=45123", READY_PREFIX),
            ReadyLine::Other
        );
    }

    #[tokio::test]
    async fn runtime_termination_is_classified_as_a_crash_with_its_exit_code() {
        // The runtime shares the Python supervisor's classification loop, so
        // this pins the "agent runtime" subject that reaches the crash report
        // and the status banner (R3.8).
        let (termination_tx, mut termination_rx) = oneshot::channel();
        termination_tx
            .send(Termination {
                code: Some(1),
                signal: None,
            })
            .expect("send termination");
        let (_shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let sup = Arc::new(AgentRuntimeSupervisor::default());

        let loss = health_poll_until_dead_inner(
            9,
            &mut shutdown_rx,
            &sup.restart_notify,
            &mut termination_rx,
            "agent runtime",
        )
        .await;

        assert!(!loss.intentional);
        assert_eq!(loss.exit_code, Some(1));
        assert_eq!(loss.reason, "agent runtime exited with code 1");
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
