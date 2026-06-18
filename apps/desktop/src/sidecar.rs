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
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::watch;
use tokio::time::sleep;

const READY_PREFIX: &str = "ZOC_STUDIO_AGENT_PORT=";
const HEALTH_INTERVAL: Duration = Duration::from_secs(5);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(3);
const MIN_BACKOFF: Duration = Duration::from_millis(500);
const MAX_BACKOFF: Duration = Duration::from_secs(30);

#[derive(Default, Clone, Debug, Serialize)]
pub struct AgentStatus {
    pub port: Option<u16>,
    pub running: bool,
    pub restarts: u32,
    pub last_error: Option<String>,
}

#[derive(Default)]
pub struct AgentSupervisor {
    pub status: Mutex<AgentStatus>,
    pub child: Mutex<Option<CommandChild>>,
    pub shutdown_tx: Mutex<Option<watch::Sender<bool>>>,
}

impl AgentSupervisor {
    pub fn current(&self) -> AgentStatus {
        self.status.lock().clone()
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
        self.status.lock().running = false;
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
                Ok(port) => {
                    {
                        let mut status = sup.status.lock();
                        status.port = Some(port);
                        status.running = true;
                        status.last_error = None;
                    }
                    let _ = app.emit("agent://status", sup.current());
                    backoff = MIN_BACKOFF;

                    // Health-poll until child exits or shutdown requested.
                    let died = health_poll_until_dead(port, &mut rx).await;
                    if *rx.borrow() {
                        break;
                    }
                    tracing::warn!(reason = %died, "agent sidecar lost; restarting");
                    {
                        let mut status = sup.status.lock();
                        status.running = false;
                        status.last_error = Some(died);
                    }
                }
                Err(err) => {
                    let msg = format!("{err:#}");
                    tracing::error!(error = %msg, "agent sidecar spawn failed");
                    {
                        let mut status = sup.status.lock();
                        status.running = false;
                        status.last_error = Some(msg);
                    }
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
) -> Result<u16> {
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
    let (mut rx, child) = cmd.spawn().context("failed to spawn agent sidecar")?;
    *sup.child.lock() = Some(child);

    let mut log = open_log(log_path).ok();
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(buf) | CommandEvent::Stderr(buf) => {
                let text = String::from_utf8_lossy(&buf);
                for piece in text.lines() {
                    if let Some(ref mut f) = log {
                        let _ = writeln!(f, "{} {}", chrono::Utc::now().to_rfc3339(), piece);
                    }
                    tracing::debug!(target: "agent_sidecar", "{}", piece);
                    if let Some(rest) = piece.strip_prefix(READY_PREFIX) {
                        let raw = rest.trim();
                        match raw.parse::<u16>() {
                            Ok(p) if p > 0 => return Ok(p),
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
            CommandEvent::Terminated(payload) => {
                anyhow::bail!("agent sidecar exited before announcing port: {:?}", payload);
            }
            _ => {}
        }
    }
    anyhow::bail!("agent sidecar stream ended before announcing port")
}

async fn health_poll_until_dead(port: u16, shutdown: &mut watch::Receiver<bool>) -> String {
    let client = reqwest::Client::builder()
        .timeout(HEALTH_TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let url = format!("http://127.0.0.1:{port}/health");
    let mut failures = 0u32;
    loop {
        tokio::select! {
            _ = sleep(HEALTH_INTERVAL) => {}
            _ = shutdown.changed() => return "shutdown".into(),
        }
        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => failures = 0,
            Ok(resp) => {
                failures += 1;
                if failures >= 3 {
                    return format!("health http {} x{failures}", resp.status());
                }
            }
            Err(err) => {
                failures += 1;
                if failures >= 3 {
                    return format!("health unreachable: {err}");
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
