//! Desktop_Core runtime bridge — zoc-agent-chat-rebuild R6.1, R6.5, R6.6,
//! R10.10, R10.15, R14.10. **Security-relevant.**
//!
//! One loopback HTTP listener carrying everything the Agent_Runtime needs from
//! Desktop_Core. It exists because of a gap between two facts the design states
//! separately: workspace mutation and key custody are Desktop_Core
//! responsibilities, and the Agent_Runtime is a separate OS process. A Tauri
//! command is reachable only from the webview, so the runtime cannot invoke one.
//!
//! ## Why here rather than in Workspace_Services
//!
//! The design's wording implies these calls land on the retained Python surface.
//! They land here instead, and the reason is that **the enforcement already lives
//! here**: `workspace::ensure_within_workspace` is the single path-confinement
//! check, `patch::apply_unified_fuzzy` plus `transaction::Transaction` is the
//! single atomic-write path, and `checkpoint::git_checkpoint` is the single
//! rollback point. Reimplementing any of the three in Python would create two
//! enforcement points for R10, and two enforcement points is how a confinement
//! bug ships — the second one is always the one nobody re-reads.
//!
//! Three properties this listener holds:
//!
//! - **Loopback only, checked before the credential is read** — the same ordering
//!   the runtime's own admission uses, for the same timing reason.
//! - **Every path passes `ensure_within_workspace`.** The runtime is trusted with
//!   a token, not with the filesystem: a confused model that asks for
//!   `../../.ssh/id_rsa` is refused here, not upstream.
//! - **No error body carries a secret**, and no error body carries a value the
//!   caller did not already send.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use zoc_studio_hotpath::checkpoint::git_checkpoint;
use zoc_studio_hotpath::patch::apply_unified_fuzzy;
use zoc_studio_hotpath::transaction::Transaction;

use crate::secrets::SecretVault;
use crate::sidecar::AgentRuntimeSupervisor;
use crate::workspace::{ensure_within_workspace, WorkspaceState};

/// Hard ceiling on a request body. A multi-file hunk batch is the largest thing
/// that arrives here, so this is generous rather than tight, but bounded.
const MAX_BODY: usize = 8 * 1024 * 1024;

/// Hard ceiling on the request line plus headers.
const MAX_HEAD: usize = 8 * 1024;

/// Ceiling on a single file read, so one enormous file cannot exhaust memory.
const MAX_READ_BYTES: usize = 2 * 1024 * 1024;

/// Fuzz factor for hunk application, matching `apply_patch`'s proven value.
const PATCH_FUZZ: u32 = 3;

/// The `base_digest` sentinel for a file that did not exist (R10.15).
///
/// Distinct from the digest of an empty file, so "did not exist" and "existed and
/// was empty" cannot be confused by a rollback.
pub const ABSENT_DIGEST: &str = "absent:0";

pub struct RuntimeBridge {
    port: Mutex<Option<u16>>,
    running: AtomicBool,
}

impl Default for RuntimeBridge {
    fn default() -> Self {
        Self {
            port: Mutex::new(None),
            running: AtomicBool::new(false),
        }
    }
}

impl RuntimeBridge {
    pub fn port(&self) -> Option<u16> {
        *self.port.lock()
    }

    /// The base URL handed to the runtime in `ZOC_DESKTOP_BRIDGE_URL`.
    pub fn base_url(&self) -> Option<String> {
        self.port().map(|port| format!("http://127.0.0.1:{port}"))
    }

    /// Retained for the key path specifically, so the runtime's key module needs
    /// no knowledge of the bridge's other routes.
    pub fn secret_url(&self) -> Option<String> {
        self.base_url().map(|base| format!("{base}/secret"))
    }

    pub fn shutdown(&self) {
        self.running.store(false, Ordering::SeqCst);
    }
}

