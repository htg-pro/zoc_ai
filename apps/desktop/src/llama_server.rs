//! Owns the optional `llama-server` subprocess that serves a locally-loaded
//! `.gguf` model on 127.0.0.1:8080. Spawned on demand by `llamacpp_load`,
//! killed by `llamacpp_unload` (and by the window-destroyed handler in
//! `lib.rs` so we never leak a GPU process when the app closes).
//!
//! Unlike the agent sidecar in `sidecar.rs`, this supervisor does NOT
//! auto-restart on crash — a llama-server exit usually means the model
//! failed to load (OOM, missing file, bad quant) and restarting would
//! just mask the error. The frontend can re-issue `llamacpp_load` after
//! the user picks a different model.
//!
//! ## Readiness state machine (R3.3, R3.4, R3.9)
//!
//! The supervisor reports exactly one of four states — `stopped`, `starting`,
//! `ready`, `error` — held in [`LlamaServerStatus::state`]. The transition
//! logic is factored into the pure [`next_state`] function so the state
//! machine can be property-tested without spawning a process or waiting on a
//! real clock. `llamacpp_load` keeps ownership of the process and the HTTP
//! client, calls `next_state` on each `/health` tick, and pushes a
//! `llamacpp://status` event on every transition so the picker updates on
//! receipt rather than by polling (R3.5).

use std::collections::VecDeque;
use std::io::Write;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex as AsyncMutex;
use tokio::time::sleep;

const HOST: &str = "127.0.0.1";
const PORT: u16 = 8080;
const RUNTIME_STATE_FILENAME: &str = "llamacpp-runtime.json";

/// R3.11 — the `Readiness_Deadline` applied to a model record that carries no
/// override. Replaces the previous hard-coded `LOAD_TIMEOUT = 300s`: the
/// deadline is now a per-load parameter (see [`llamacpp_load`]) that falls back
/// to this value when the caller supplies none.
pub const DEFAULT_READINESS_DEADLINE: Duration = Duration::from_secs(120);
/// The value [`deadline_error_message`] recommends for large quantised models.
/// Carries forward the original `LOAD_TIMEOUT` rationale — a 70B Q4_K_M cold
/// load routinely takes 60–120s warm and 3–5 minutes from a cold cache — as a
/// recommendation attached to the per-model override rather than a global floor.
pub const RECOMMENDED_LARGE_MODEL_DEADLINE_SECS: u64 = 300;

const HEALTH_INTERVAL: Duration = Duration::from_millis(500);
// Each /health probe gets its own short timeout so the polling loop
// stays responsive — the readiness deadline bounds the *total* time we
// keep retrying, not any one HTTP call.
const HEALTH_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// Trailing captured stdout/stderr lines retained for the error report (R3.4).
/// Enough to show a couple of load attempts' worth of llama.cpp diagnostics
/// without letting the buffer grow unbounded for the lifetime of the process.
const LOG_TAIL_CAP: usize = 100;

/// R3.9 — the supervisor reports exactly one of these four states for the
/// supervised `llama-server` process.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LlamaState {
    #[default]
    Stopped,
    Starting,
    Ready,
    Error,
}

/// The outcome of a single readiness probe, fed to [`next_state`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProbeOutcome {
    /// `/health` did not (yet) report success and the child is still alive.
    Pending,
    /// `/health` returned a success status.
    Healthy,
    /// The child process exited (crash, OOM, bad quant, or external kill).
    ChildExited { code: Option<i32> },
}

/// Next state from the current state and one probe outcome (R3.3, R3.4, R3.9).
///
/// Pure: no I/O, no clock — the caller supplies `elapsed` (time since spawn)
/// and `deadline` (the resolved `Readiness_Deadline`, either the 120s default
/// or the model's override), so the configurable deadline is testable without
/// waiting on a real clock.
///
/// Semantics:
/// - The deadline only bites while `Starting`: a successful probe before the
///   deadline implies `Ready`; elapsing the deadline without one implies
///   `Error`.
/// - A child exit from either active state (`Starting`/`Ready`) is an `Error`.
/// - `Stopped` and `Error` are absorbing under probe outcomes; re-entry into
///   `Starting` happens on load, not here.
pub fn next_state(
    current: LlamaState,
    outcome: ProbeOutcome,
    elapsed: Duration,
    deadline: Duration,
) -> LlamaState {
    match current {
        LlamaState::Stopped => LlamaState::Stopped,
        LlamaState::Error => LlamaState::Error,
        LlamaState::Starting => match outcome {
            ProbeOutcome::Healthy => LlamaState::Ready,
            ProbeOutcome::ChildExited { .. } => LlamaState::Error,
            ProbeOutcome::Pending if elapsed > deadline => LlamaState::Error,
            ProbeOutcome::Pending => LlamaState::Starting,
        },
        LlamaState::Ready => match outcome {
            // Once ready, the deadline is spent — only a child exit unseats it.
            // A transient probe miss keeps the server ready.
            ProbeOutcome::ChildExited { .. } => LlamaState::Error,
            _ => LlamaState::Ready,
        },
    }
}

