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
use tokio::time::sleep;

const HOST: &str = "127.0.0.1";
const PORT: u16 = 8080;
const RUNTIME_STATE_FILENAME: &str = "llamacpp-runtime.json";
// Cold loads of large quantised models (e.g. 70B at Q4_K_M) routinely
// take 60–120 s on a warm disk and 3–5 minutes from a cold cache. The
// previous 120 s was too aggressive — the supervisor killed the server
// while it was still mmap'ing weights. 5 minutes is generous enough to
// cover a 70B cold load while still bounding a real hang.
const LOAD_TIMEOUT: Duration = Duration::from_secs(300);
const HEALTH_INTERVAL: Duration = Duration::from_millis(500);
// Each /health probe gets its own short timeout so the polling loop
// stays responsive — the LOAD_TIMEOUT above bounds the *total* time we
// keep retrying, not any one HTTP call.
const HEALTH_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Default, Serialize)]
pub struct LlamaServerStatus {
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
    pub last_error: Option<String>,
}

pub struct LlamaServerSupervisor {
    status: Mutex<LlamaServerStatus>,
    child: Mutex<Option<Child>>,
    // Incremented on every load / unload so stdout-drain tasks for stale
    // children become no-ops and can't overwrite status for the current one.
    generation: AtomicU64,
}

impl Default for LlamaServerSupervisor {
    fn default() -> Self {
        Self {
            status: Mutex::new(LlamaServerStatus::default()),
            child: Mutex::new(None),
            generation: AtomicU64::new(0),
        }
    }
}

impl LlamaServerSupervisor {
    pub fn snapshot(&self) -> LlamaServerStatus {
        self.status.lock().clone()
    }

    /// Bumps the generation counter (invalidating any in-flight drain task)
    /// and SIGKILLs the child if one is running. Called by load (before
    /// spawning a replacement), unload, and the app-quit handler.
    pub fn kill_child(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(mut child) = self.child.lock().take() {
            // start_kill sends SIGKILL on Unix / TerminateProcess on Windows.
            // We don't await `wait()` because the spawn task captured the
            // child and we already moved it out — best-effort is fine.
            let _ = child.start_kill();
        }
    }