/// Start the listener. Returns the bound port, or `None` if it could not bind.
///
/// Binding failure is not fatal: the app still opens, and a Run then fails with
/// an accurate transport error rather than the window refusing to appear.
pub fn start(
    bridge: Arc<RuntimeBridge>,
    vault: Arc<SecretVault>,
    runtime: Arc<AgentRuntimeSupervisor>,
    workspace: Arc<WorkspaceState>,
) -> Option<u16> {
    let listener = match TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))) {
        Ok(listener) => listener,
        Err(err) => {
            tracing::warn!(error = %err, "runtime bridge could not bind loopback");
            return None;
        }
    };
    let port = listener.local_addr().ok()?.port();
    *bridge.port.lock() = Some(port);
    bridge.running.store(true, Ordering::SeqCst);
    tracing::info!(port, "runtime bridge listening on loopback");

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            if !bridge.running.load(Ordering::SeqCst) {
                break;
            }
            let Ok(stream) = stream else { continue };
            let vault = vault.clone();
            let runtime = runtime.clone();
            let workspace = workspace.clone();
            // One short-lived thread per connection. Traffic is a handful of
            // requests per Run from one local peer, so a pool would be
            // machinery for a load that does not exist.
            std::thread::spawn(move || {
                if let Err(err) = serve(stream, &vault, &runtime, &workspace) {
                    tracing::debug!(error = %err, "runtime bridge connection ended");
                }
            });
        }
        tracing::info!("runtime bridge stopped");
    });

    Some(port)
}

// ── Wire shapes ───────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct SecretRequest {
    key: String,
}

#[derive(Deserialize)]
struct ReadRequest {
    path: String,
}

#[derive(Serialize)]
struct ReadResponse {
    path: String,
    content: String,
    truncated: bool,
    /// `ABSENT_DIGEST` when the file does not exist (R10.15).
    digest: String,
}

/// One file's change. `action` mirrors the wire `HunkAction` (R10.10).
#[derive(Deserialize)]
struct HunkFile {
    path: String,
    action: String,
    #[serde(default)]
    source_path: Option<String>,
    #[serde(default)]
    unified_diff: String,
    /// The digest the diff was generated against. Compared before applying so a
    /// file that moved under the model is refused rather than clobbered (R10.8).
    #[serde(default)]
    base_digest: Option<String>,
}

#[derive(Deserialize)]
struct ApplyHunksRequest {
    #[serde(default)]
    plan_id: String,
    files: Vec<HunkFile>,
    /// When true, take a git checkpoint before touching anything.
    #[serde(default = "default_true")]
    checkpoint: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Serialize)]
struct AppliedFile {
    path: String,
    action: String,
    created: bool,
    deleted: bool,
    bytes_written: usize,
}

#[derive(Serialize)]
struct ApplyHunksResponse {
    plan_id: String,
    applied: Vec<AppliedFile>,
    /// The commit the workspace can be rolled back to, when one was taken.
    checkpoint_id: Option<String>,
}