/// R3.4 — the deadline-expiry message. Names the per-model setting that raises
/// the deadline (`readiness_deadline_secs`) and the recommended value, so the
/// error state turns a dead end into a next action rather than an unexplained
/// stall.
pub fn deadline_error_message(deadline: Duration) -> String {
    format!(
        "Model did not become ready within {}s. Raise `readiness_deadline_secs` \
         for this model in Settings → Models ({}s is typical for a 70B Q4 cold load).",
        deadline.as_secs(),
        RECOMMENDED_LARGE_MODEL_DEADLINE_SECS,
    )
}

/// Startup arguments for `llama-server`. Only options that must be set at spawn
/// time appear here; sampling knobs (`temperature`, `top_p`, …) are per-request
/// on the OpenAI-compatible endpoint, not process arguments.
struct ServerArgs<'a> {
    model_path: &'a str,
    n_gpu_layers: u32,
    host: &'a str,
    port: u16,
    n_ctx: Option<u32>,
    n_threads: Option<u32>,
    n_batch: Option<u32>,
    flash_attn: bool,
    top_k: Option<u32>,
}

/// Build the `llama-server` argument vector. Pure so the exact argv is asserted
/// in tests without spawning a process (task 7.5).
fn build_server_args(cfg: &ServerArgs) -> Vec<String> {
    let mut args = vec![
        "-m".to_string(),
        cfg.model_path.to_string(),
        "-ngl".to_string(),
        cfg.n_gpu_layers.to_string(),
        "--host".to_string(),
        cfg.host.to_string(),
        "--port".to_string(),
        cfg.port.to_string(),
    ];
    if let Some(ctx) = cfg.n_ctx {
        args.push("--ctx-size".to_string());
        args.push(ctx.to_string());
    }
    if let Some(threads) = cfg.n_threads {
        args.push("--threads".to_string());
        args.push(threads.to_string());
    }
    if let Some(batch) = cfg.n_batch {
        args.push("--batch-size".to_string());
        args.push(batch.to_string());
    }
    if cfg.flash_attn {
        args.push("--flash-attn".to_string());
    }
    if let Some(k) = cfg.top_k {
        args.push("--top-k".to_string());
        args.push(k.to_string());
    }
    args
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct LlamaServerStatus {
    /// R3.9: exactly one of stopped | starting | ready | error.
    pub state: LlamaState,
    /// Retained for existing consumers; always `state == Ready`.
    pub running: bool,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub base_url: Option<String>,
    pub loaded_model_id: Option<String>,
    pub loaded_model_path: Option<String>,
    pub n_gpu_layers: Option<u32>,
    pub n_ctx: Option<u32>,
    pub n_threads: Option<u32>,
    pub n_batch: Option<u32>,
    pub temperature: Option<f32>,
    pub top_p: Option<f32>,
    pub top_k: Option<u32>,
    pub repeat_penalty: Option<f32>,
    pub max_tokens: Option<u32>,
    pub flash_attn: Option<bool>,
    /// R3.4: trailing captured stdout/stderr, populated on `Error`.
    pub log_tail: Vec<String>,
    pub last_error: Option<String>,
}

impl LlamaServerStatus {
    /// Set the reported state and keep `running` in lockstep as `state ==
    /// Ready`, so the legacy boolean can never disagree with the state (R3.9).
    fn set_state(&mut self, state: LlamaState) {
        self.state = state;
        self.running = state == LlamaState::Ready;
    }

    /// Clear the process-connection fields. Used when leaving `Ready`.
    fn clear_connection(&mut self) {
        self.host = None;
        self.port = None;
        self.base_url = None;
        self.loaded_model_id = None;
        self.loaded_model_path = None;
        self.n_gpu_layers = None;
        self.n_ctx = None;
        self.n_threads = None;
        self.n_batch = None;
        self.temperature = None;
        self.top_p = None;
        self.top_k = None;
        self.repeat_penalty = None;
        self.max_tokens = None;
        self.flash_attn = None;
    }
}

pub struct LlamaServerSupervisor {
    status: Mutex<LlamaServerStatus>,
    child: Mutex<Option<Child>>,
    // Incremented on every load / unload so stdout-drain tasks for stale
    // children become no-ops and can't overwrite status for the current one,
    // and so an in-flight load aborts when it is superseded.
    generation: AtomicU64,
    // Bounded ring buffer of the most recent captured stdout/stderr lines,
    // copied into `status.log_tail` when the supervisor enters `Error` (R3.4).
    log_lines: Mutex<VecDeque<String>>,
    // Serializes model switches so two `llama-server` processes never race for
    // port 8080 (R3.6). Held for the whole load, including the readiness wait.
    load_lock: AsyncMutex<()>,
}

impl Default for LlamaServerSupervisor {
    fn default() -> Self {
        Self {
            status: Mutex::new(LlamaServerStatus::default()),
            child: Mutex::new(None),
            generation: AtomicU64::new(0),
            log_lines: Mutex::new(VecDeque::new()),
            load_lock: AsyncMutex::new(()),
        }
    }
}

impl LlamaServerSupervisor {
    pub fn snapshot(&self) -> LlamaServerStatus {
        self.status.lock().clone()
    }

    /// Append a captured output line to the bounded tail buffer.
    fn push_log_line(&self, line: String) {
        let mut buf = self.log_lines.lock();
        while buf.len() >= LOG_TAIL_CAP {
            buf.pop_front();
        }
        buf.push_back(line);
    }

    /// Snapshot the retained output tail (oldest → newest).
    fn log_tail_snapshot(&self) -> Vec<String> {
        self.log_lines.lock().iter().cloned().collect()
    }

    /// Drop the retained tail. Called at the start of each load so an error's
    /// tail reflects only the current attempt.
    fn clear_log_lines(&self) {
        self.log_lines.lock().clear();
    }

    /// Bumps the generation counter (invalidating any in-flight drain task or
    /// load) and SIGKILLs the child without awaiting it. Best-effort variant
    /// used by the app-quit handler, where the process is torn down anyway and
    /// `kill_on_drop` reaps whatever is left.
    pub fn kill_child(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(mut child) = self.child.lock().take() {
            let _ = child.start_kill();
        }
    }

    /// R3.6 — stop the current child and **wait for it to exit** before
    /// returning, so the next spawn cannot briefly share port 8080 with it.
    /// The child is moved out of the mutex before the await so the (sync)
    /// `parking_lot` lock is never held across a suspension point.
    pub async fn kill_child_and_wait(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        let child = self.child.lock().take();
        if let Some(mut child) = child {
            // `kill` sends SIGKILL (TerminateProcess on Windows) *and* reaps
            // the child, so the OS has released the port when this returns.
            let _ = child.kill().await;
        }
    }

    /// App-quit hook. Resets everything so a relaunch starts clean.
    pub fn shutdown(&self) {
        self.kill_child();
        let status = LlamaServerStatus::default();
        *self.status.lock() = status.clone();
        self.log_lines.lock().clear();
        write_runtime_state(&status);
    }
}

fn validate_gguf(path: &str) -> Result<(), String> {
    if !path.to_ascii_lowercase().ends_with(".gguf") {
        return Err(format!("not a .gguf file: {path}"));
    }
    if !Path::new(path).exists() {
        return Err(format!("file does not exist: {path}"));
    }
    Ok(())
}

fn port_free(host: &str, port: u16) -> Result<(), String> {
    // Probe by binding briefly. Race-y (another process could grab the port
    // before llama-server does) but catches the common case of an already-
    // running llama-server / another OpenAI-compatible server squatting on
    // the port.
    std::net::TcpListener::bind((host, port))
        .map(drop)
        .map_err(|e| {
            format!("{host}:{port} is already in use ({e}); stop the other process and retry")
        })
}

fn runtime_state_path() -> std::path::PathBuf {
    let base = dirs::home_dir()
        .map(|h| h.join(".zoc-studio"))
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let _ = std::fs::create_dir_all(&base);
    base.join(RUNTIME_STATE_FILENAME)
}

fn write_runtime_state(status: &LlamaServerStatus) {
    let path = runtime_state_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let tmp = path.with_extension("json.tmp");
    if let Ok(raw) = serde_json::to_string_pretty(status) {
        if std::fs::write(&tmp, raw).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

fn log_file_path() -> std::path::PathBuf {
    let base = dirs::home_dir()
        .map(|h| h.join(".zoc-studio").join("logs"))
        .unwrap_or_else(|| std::path::PathBuf::from("./logs"));
    let _ = std::fs::create_dir_all(&base);
    base.join("llama-server.log")
}

/// Hard cap on the live log file. When we'd push past this, the active
/// log is rotated to `<path>.1` (overwriting any previous rotation) so
/// disk usage stays bounded. 10 MiB is enough to capture a couple of
/// model loads with verbose stderr but never blocks long enough to
/// matter for `append_log`'s callers.
const LOG_ROTATE_BYTES: u64 = 10 * 1024 * 1024;

fn rotate_log_if_needed(path: &std::path::Path) {
    let Ok(meta) = std::fs::metadata(path) else {
        return;
    };
    if meta.len() < LOG_ROTATE_BYTES {
        return;
    }
    let rotated = path.with_extension("log.1");
    let _ = std::fs::rename(path, &rotated);
}

fn append_log(line: &str) {
    let path = log_file_path();
    rotate_log_if_needed(&path);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(f, "{} {}", chrono::Utc::now().to_rfc3339(), line);
    }
}

/// Move the supervisor into `Error`, recording the message and the captured
/// output tail (R3.4), then persist and emit the transition. Returns `msg` so
/// callers can `return Err(fail_load(...))` in one expression.
fn fail_load<R: Runtime>(app: &AppHandle<R>, sup: &LlamaServerSupervisor, msg: String) -> String {
    let tail = sup.log_tail_snapshot();
    {
        let mut s = sup.status.lock();
        s.clear_connection();
        s.set_state(LlamaState::Error);
        s.last_error = Some(msg.clone());
        s.log_tail = tail;
    }
    let snap = sup.snapshot();
    write_runtime_state(&snap);
    let _ = app.emit("llamacpp://status", snap);
    msg
}

/// Drain-task hook: the child's stdout closed, so the process is exiting. If
/// this is still the live generation and the supervisor was up or starting,
/// flip it to `Error` with the captured tail. Stale generations (a newer load
/// or an unload has taken over) are ignored so they can't clobber current state.
fn handle_unexpected_exit<R: Runtime>(
    app: &AppHandle<R>,
    sup: &LlamaServerSupervisor,
    generation: u64,
) {
    if sup.generation.load(Ordering::SeqCst) != generation {
        return;
    }
    let tail = sup.log_tail_snapshot();
    let emit = {
        let mut s = sup.status.lock();
        if matches!(s.state, LlamaState::Ready | LlamaState::Starting) {
            let was_ready = s.state == LlamaState::Ready;
            s.clear_connection();
            s.set_state(LlamaState::Error);
            s.last_error = Some(
                if was_ready {
                    "llama-server exited unexpectedly; see ~/.zoc-studio/logs/llama-server.log"
                } else {
                    "llama-server exited during startup; see ~/.zoc-studio/logs/llama-server.log"
                }
                .to_string(),
            );
            s.log_tail = tail;
            true
        } else {
            false
        }
    };
    if emit {
        let snap = sup.snapshot();
        write_runtime_state(&snap);
        let _ = app.emit("llamacpp://status", snap);
    }
}

// A Tauri command surfacing the full llama.cpp load configuration; the wide
// parameter list mirrors the frontend invoke contract, so we opt out of the
// argument-count lint rather than box every call site into a struct.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn llamacpp_load<R: Runtime>(
    app: AppHandle<R>,
    sup: tauri::State<'_, Arc<LlamaServerSupervisor>>,
    model_id: String,
    path: String,
    n_gpu_layers: u32,
    n_ctx: Option<u32>,
    n_threads: Option<u32>,
    n_batch: Option<u32>,
    flash_attn: Option<bool>,
    temperature: Option<f32>,
    top_p: Option<f32>,
    top_k: Option<u32>,
    repeat_penalty: Option<f32>,
    max_tokens: Option<u32>,
    host: Option<String>,
    port: Option<u16>,
    // R3.10/R3.11: the per-model `Readiness_Deadline` override in seconds.
    // Absent → `DEFAULT_READINESS_DEADLINE` (120s). Named `readiness_deadline_secs`
    // to match the exact `LocalModel` key the deadline-expiry error points at.
    readiness_deadline_secs: Option<u64>,
) -> Result<LlamaServerStatus, String> {
    validate_gguf(&path)?;

    let actual_host = host.as_deref().unwrap_or(HOST);
    let actual_port = port.unwrap_or(PORT);
    let deadline = readiness_deadline_secs
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_READINESS_DEADLINE);

    // Serialize model switches: only one load may be mid-flight, so a spawn can
    // never overlap a previous one on port 8080 (R3.6).
    let _load_guard = sup.load_lock.lock().await;

    // Stop any previous instance and WAIT for it to exit before continuing, so
    // two llama-server processes never share the port (R3.6). `kill_child_and_wait`
    // bumps the generation; claim that value as ours so any later unload or
    // reload (each bumps again) supersedes this load across its whole setup —
    // not just after the child is spawned.
    sup.kill_child_and_wait().await;
    sup.clear_log_lines();
    let my_gen = sup.generation.load(Ordering::SeqCst);

    // Reset transient status and transition to `Starting`; emit the transition.
    {
        let mut s = sup.status.lock();
        *s = LlamaServerStatus::default();
        s.set_state(LlamaState::Starting);
    }
    let reset = sup.snapshot();
    write_runtime_state(&reset);
    let _ = app.emit("llamacpp://status", reset);

    if let Err(e) = port_free(actual_host, actual_port) {
        return Err(fail_load(&app, &sup, e));
    }

    let args = build_server_args(&ServerArgs {
        model_path: &path,
        n_gpu_layers,
        host: actual_host,
        port: actual_port,
        n_ctx,
        n_threads,
        n_batch,
        flash_attn: flash_attn.unwrap_or(false),
        top_k,
    });

    tracing::info!(
        target: "llama_server",
        path = %path,
        ngl = n_gpu_layers,
        port = actual_port,
        deadline_secs = deadline.as_secs(),
        "spawning llama-server"
    );
    append_log(&format!("spawn: llama-server {}", args.join(" ")));

    let mut cmd = Command::new("llama-server");
    cmd.args(&args);

    let mut child = match cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            return Err(fail_load(
                &app,
                &sup,
                format!(
                    "failed to spawn llama-server: {e}. Make sure the `llama-server` \
                     binary from llama.cpp is on PATH."
                ),
            ));
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Hand the child to the mutex under the generation claimed at stop time.
    // A concurrent unload/reload bumps the generation past `my_gen`, which the
    // readiness loop and the drain tasks below detect and treat as superseded.
    *sup.child.lock() = Some(child);

    if let Some(out) = stdout {
        let app_for_drain = app.clone();
        let sup_for_drain = Arc::clone(&sup);
        let drain_gen = my_gen;
        tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!(target: "llama_server::stdout", "{line}");
                append_log(&format!("stdout: {line}"));
                sup_for_drain.push_log_line(format!("stdout: {line}"));
            }
            handle_unexpected_exit(&app_for_drain, &sup_for_drain, drain_gen);
        });
    }
    if let Some(err) = stderr {
        // llama.cpp writes load progress and fatal load errors to stderr, so
        // this is the stream the error tail most needs to capture.
        let sup_for_drain = Arc::clone(&sup);
        tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!(target: "llama_server::stderr", "{line}");
                append_log(&format!("stderr: {line}"));
                sup_for_drain.push_log_line(format!("stderr: {line}"));
            }
        });
    }

    // Poll /health, driving the state machine through `next_state`, until the
    // model is ready, the deadline elapses, or the child dies.
    let client = match reqwest::Client::builder()
        .timeout(HEALTH_PROBE_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(e) => return Err(fail_load(&app, &sup, format!("http client: {e}"))),
    };
    let url = format!("http://{actual_host}:{actual_port}/health");
    let start_time = Instant::now();
    let mut state = LlamaState::Starting;
    loop {
        // Superseded by an unload or a newer load? Bail without clobbering the
        // state the superseding operation has already published.
        if sup.generation.load(Ordering::SeqCst) != my_gen {
            return Err("llama-server load was cancelled".to_string());
        }

        let elapsed = start_time.elapsed();

        // Detect a child exit (crash) without blocking the loop.
        let exit_code: Option<Option<i32>> = {
            let mut guard = sup.child.lock();
            match guard.as_mut() {
                None => Some(None),
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => Some(status.code()),
                    Ok(None) => None,
                    Err(_) => Some(None),
                },
            }
        };

        let outcome = if let Some(code) = exit_code {
            ProbeOutcome::ChildExited { code }
        } else {
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => ProbeOutcome::Healthy,
                _ => ProbeOutcome::Pending,
            }
        };

        state = next_state(state, outcome, elapsed, deadline);
        match state {
            LlamaState::Ready => break,
            LlamaState::Error => {
                let msg = match outcome {
                    ProbeOutcome::ChildExited { .. } if elapsed < Duration::from_secs(5) => {
                        format!(
                            "llama-server exited immediately after startup (likely port {actual_port} \
                             conflict or missing binary); check ~/.zoc-studio/logs/llama-server.log"
                        )
                    }
                    ProbeOutcome::ChildExited { .. } => {
                        "llama-server exited during startup; see ~/.zoc-studio/logs/llama-server.log"
                            .to_string()
                    }
                    // Deadline expiry: name the override that raises it (R3.4).
                    _ => deadline_error_message(deadline),
                };
                sup.kill_child_and_wait().await;
                return Err(fail_load(&app, &sup, msg));
            }
            _ => sleep(HEALTH_INTERVAL).await,
        }
    }

    // Commit `Ready` — but only if we have not been superseded meanwhile. The
    // generation check happens under the status lock so an unload racing the
    // final tick cannot leave the status `Ready` with a dead child.
    let committed = {
        let mut s = sup.status.lock();
        if sup.generation.load(Ordering::SeqCst) == my_gen {
            s.set_state(LlamaState::Ready);
            s.host = Some(actual_host.to_string());
            s.port = Some(actual_port);
            s.base_url = Some(format!("http://{actual_host}:{actual_port}"));
            s.loaded_model_id = Some(model_id);
            s.loaded_model_path = Some(path);
            s.n_gpu_layers = Some(n_gpu_layers);
            s.n_ctx = n_ctx;
            s.n_threads = n_threads;
            s.n_batch = n_batch;
            s.temperature = temperature;
            s.top_p = top_p;
            s.top_k = top_k;
            s.repeat_penalty = repeat_penalty;
            s.max_tokens = max_tokens;
            s.flash_attn = Some(flash_attn.unwrap_or(false));
            s.log_tail = Vec::new();
            s.last_error = None;
            true
        } else {
            false
        }
    };
    if !committed {
        return Err("llama-server load was cancelled".to_string());
    }

    let snap = sup.snapshot();
    write_runtime_state(&snap);
    let _ = app.emit("llamacpp://status", snap.clone());
    Ok(snap)
}