    /// App-quit hook. Resets everything so a relaunch starts clean.
    pub fn shutdown(&self) {
        self.kill_child();
        let status = LlamaServerStatus::default();
        *self.status.lock() = status.clone();
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
    let Ok(meta) = std::fs::metadata(path) else { return };
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
) -> Result<LlamaServerStatus, String> {
    validate_gguf(&path)?;

    let actual_host = host.as_deref().unwrap_or(HOST);
    let actual_port = port.unwrap_or(PORT);

    // Kill any previous instance and reset transient status fields.
    sup.kill_child();
    {
        let mut s = sup.status.lock();
        s.running = false;
        s.host = None;
        s.port = None;
        s.base_url = None;
        s.loaded_model_id = None;
        s.loaded_model_path = None;
        s.n_gpu_layers = None;
        s.n_ctx = None;
        s.n_threads = None;
        s.n_batch = None;
        s.temperature = None;
        s.top_p = None;
        s.top_k = None;
        s.repeat_penalty = None;
        s.max_tokens = None;
        s.flash_attn = None;
        s.last_error = None;
    }
    let reset = sup.snapshot();
    write_runtime_state(&reset);
    let _ = app.emit("llamacpp://status", reset);

    port_free(actual_host, actual_port)?;

    let ngl_str = n_gpu_layers.to_string();
    let port_str = actual_port.to_string();

    tracing::info!(
        target: "llama_server",
        path = %path,
        ngl = n_gpu_layers,
        port = actual_port,
        "spawning llama-server"
    );

    // Build the command with all runtime options
    let mut cmd = Command::new("llama-server");
    cmd.arg("-m").arg(&path)
        .arg("-ngl").arg(&ngl_str)
        .arg("--host").arg(actual_host)
        .arg("--port").arg(&port_str);

    let mut cmd_log = format!("spawn: llama-server -m {path} -ngl {ngl_str} --host {actual_host} --port {port_str}");

    if let Some(ctx) = n_ctx {
        cmd.arg("--ctx-size").arg(ctx.to_string());
        cmd_log.push_str(&format!(" --ctx-size {ctx}"));
    }
    if let Some(threads) = n_threads {
        cmd.arg("--threads").arg(threads.to_string());
        cmd_log.push_str(&format!(" --threads {threads}"));
    }
    if let Some(batch) = n_batch {
        cmd.arg("--batch-size").arg(batch.to_string());
        cmd_log.push_str(&format!(" --batch-size {batch}"));
    }
    if flash_attn.unwrap_or(false) {
        cmd.arg("--flash-attn");
        cmd_log.push_str(" --flash-attn");
    }
    if let Some(top_k_value) = top_k {
        cmd.arg("--top-k").arg(top_k_value.to_string());
        cmd_log.push_str(&format!(" --top-k {top_k_value}"));
    }

    append_log(&cmd_log);

    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            let msg = format!(
                "failed to spawn llama-server: {e}. Make sure the `llama-server` binary from llama.cpp is on PATH."
            );
            sup.status.lock().last_error = Some(msg.clone());
            let snap = sup.snapshot();
            write_runtime_state(&snap);
            let _ = app.emit("llamacpp://status", snap);
            msg
        })?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Claim a new generation BEFORE handing the child to the mutex so the
    // drain tasks we're about to spawn capture the right gen.
    let my_gen = sup.generation.fetch_add(1, Ordering::SeqCst) + 1;
    *sup.child.lock() = Some(child);

    let app_for_drain = app.clone();
    let sup_for_drain = Arc::clone(&*sup);
    let drain_gen = my_gen;
    if let Some(out) = stdout {
        tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!(target: "llama_server::stdout", "{line}");
                append_log(&format!("stdout: {line}"));
            }
            // Stdout closed → process is exiting. If we're still the current
            // generation, flip running=false and surface a generic error.
            if sup_for_drain.generation.load(Ordering::SeqCst) == drain_gen {
                let mut s = sup_for_drain.status.lock();
                if s.running {
                    s.last_error =
                        Some("llama-server exited unexpectedly; see ~/.zoc-studio/logs/llama-server.log".into());
                }
                s.running = false;
                s.host = None;
                s.port = None;
                s.base_url = None;
                s.loaded_model_id = None;
                s.loaded_model_path = None;
                s.n_gpu_layers = None;
                s.n_ctx = None;
                s.n_threads = None;
                s.n_batch = None;
                s.temperature = None;
                s.top_p = None;
                s.top_k = None;
                s.repeat_penalty = None;
                s.max_tokens = None;
                s.flash_attn = None;
                drop(s);
                let snap = sup_for_drain.snapshot();
                write_runtime_state(&snap);
                let _ = app_for_drain.emit("llamacpp://status", snap);
            }
        });
    }
    if let Some(err) = stderr {
        tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!(target: "llama_server::stderr", "{line}");
                append_log(&format!("stderr: {line}"));
            }
        });
    }

    // Poll /health until the model is loaded or we time out / the child dies.
    let client = reqwest::Client::builder()
        .timeout(HEALTH_PROBE_TIMEOUT)
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let url = format!("http://{actual_host}:{actual_port}/health");
    let start_time = Instant::now();
    let deadline = start_time + LOAD_TIMEOUT;
    loop {
        if Instant::now() > deadline {
            sup.kill_child();
            let err = format!(
                "llama-server did not become healthy within {}s; check ~/.zoc-studio/logs/llama-server.log",
                LOAD_TIMEOUT.as_secs()
            );
            sup.status.lock().last_error = Some(err.clone());
            let snap = sup.snapshot();
            write_runtime_state(&snap);
            let _ = app.emit("llamacpp://status", snap);
            return Err(err);
        }
        // If the drain task already cleared running due to child exit, bail.
        if sup.child.lock().is_none() {
            // If the child exited very quickly (within 5s), it's likely a port
            // conflict or immediate startup failure. Provide a more specific error.
            let elapsed = start_time.elapsed();
            let err = if elapsed < Duration::from_secs(5) {
                format!(
                    "llama-server exited immediately after startup (likely port {} conflict or missing binary); check ~/.zoc-studio/logs/llama-server.log",
                    actual_port
                )
            } else {
                "llama-server exited during startup; see ~/.zoc-studio/logs/llama-server.log".to_string()
            };
            sup.status.lock().last_error = Some(err.clone());
            let snap = sup.snapshot();
            write_runtime_state(&snap);
            let _ = app.emit("llamacpp://status", snap);
            return Err(err);
        }
        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => break,
            _ => sleep(HEALTH_INTERVAL).await,
        }
    }

    {
        let mut s = sup.status.lock();
        s.running = true;
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
        s.last_error = None;
    }
    let snap = sup.snapshot();
    write_runtime_state(&snap);
    let _ = app.emit("llamacpp://status", snap.clone());
    Ok(snap)
}

#[tauri::command]
pub fn llamacpp_unload<R: Runtime>(
    app: AppHandle<R>,
    sup: tauri::State<'_, Arc<LlamaServerSupervisor>>,
) -> LlamaServerStatus {
    sup.kill_child();
    let status = LlamaServerStatus::default();
    *sup.status.lock() = status;
    let snap = sup.snapshot();
    write_runtime_state(&snap);
    let _ = app.emit("llamacpp://status", snap.clone());
    snap
}

#[tauri::command]
pub fn llamacpp_status(
    sup: tauri::State<'_, Arc<LlamaServerSupervisor>>,
) -> LlamaServerStatus {
    sup.snapshot()
}