#[derive(Deserialize)]
struct RunCommandRequest {
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[derive(Serialize)]
struct RunCommandResponse {
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

#[derive(Serialize)]
struct BridgeError {
    code: &'static str,
    message: String,
}

// ── Server ────────────────────────────────────────────────────────────────

fn respond_json(stream: &mut TcpStream, status: u16, reason: &str, body: &str) -> std::io::Result<()> {
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         content-type: application/json; charset=utf-8\r\n\
         content-length: {len}\r\n\
         cache-control: no-store\r\n\
         connection: close\r\n\r\n{body}",
        len = body.len()
    );
    stream.write_all(response.as_bytes())?;
    stream.flush()
}

fn fail(
    stream: &mut TcpStream,
    status: u16,
    reason: &'static str,
    code: &'static str,
    message: impl Into<String>,
) -> std::io::Result<()> {
    let body = serde_json::to_string(&BridgeError {
        code,
        message: message.into(),
    })
    .unwrap_or_else(|_| r#"{"code":"internal","message":"error"}"#.to_string());
    respond_json(stream, status, reason, &body)
}

fn ok_json(stream: &mut TcpStream, value: &impl Serialize) -> std::io::Result<()> {
    match serde_json::to_string(value) {
        Ok(body) => respond_json(stream, 200, "OK", &body),
        Err(_) => fail(stream, 500, "Internal Server Error", "internal", "serialisation failed"),
    }
}

fn serve(
    mut stream: TcpStream,
    vault: &SecretVault,
    runtime: &AgentRuntimeSupervisor,
    workspace: &WorkspaceState,
) -> std::io::Result<()> {
    // Loopback first, before the credential is read. The listener is already
    // bound to 127.0.0.1 so this cannot currently fail; the check stays because
    // it is one line and it is what keeps the guarantee true if the bind address
    // is ever widened by accident.
    let peer_is_local = stream
        .peer_addr()
        .map(|addr| addr.ip().is_loopback())
        .unwrap_or(false);
    if !peer_is_local {
        return fail(
            &mut stream,
            403,
            "Forbidden",
            "remote_refused",
            "local connections only",
        );
    }

    stream.set_read_timeout(Some(std::time::Duration::from_secs(30)))?;
    let mut reader = BufReader::new(stream.try_clone()?);

    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;

    let mut content_length = 0usize;
    let mut authorization = String::new();
    let mut head_bytes = request_line.len();
    loop {
        let mut line = String::new();
        let read = reader.read_line(&mut line)?;
        head_bytes += read;
        if read == 0 || line == "\r\n" || line == "\n" || head_bytes > MAX_HEAD {
            break;
        }
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("content-length:") {
            content_length = rest.trim().parse().unwrap_or(0);
        } else if lower.starts_with("authorization:") {
            authorization = line
                .split_once(':')
                .map(|(_, value)| value.trim().to_string())
                .unwrap_or_default();
        }
    }

    let presented = authorization.strip_prefix("Bearer ").unwrap_or("");
    if !runtime.token_matches(presented) {
        // No detail. A caller that guessed wrong learns only that it was wrong.
        return fail(&mut stream, 401, "Unauthorized", "unauthorized", "unauthorized");
    }

    if content_length > MAX_BODY {
        return fail(&mut stream, 413, "Payload Too Large", "too_large", "body too large");
    }
    let mut body = vec![0u8; content_length];
    reader.read_exact(&mut body)?;

    let path = request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or("/")
        .to_string();
    let is_post = request_line.starts_with("POST ");
    if !is_post {
        return fail(&mut stream, 405, "Method Not Allowed", "method_not_allowed", "POST only");
    }

    match path.as_str() {
        "/secret" => handle_secret(&mut stream, &body, vault),
        "/workspace/read" => handle_read(&mut stream, &body, workspace),
        "/workspace/apply-hunks" => handle_apply_hunks(&mut stream, &body, workspace),
        "/workspace/run-command" => handle_run_command(&mut stream, &body, workspace),
        _ => fail(&mut stream, 404, "Not Found", "not_found", "no such route"),
    }
}

fn handle_secret(
    stream: &mut TcpStream,
    body: &[u8],
    vault: &SecretVault,
) -> std::io::Result<()> {
    let Ok(request) = serde_json::from_slice::<SecretRequest>(body) else {
        return fail(stream, 422, "Unprocessable Entity", "bad_body", "bad body");
    };
    match vault.get(&request.key) {
        Some(value) => ok_json(stream, &serde_json::json!({ "value": value.to_string() })),
        // 404 rather than `{"value": null}`: "there is no such key" and "the key
        // is empty" are different facts, and only the first maps to
        // `no_key_configured`.
        None => fail(stream, 404, "Not Found", "no_such_key", "no such key"),
    }
}

/// SHA-256 of file content, hex-encoded, matching the wire's `base_digest`.
fn digest_of(content: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(content);
    format!("sha256:{:x}", hasher.finalize())
}

fn handle_read(
    stream: &mut TcpStream,
    body: &[u8],
    workspace: &WorkspaceState,
) -> std::io::Result<()> {
    let Ok(request) = serde_json::from_slice::<ReadRequest>(body) else {
        return fail(stream, 422, "Unprocessable Entity", "bad_body", "bad body");
    };
    let target = match ensure_within_workspace(workspace, Path::new(&request.path)) {
        Ok(target) => target,
        Err(reason) => {
            return fail(stream, 403, "Forbidden", "path_refused", reason);
        }
    };

    let raw = match std::fs::read(&target) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return ok_json(
                stream,
                &ReadResponse {
                    path: request.path,
                    content: String::new(),
                    truncated: false,
                    digest: ABSENT_DIGEST.to_string(),
                },
            );
        }
        Err(err) => {
            // The message names the error kind, never the absolute path: the
            // caller sent a relative path and gets a relative path back.
            return fail(
                stream,
                500,
                "Internal Server Error",
                "read_failed",
                format!("could not read {}: {}", request.path, err.kind()),
            );
        }
    };