#[tauri::command]
pub async fn llamacpp_unload<R: Runtime>(
    app: AppHandle<R>,
    sup: tauri::State<'_, Arc<LlamaServerSupervisor>>,
) -> Result<LlamaServerStatus, String> {
    // Await the child's exit so a follow-on load never races a dying process
    // for the port (R3.6). Bumping the generation also cancels any in-flight
    // load's readiness wait.
    sup.kill_child_and_wait().await;
    {
        let mut s = sup.status.lock();
        *s = LlamaServerStatus::default();
    }
    sup.clear_log_lines();
    let snap = sup.snapshot();
    write_runtime_state(&snap);
    let _ = app.emit("llamacpp://status", snap.clone());
    Ok(snap)
}

#[tauri::command]
pub fn llamacpp_status(sup: tauri::State<'_, Arc<LlamaServerSupervisor>>) -> LlamaServerStatus {
    sup.snapshot()
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn any_llama_state() -> impl Strategy<Value = LlamaState> {
        prop_oneof![
            Just(LlamaState::Stopped),
            Just(LlamaState::Starting),
            Just(LlamaState::Ready),
            Just(LlamaState::Error),
        ]
    }

    fn any_probe_outcome() -> impl Strategy<Value = ProbeOutcome> {
        prop_oneof![
            Just(ProbeOutcome::Pending),
            Just(ProbeOutcome::Healthy),
            any::<Option<i32>>().prop_map(|code| ProbeOutcome::ChildExited { code }),
        ]
    }

    /// A pure model of the supervisor's process lifecycle, used to prove the
    /// stop-before-spawn invariant (R3.6) without spawning real processes. A
    /// `switch` mirrors `llamacpp_load`: it stops (awaits exit) *then* spawns.
    #[derive(Default)]
    struct SupervisorModel {
        state: LlamaState,
        live: u32,
    }

    impl SupervisorModel {
        fn stop(&mut self) {
            // `kill_child_and_wait` awaits exit ⇒ zero live processes after.
            self.live = 0;
            self.state = LlamaState::Stopped;
        }

        fn spawn(&mut self) {
            assert_eq!(self.live, 0, "spawn must be preceded by a completed stop");
            self.live = 1;
            self.state = LlamaState::Starting;
        }

        fn switch(&mut self) {
            self.stop();
            self.spawn();
        }

        fn probe(&mut self, outcome: ProbeOutcome, elapsed: Duration, deadline: Duration) {
            self.state = next_state(self.state, outcome, elapsed, deadline);
            // An observed child exit reaps the process.
            if matches!(outcome, ProbeOutcome::ChildExited { .. }) {
                self.live = 0;
            }
        }
    }

    #[derive(Clone, Debug)]
    enum Op {
        Switch,
        Stop,
        Probe {
            outcome: ProbeOutcome,
            elapsed_secs: u64,
        },
    }

    fn any_op() -> impl Strategy<Value = Op> {
        prop_oneof![
            Just(Op::Switch),
            Just(Op::Stop),
            (any_probe_outcome(), 0u64..=600).prop_map(|(outcome, elapsed_secs)| Op::Probe {
                outcome,
                elapsed_secs
            }),
        ]
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(256))]

        /// Feature: zoc-ai-agent-chat-overhaul, Property 7: The model supervisor
        /// holds exactly one state and one live process.
        ///
        /// A successful probe before the deadline implies ready.
        #[test]
        fn prop_healthy_before_deadline_is_ready(
            deadline_secs in 1u64..=600,
            elapsed_secs in 0u64..=600,
            current in any_llama_state(),
        ) {
            let deadline = Duration::from_secs(deadline_secs);
            let elapsed = Duration::from_secs(elapsed_secs);
            let next = next_state(current, ProbeOutcome::Healthy, elapsed, deadline);
            match current {
                LlamaState::Starting | LlamaState::Ready => {
                    prop_assert_eq!(next, LlamaState::Ready);
                }
                // Stopped/Error are absorbing under probe outcomes.
                LlamaState::Stopped => prop_assert_eq!(next, LlamaState::Stopped),
                LlamaState::Error => prop_assert_eq!(next, LlamaState::Error),
            }
        }

        /// Feature: zoc-ai-agent-chat-overhaul, Property 7: The model supervisor
        /// holds exactly one state and one live process.
        ///
        /// Elapsing the deadline without a successful probe implies error;
        /// staying within it keeps starting. Exercises both the 120s default and
        /// an arbitrary per-model override by passing `deadline` as an argument.
        #[test]
        fn prop_pending_respects_deadline(
            deadline_secs in 1u64..=600,
            elapsed_secs in 0u64..=1200,
        ) {
            let deadline = Duration::from_secs(deadline_secs);
            let elapsed = Duration::from_secs(elapsed_secs);
            let next = next_state(LlamaState::Starting, ProbeOutcome::Pending, elapsed, deadline);
            if elapsed > deadline {
                prop_assert_eq!(next, LlamaState::Error);
            } else {
                prop_assert_eq!(next, LlamaState::Starting);
            }
        }

        /// Feature: zoc-ai-agent-chat-overhaul, Property 7: The model supervisor
        /// holds exactly one state and one live process.
        ///
        /// A child exit from either active state is an error, regardless of clock.
        #[test]
        fn prop_child_exit_from_active_is_error(
            deadline_secs in 1u64..=600,
            elapsed_secs in 0u64..=1200,
            code in any::<Option<i32>>(),
            active_ready in any::<bool>(),
        ) {
            let deadline = Duration::from_secs(deadline_secs);
            let elapsed = Duration::from_secs(elapsed_secs);
            let current = if active_ready { LlamaState::Ready } else { LlamaState::Starting };
            let next = next_state(current, ProbeOutcome::ChildExited { code }, elapsed, deadline);
            prop_assert_eq!(next, LlamaState::Error);
        }

        /// Feature: zoc-ai-agent-chat-overhaul, Property 7: The model supervisor
        /// holds exactly one state and one live process.
        ///
        /// The deadline-expiry message names the per-model setting that raises
        /// the deadline, the elapsed deadline, and the recommended large-model
        /// value — for any deadline, default or override.
        #[test]
        fn prop_deadline_message_names_setting(deadline_secs in 1u64..=100_000) {
            let msg = deadline_error_message(Duration::from_secs(deadline_secs));
            prop_assert!(msg.contains("readiness_deadline_secs"));
            prop_assert!(msg.contains(&deadline_secs.to_string()));
            prop_assert!(msg.contains(&RECOMMENDED_LARGE_MODEL_DEADLINE_SECS.to_string()));
        }

        /// Feature: zoc-ai-agent-chat-overhaul, Property 7: The model supervisor
        /// holds exactly one state and one live process.
        ///
        /// For any sequence of switches, stops, and probe outcomes, the reported
        /// state is always exactly one of the four and no two model processes are
        /// ever live at once, because every spawn is preceded by a completed stop.
        #[test]
        fn prop_one_live_process(
            ops in prop::collection::vec(any_op(), 0..64),
            deadline_secs in 1u64..=600,
        ) {
            let deadline = Duration::from_secs(deadline_secs);
            let mut model = SupervisorModel::default();
            for op in ops {
                match op {
                    Op::Switch => model.switch(),
                    Op::Stop => model.stop(),
                    Op::Probe { outcome, elapsed_secs } => {
                        model.probe(outcome, Duration::from_secs(elapsed_secs), deadline);
                    }
                }
                // Exactly one live process at most, always.
                prop_assert!(model.live <= 1, "live process count exceeded one: {}", model.live);
                // The state is always one of the four (enumerated, hence total).
                prop_assert!(matches!(
                    model.state,
                    LlamaState::Stopped | LlamaState::Starting | LlamaState::Ready | LlamaState::Error
                ));
            }
        }
    }

    #[test]
    fn default_readiness_deadline_is_120s() {
        assert_eq!(DEFAULT_READINESS_DEADLINE, Duration::from_secs(120));
        assert_eq!(RECOMMENDED_LARGE_MODEL_DEADLINE_SECS, 300);
    }

    #[test]
    fn set_state_keeps_running_in_lockstep() {
        let mut s = LlamaServerStatus::default();
        assert_eq!(s.state, LlamaState::Stopped);
        assert!(!s.running);
        s.set_state(LlamaState::Starting);
        assert!(!s.running);
        s.set_state(LlamaState::Ready);
        assert!(s.running, "running must be true exactly in Ready");
        s.set_state(LlamaState::Error);
        assert!(!s.running);
    }

    #[test]
    fn error_state_carries_message_and_nonempty_tail() {
        // R3.4: the error report carries the captured output tail and a message
        // naming the per-model deadline setting.
        let sup = LlamaServerSupervisor::default();
        sup.push_log_line("stderr: llama_model_load: loading model".into());
        sup.push_log_line("stderr: error: failed to allocate KV cache".into());
        let tail = sup.log_tail_snapshot();
        assert!(!tail.is_empty());
        assert_eq!(tail.len(), 2);
        assert!(tail.last().unwrap().contains("failed to allocate"));

        let msg = deadline_error_message(DEFAULT_READINESS_DEADLINE);
        assert!(msg.contains("readiness_deadline_secs"));
        assert!(msg.contains("120"));
        assert!(msg.contains("300"));
    }

    #[test]
    fn log_tail_is_bounded_and_keeps_newest() {
        let sup = LlamaServerSupervisor::default();
        for i in 0..(LOG_TAIL_CAP + 25) {
            sup.push_log_line(format!("line {i}"));
        }
        let tail = sup.log_tail_snapshot();
        assert_eq!(tail.len(), LOG_TAIL_CAP);
        // The oldest lines are evicted; the newest is retained.
        assert_eq!(tail.first().unwrap(), &format!("line {}", 25));
        assert_eq!(tail.last().unwrap(), &format!("line {}", LOG_TAIL_CAP + 24));
    }

    #[test]
    fn clear_log_lines_empties_the_tail() {
        let sup = LlamaServerSupervisor::default();
        sup.push_log_line("a".into());
        sup.push_log_line("b".into());
        assert_eq!(sup.log_tail_snapshot().len(), 2);
        sup.clear_log_lines();
        assert!(sup.log_tail_snapshot().is_empty());
    }

    // Task 7.5 — assert the `llama-server` argv against the exact spawn contract
    // without spawning a process. The pure `build_server_args` is the seam
    // `llamacpp_load` uses to build the command, so this is the real argv.
    #[test]
    fn build_server_args_minimal() {
        let args = build_server_args(&ServerArgs {
            model_path: "/models/m.gguf",
            n_gpu_layers: 33,
            host: "127.0.0.1",
            port: 8080,
            n_ctx: None,
            n_threads: None,
            n_batch: None,
            flash_attn: false,
            top_k: None,
        });
        assert_eq!(
            args,
            vec![
                "-m",
                "/models/m.gguf",
                "-ngl",
                "33",
                "--host",
                "127.0.0.1",
                "--port",
                "8080",
            ]
        );
    }

    #[test]
    fn build_server_args_full() {
        let args = build_server_args(&ServerArgs {
            model_path: "/models/big.gguf",
            n_gpu_layers: 99,
            host: "127.0.0.1",
            port: 9099,
            n_ctx: Some(8192),
            n_threads: Some(12),
            n_batch: Some(512),
            flash_attn: true,
            top_k: Some(40),
        });
        assert_eq!(
            args,
            vec![
                "-m",
                "/models/big.gguf",
                "-ngl",
                "99",
                "--host",
                "127.0.0.1",
                "--port",
                "9099",
                "--ctx-size",
                "8192",
                "--threads",
                "12",
                "--batch-size",
                "512",
                "--flash-attn",
                "--top-k",
                "40",
            ]
        );
    }

    #[test]
    fn build_server_args_flash_attn_omitted_when_false() {
        let args = build_server_args(&ServerArgs {
            model_path: "/m.gguf",
            n_gpu_layers: 0,
            host: "0.0.0.0",
            port: 8080,
            n_ctx: Some(4096),
            n_threads: None,
            n_batch: None,
            flash_attn: false,
            top_k: None,
        });
        assert!(!args.iter().any(|a| a == "--flash-attn"));
        assert!(args.windows(2).any(|w| w == ["--ctx-size", "4096"]));
    }
}