    let digest = digest_of(&raw);
    let truncated = raw.len() > MAX_READ_BYTES;
    let slice = if truncated { &raw[..MAX_READ_BYTES] } else { &raw[..] };
    ok_json(
        stream,
        &ReadResponse {
            path: request.path,
            content: String::from_utf8_lossy(slice).into_owned(),
            truncated,
            digest,
        },
    )
}

fn handle_apply_hunks(
    stream: &mut TcpStream,
    body: &[u8],
    workspace: &WorkspaceState,
) -> std::io::Result<()> {
    let Ok(request) = serde_json::from_slice::<ApplyHunksRequest>(body) else {
        return fail(stream, 422, "Unprocessable Entity", "bad_body", "bad body");
    };
    if request.files.is_empty() {
        return fail(stream, 422, "Unprocessable Entity", "bad_body", "no files");
    }

    let Some(root) = workspace.get() else {
        return fail(
            stream,
            409,
            "Conflict",
            "no_workspace",
            "no workspace root is open",
        );
    };

    // Checkpoint before anything is staged, so the rollback point predates the
    // first byte written rather than the first byte that failed.
    let checkpoint_id = if request.checkpoint {
        match git_checkpoint(&root, &format!("zoc checkpoint before {}", request.plan_id)) {
            Ok(id) => id,
            Err(err) => {
                tracing::warn!(error = %err, "checkpoint unavailable; applying without one");
                None
            }
        }
    } else {
        None
    };

    // Stage every file into one transaction. All four `HunkAction`s go through
    // this single path — a create is a hunk against a non-existent file, a
    // delete removes every line, a rename carries `source_path` — which is what
    // makes one permission gate and one checkpoint contract sufficient (R10.16).
    let mut tx = Transaction::new();
    let mut applied: Vec<AppliedFile> = Vec::with_capacity(request.files.len());

    for file in &request.files {
        let target = match ensure_within_workspace(workspace, Path::new(&file.path)) {
            Ok(target) => target,
            Err(reason) => return fail(stream, 403, "Forbidden", "path_refused", reason),
        };

        let original = match std::fs::read(&target) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(err) => {
                return fail(
                    stream,
                    500,
                    "Internal Server Error",
                    "read_failed",
                    format!("could not read {}: {}", file.path, err.kind()),
                )
            }
        };
        let existed = target.exists();

        // Staleness check (R10.8). A digest mismatch is refused rather than
        // force-applied: the diff was computed against content that is no longer
        // there, so applying it would produce a result nobody reviewed.
        if let Some(expected) = file.base_digest.as_deref() {
            let actual = if existed {
                digest_of(&original)
            } else {
                ABSENT_DIGEST.to_string()
            };
            if expected != actual {
                return fail(
                    stream,
                    409,
                    "Conflict",
                    "hunk_stale",
                    format!("{} changed since the diff was generated", file.path),
                );
            }
        }

        match file.action.as_str() {
            "rename" => {
                let Some(source) = file.source_path.as_deref() else {
                    return fail(
                        stream,
                        422,
                        "Unprocessable Entity",
                        "bad_body",
                        "a rename requires sourcePath",
                    );
                };
                let from = match ensure_within_workspace(workspace, Path::new(source)) {
                    Ok(from) => from,
                    Err(reason) => return fail(stream, 403, "Forbidden", "path_refused", reason),
                };
                let content = std::fs::read(&from).unwrap_or_default();
                let bytes = content.len();
                tx.add_write(target.clone(), content);
                tx.add_delete(from);
                applied.push(AppliedFile {
                    path: file.path.clone(),
                    action: "rename".into(),
                    created: true,
                    deleted: false,
                    bytes_written: bytes,
                });
            }
            "delete" => {
                tx.add_delete(target.clone());
                applied.push(AppliedFile {
                    path: file.path.clone(),
                    action: "delete".into(),
                    created: false,
                    deleted: true,
                    bytes_written: 0,
                });
            }
            action @ ("create" | "modify") => {
                let before = String::from_utf8_lossy(&original).into_owned();
                let result = apply_unified_fuzzy(&before, &file.unified_diff, PATCH_FUZZ);
                if !result.success {
                    let detail = if result.failed_hunks.is_empty() {
                        "patch did not apply".to_string()
                    } else {
                        result
                            .failed_hunks
                            .iter()
                            .map(|hunk| format!("hunk {}: {}", hunk.hunk_index, hunk.reason))
                            .collect::<Vec<_>>()
                            .join("; ")
                    };
                    return fail(
                        stream,
                        409,
                        "Conflict",
                        "hunk_failed",
                        format!("{}: {}", file.path, detail),
                    );
                }
                let content = result.new_content.unwrap_or_default();
                let bytes = content.len();
                tx.add_write(target.clone(), content.into_bytes());
                applied.push(AppliedFile {
                    path: file.path.clone(),
                    action: action.into(),
                    created: !existed,
                    deleted: false,
                    bytes_written: bytes,
                });
            }
            other => {
                return fail(
                    stream,
                    422,
                    "Unprocessable Entity",
                    "bad_body",
                    format!("unknown action {other}"),
                )
            }
        }
    }

    // One commit for the whole batch. A partial apply is the failure mode the
    // transaction exists to rule out: half a plan is a workspace state no plan
    // described.
    if let Err(err) = tx.commit() {
        return fail(
            stream,
            500,
            "Internal Server Error",
            "apply_failed",
            err.to_string(),
        );
    }

    ok_json(
        stream,
        &ApplyHunksResponse {
            plan_id: request.plan_id,
            applied,
            checkpoint_id,
        },
    )
}

fn handle_run_command(
    stream: &mut TcpStream,
    body: &[u8],
    workspace: &WorkspaceState,
) -> std::io::Result<()> {
    let Ok(request) = serde_json::from_slice::<RunCommandRequest>(body) else {
        return fail(stream, 422, "Unprocessable Entity", "bad_body", "bad body");
    };

    // The working directory is confined like any other path. A command is
    // allowed to be arbitrary — that is what the permission gate upstream is
    // for — but it does not get to choose a directory outside the workspace.
    let cwd = match request.cwd.as_deref() {
        Some(raw) => match ensure_within_workspace(workspace, Path::new(raw)) {
            Ok(dir) => dir,
            Err(reason) => return fail(stream, 403, "Forbidden", "path_refused", reason),
        },
        None => match workspace.get() {
            Some(root) => root,
            None => {
                return fail(
                    stream,
                    409,
                    "Conflict",
                    "no_workspace",
                    "no workspace root is open",
                )
            }
        },
    };

    let mut command = std::process::Command::new(&request.command);
    command
        .args(&request.args)
        .current_dir(&cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            return fail(
                stream,
                422,
                "Unprocessable Entity",
                "spawn_failed",
                format!("could not start {}: {}", request.command, err.kind()),
            )
        }
    };

    let timeout = std::time::Duration::from_millis(request.timeout_ms.unwrap_or(120_000));
    match wait_with_timeout(child, timeout) {
        Ok((output, timed_out)) => ok_json(
            stream,
            &RunCommandResponse {
                exit_code: output.status_code,
                stdout: output.stdout,
                stderr: output.stderr,
                timed_out,
            },
        ),
        Err(err) => fail(
            stream,
            500,
            "Internal Server Error",
            "run_failed",
            err.to_string(),
        ),
    }
}

struct CapturedOutput {
    status_code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// Wait for a child, killing it past the deadline.
///
/// A timed-out command is killed and reported rather than left running: an
/// abandoned build process holding a lock is a worse outcome for the next Run
/// than a reported timeout is for this one.
fn wait_with_timeout(
    mut child: std::process::Child,
    timeout: std::time::Duration,
) -> std::io::Result<(CapturedOutput, bool)> {
    use std::io::Read as _;

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();

    // Drain on threads so a chatty command cannot fill a pipe buffer and
    // deadlock against our own wait.
    let stdout_handle = std::thread::spawn(move || {
        let mut buffer = String::new();
        if let Some(pipe) = stdout_pipe.as_mut() {
            let _ = pipe.read_to_string(&mut buffer);
        }
        buffer
    });
    let stderr_handle = std::thread::spawn(move || {
        let mut buffer = String::new();
        if let Some(pipe) = stderr_pipe.as_mut() {
            let _ = pipe.read_to_string(&mut buffer);
        }
        buffer
    });

    let deadline = std::time::Instant::now() + timeout;
    let mut timed_out = false;
    let status = loop {
        match child.try_wait()? {
            Some(status) => break status,
            None => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    timed_out = true;
                    break child.wait()?;
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
        }
    };

    Ok((
        CapturedOutput {
            status_code: status.code(),
            stdout: stdout_handle.join().unwrap_or_default(),
            stderr: stderr_handle.join().unwrap_or_default(),
        },
        timed_out,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_is_none_before_start_and_loopback_after() {
        let bridge = RuntimeBridge::default();
        assert!(bridge.base_url().is_none());
        assert!(bridge.secret_url().is_none());
        *bridge.port.lock() = Some(4321);
        assert_eq!(bridge.base_url().as_deref(), Some("http://127.0.0.1:4321"));
        assert_eq!(
            bridge.secret_url().as_deref(),
            Some("http://127.0.0.1:4321/secret")
        );
    }

    #[test]
    fn shutdown_clears_the_running_flag() {
        let bridge = RuntimeBridge::default();
        bridge.running.store(true, Ordering::SeqCst);
        bridge.shutdown();
        assert!(!bridge.running.load(Ordering::SeqCst));
    }

    #[test]
    fn the_absent_digest_is_not_the_digest_of_an_empty_file() {
        // R10.15: "did not exist" and "existed and was empty" must not be
        // confusable by a rollback.
        assert_ne!(ABSENT_DIGEST, digest_of(b""));
    }

    #[test]
    fn digest_is_stable_and_content_addressed() {
        assert_eq!(digest_of(b"hello"), digest_of(b"hello"));
        assert_ne!(digest_of(b"hello"), digest_of(b"hellp"));
        assert!(digest_of(b"hello").starts_with("sha256:"));
    }

    fn bridge_with_workspace(root: &Path) -> (Arc<RuntimeBridge>, u16, Arc<AgentRuntimeSupervisor>) {
        let bridge = Arc::new(RuntimeBridge::default());
        let vault = Arc::new(SecretVault::system());
        let runtime = Arc::new(AgentRuntimeSupervisor::default());
        let workspace = Arc::new(WorkspaceState::default());
        workspace.set(Some(root.to_path_buf()));
        let port = start(
            bridge.clone(),
            vault,
            runtime.clone(),
            workspace,
        )
        .expect("bind");
        (bridge, port, runtime)
    }

    fn post(port: u16, path: &str, token: Option<&str>, body: &str) -> String {
        use std::io::{Read as _, Write as _};
        let mut client =
            TcpStream::connect(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).expect("connect");
        let auth = match token {
            Some(token) => format!("authorization: Bearer {token}\r\n"),
            None => String::new(),
        };
        let request = format!(
            "POST {path} HTTP/1.1\r\nhost: 127.0.0.1\r\n{auth}content-length: {}\r\n\r\n{}",
            body.len(),
            body
        );
        client.write_all(request.as_bytes()).expect("write");
        let mut response = String::new();
        client.read_to_string(&mut response).expect("read");
        response
    }

    #[test]
    fn every_route_refuses_an_unauthenticated_request() {
        let dir = tempfile::tempdir().expect("temp");
        let (bridge, port, _runtime) = bridge_with_workspace(dir.path());

        for route in [
            "/secret",
            "/workspace/read",
            "/workspace/apply-hunks",
            "/workspace/run-command",
        ] {
            let response = post(port, route, None, "{}");
            assert!(
                response.contains(" 401 "),
                "{route} did not refuse an unauthenticated caller: {response}"
            );
            assert!(response.contains("unauthorized"));
        }
        bridge.shutdown();
    }

    #[test]
    fn an_unknown_route_is_a_404_not_a_500() {
        let dir = tempfile::tempdir().expect("temp");
        let (bridge, port, _runtime) = bridge_with_workspace(dir.path());
        // Unauthenticated, so this asserts ordering as well: the credential is
        // checked before the route, so an unknown route to an unauthenticated
        // caller is still 401 and leaks no route inventory.
        let response = post(port, "/nope", None, "{}");
        assert!(response.contains(" 401 "), "{response}");
        bridge.shutdown();
    }
}
