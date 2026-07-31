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
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use zoc_studio_hotpath::checkpoint::{
    git_checkpoint, CheckpointError, CheckpointStore, PlannedChange,
};
use zoc_studio_hotpath::patch::apply_unified_fuzzy;
use zoc_studio_hotpath::transaction::Transaction;

use crate::secrets::SecretVault;
use crate::sidecar::AgentRuntimeSupervisor;
use crate::workspace::{ensure_within_workspace, WorkspaceState};

/// Where apply checkpoints live: `~/.zoc-studio/checkpoints`.
///
/// Outside the workspace on purpose. A checkpoint holds pre-apply copies of the
/// user's files, and putting them under the workspace root would put them in
/// `git status`, in the index, and in the next plan's search results — and would
/// make a rollback of a plan that touched the checkpoint directory a possibility
/// nobody should have to reason about.
pub fn checkpoint_dir() -> PathBuf {
    dirs::home_dir()
        .map(|home| home.join(".zoc-studio").join("checkpoints"))
        .unwrap_or_else(|| PathBuf::from(".zoc-checkpoints"))
}

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
///
/// The checkpoint store is passed in rather than resolved here, because `lib.rs` shares the same one
/// with the renderer's `workspace_rollback` command — a checkpoint an apply took through this bridge
/// has to be visible to the control that offers to undo it. It also lets 18.7's tests point the store
/// at a temp directory instead of the developer's `~/.zoc-studio`.
pub fn start(
    bridge: Arc<RuntimeBridge>,
    vault: Arc<SecretVault>,
    runtime: Arc<AgentRuntimeSupervisor>,
    workspace: Arc<WorkspaceState>,
    checkpoints: Arc<CheckpointStore>,
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
            let checkpoints = checkpoints.clone();
            // One short-lived thread per connection. Traffic is a handful of
            // requests per Run from one local peer, so a pool would be
            // machinery for a load that does not exist.
            std::thread::spawn(move || {
                if let Err(err) = serve(stream, &vault, &runtime, &workspace, &checkpoints) {
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
    /// The Run this apply belongs to. R10.5 requires the checkpoint to identify it, so it rides on
    /// the request rather than being inferred — the bridge has no notion of a Run otherwise.
    #[serde(default)]
    run_id: String,
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
struct RollbackRequest {
    checkpoint_id: String,
}

#[derive(Serialize)]
struct RollbackResponse {
    checkpoint_id: String,
    /// R10.7's figure: files restored. A rename is one file.
    restored_files: usize,
    /// Paths restored. A rename is two of them, so the two counts differ legitimately.
    restored_paths: usize,
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

fn respond_json(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    body: &str,
) -> std::io::Result<()> {
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
        Err(_) => fail(
            stream,
            500,
            "Internal Server Error",
            "internal",
            "serialisation failed",
        ),
    }
}

fn serve(
    mut stream: TcpStream,
    vault: &SecretVault,
    runtime: &AgentRuntimeSupervisor,
    workspace: &WorkspaceState,
    checkpoints: &CheckpointStore,
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
        return fail(
            &mut stream,
            401,
            "Unauthorized",
            "unauthorized",
            "unauthorized",
        );
    }

    if content_length > MAX_BODY {
        return fail(
            &mut stream,
            413,
            "Payload Too Large",
            "too_large",
            "body too large",
        );
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
        return fail(
            &mut stream,
            405,
            "Method Not Allowed",
            "method_not_allowed",
            "POST only",
        );
    }

    match path.as_str() {
        "/secret" => handle_secret(&mut stream, &body, vault),
        "/workspace/read" => handle_read(&mut stream, &body, workspace),
        "/workspace/apply-hunks" => handle_apply_hunks(&mut stream, &body, workspace, checkpoints),
        "/workspace/rollback" => handle_rollback(&mut stream, &body, checkpoints),
        "/workspace/run-command" => handle_run_command(&mut stream, &body, workspace),
        _ => fail(&mut stream, 404, "Not Found", "not_found", "no such route"),
    }
}

fn handle_secret(stream: &mut TcpStream, body: &[u8], vault: &SecretVault) -> std::io::Result<()> {
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
    let slice = if truncated {
        &raw[..MAX_READ_BYTES]
    } else {
        &raw[..]
    };
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
    checkpoints: &CheckpointStore,
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
    //
    // The git commit is a best-effort extra rather than the checkpoint: it does nothing in a
    // workspace that is not a repository and nothing when the tree is already clean, so an apply
    // that depended on it for rollback would be unrollbackable in both of those ordinary cases.
    // It is recorded inside the manifest, and the manifest's id is what the caller gets back.
    let git_commit = if request.checkpoint {
        match git_checkpoint(&root, &format!("zoc checkpoint before {}", request.plan_id)) {
            Ok(id) => id,
            Err(err) => {
                tracing::warn!(error = %err, "git checkpoint unavailable; the manifest still covers this apply");
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
    //
    // `planned` accumulates alongside, so the checkpoint below can be captured once, after every
    // file has been validated and before the first byte is written. Both halves matter: a refused
    // apply leaves no checkpoint, and a checkpoint taken after the write is not a rollback point.
    let mut tx = Transaction::new();
    let mut applied: Vec<AppliedFile> = Vec::with_capacity(request.files.len());
    let mut planned: Vec<PlannedChange> = Vec::with_capacity(request.files.len());

    // Every path this batch *writes*, resolved up front.
    //
    // Needed for one case the design names as legal and the transaction cannot express: a plan that
    // renames `a → b` and then creates a new `a`. The transaction applies every write before every
    // delete, so the rename's delete of `a` would remove the file the create had just written. A
    // source that some other change writes is therefore not deleted — it is being replaced, which is
    // what the plan said. A path that fails confinement is left out; the loop below refuses it.
    let write_targets: std::collections::HashSet<PathBuf> = request
        .files
        .iter()
        .filter(|file| file.action != "delete")
        .filter_map(|file| ensure_within_workspace(workspace, Path::new(&file.path)).ok())
        .collect();

    // What the batch has made of each path so far: `Some(bytes)` for a staged write, `None` for a
    // staged delete, absent for "still whatever is on disk".
    //
    // A batch is an ordered sequence of changes, and a later change applies to what the earlier ones
    // produced rather than to what is on disk. Without this, the rename-then-create case the design
    // names as legal patches the *pre-rename* content: creating a new `a` after moving `a → b` reads
    // the old `a`, applies the create's hunk to it, and writes both bodies into one file. Property 84
    // found exactly that.
    let mut staged: std::collections::HashMap<PathBuf, Option<Vec<u8>>> =
        std::collections::HashMap::new();

    for file in &request.files {
        let target = match ensure_within_workspace(workspace, Path::new(&file.path)) {
            Ok(target) => target,
            Err(reason) => return fail(stream, 403, "Forbidden", "path_refused", reason),
        };

        let (original, existed) = match staged.get(&target) {
            Some(Some(bytes)) => (bytes.clone(), true),
            Some(None) => (Vec::new(), false),
            None => match std::fs::read(&target) {
                Ok(bytes) => (bytes, true),
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => (Vec::new(), false),
                Err(err) => {
                    return fail(
                        stream,
                        500,
                        "Internal Server Error",
                        "read_failed",
                        format!("could not read {}: {}", file.path, err.kind()),
                    )
                }
            },
        };

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
                // The source's staged state, for the same reason the target reads one: a rename of a
                // file an earlier change in this batch modified must move the modified content.
                let content = match staged.get(&from) {
                    Some(Some(bytes)) => bytes.clone(),
                    Some(None) => Vec::new(),
                    None => std::fs::read(&from).unwrap_or_default(),
                };
                let bytes = content.len();
                staged.insert(target.clone(), Some(content.clone()));
                staged.insert(from.clone(), None);
                tx.add_write(target.clone(), content);
                // See `write_targets`: a source another change writes is replaced, not removed.
                if !write_targets.contains(&from) {
                    tx.add_delete(from);
                }
                // Both ends recorded, because a rename is one file across two paths and rollback
                // has to restore the source as well as remove the target (R10.15).
                planned.push(PlannedChange {
                    path: file.path.clone(),
                    action: "rename".into(),
                    source_path: Some(source.to_string()),
                });
                applied.push(AppliedFile {
                    path: file.path.clone(),
                    action: "rename".into(),
                    created: true,
                    deleted: false,
                    bytes_written: bytes,
                });
            }
            "delete" => {
                staged.insert(target.clone(), None);
                tx.add_delete(target.clone());
                planned.push(PlannedChange {
                    path: file.path.clone(),
                    action: "delete".into(),
                    source_path: None,
                });
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
                staged.insert(target.clone(), Some(content.clone().into_bytes()));
                tx.add_write(target.clone(), content.into_bytes());
                planned.push(PlannedChange {
                    path: file.path.clone(),
                    // The *observed* action, not the requested one: a `create` whose target turned
                    // out to exist is a modify as far as rollback is concerned, and recording the
                    // request would make rollback delete a file the user already had.
                    action: if existed {
                        "modify".into()
                    } else {
                        "create".into()
                    },
                    source_path: None,
                });
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

    // The checkpoint (R10.5, R10.15). Refused rather than skipped when it cannot be written: the
    // panel showed the user a review that promised the change was undoable, and writing files that
    // are not is the one outcome R10 exists to prevent. A caller that genuinely wants an
    // unrollbackable apply says so with `checkpoint: false`.
    let checkpoint_id = if request.checkpoint {
        match checkpoints.capture(
            &root,
            &request.run_id,
            &request.plan_id,
            git_commit,
            &planned,
        ) {
            Ok(checkpoint) => Some(checkpoint.id),
            Err(err) => {
                tracing::warn!(error = %err, "refusing to apply without a checkpoint");
                return fail(
                    stream,
                    500,
                    "Internal Server Error",
                    "checkpoint_failed",
                    "could not record a checkpoint, so nothing was applied",
                );
            }
        }
    } else {
        None
    };

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

/// Restore one checkpoint (R10.6, R10.7).
///
/// The workspace root is read from the manifest rather than from current state, deliberately: a
/// checkpoint belongs to the workspace it was taken in, and rolling it back into whatever directory
/// happens to be open now would write a stranger's files. `CheckpointStore` confines every recorded
/// path to that root, so a tampered manifest cannot reach outside it either.
fn handle_rollback(
    stream: &mut TcpStream,
    body: &[u8],
    checkpoints: &CheckpointStore,
) -> std::io::Result<()> {
    let Ok(request) = serde_json::from_slice::<RollbackRequest>(body) else {
        return fail(stream, 422, "Unprocessable Entity", "bad_body", "bad body");
    };

    match checkpoints.rollback(&request.checkpoint_id) {
        Ok(report) => ok_json(
            stream,
            &RollbackResponse {
                checkpoint_id: report.checkpoint_id,
                restored_files: report.restored_files,
                restored_paths: report.restored_paths,
            },
        ),
        Err(CheckpointError::NotFound(_)) => fail(
            stream,
            404,
            "Not Found",
            "no_such_checkpoint",
            "no such checkpoint",
        ),
        // A refusal rather than a partial restore, and a 409 rather than a 500: the checkpoint is
        // unusable and retrying will not change that, which is what tells the surface to offer
        // something other than a retry.
        Err(CheckpointError::Corrupt(detail)) => fail(
            stream,
            409,
            "Conflict",
            "checkpoint_unusable",
            format!("the checkpoint cannot be replayed: {detail}"),
        ),
        Err(err) => fail(
            stream,
            500,
            "Internal Server Error",
            "rollback_failed",
            err.to_string(),
        ),
    }
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

    fn bridge_with_workspace(
        root: &Path,
    ) -> (Arc<RuntimeBridge>, u16, Arc<AgentRuntimeSupervisor>) {
        let bridge = Arc::new(RuntimeBridge::default());
        let vault = Arc::new(SecretVault::system());
        let runtime = Arc::new(AgentRuntimeSupervisor::default());
        let workspace = Arc::new(WorkspaceState::default());
        workspace.set(Some(root.to_path_buf()));
        let store = Arc::new(CheckpointStore::new(
            std::env::temp_dir().join("zoc-bridge-test-checkpoints"),
        ));
        let port = start(bridge.clone(), vault, runtime.clone(), workspace, store).expect("bind");
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

    // ── Apply, checkpoint, and rollback (R10.4–R10.7, R10.10, R10.15; task 18.7) ──

    const TEST_TOKEN: &str = "test-launch-token";

    struct Fixture {
        bridge: Arc<RuntimeBridge>,
        port: u16,
        _guard: tempfile::TempDir,
        root: PathBuf,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.bridge.shutdown();
        }
    }

    /// A bridge over a real temp workspace, with a real checkpoint store beside it.
    ///
    /// The store is injected rather than resolved from `$HOME`, so a test run leaves nothing in the
    /// developer's `~/.zoc-studio` and two tests cannot see each other's checkpoints.
    fn fixture() -> Fixture {
        let guard = tempfile::tempdir().expect("temp");
        let root = guard.path().join("workspace");
        std::fs::create_dir_all(root.join("src")).expect("mkdir");

        let bridge = Arc::new(RuntimeBridge::default());
        let vault = Arc::new(SecretVault::system());
        let runtime = Arc::new(AgentRuntimeSupervisor::default());
        runtime.install_token_for_test(TEST_TOKEN);
        let workspace = Arc::new(WorkspaceState::default());
        workspace.set(Some(root.clone()));
        let store = Arc::new(CheckpointStore::new(guard.path().join("checkpoints")));

        let port = start(bridge.clone(), vault, runtime, workspace, store).expect("bind");

        Fixture {
            bridge,
            port,
            _guard: guard,
            root,
        }
    }

    fn body_of(response: &str) -> &str {
        response.split("\r\n\r\n").nth(1).unwrap_or("")
    }

    fn json_of(response: &str) -> serde_json::Value {
        serde_json::from_str(body_of(response)).unwrap_or(serde_json::Value::Null)
    }

    /// A unified diff replacing one line, in the form `apply_unified_fuzzy` parses.
    fn replace_line_diff(before: &str, after: &str, line: usize) -> String {
        format!("--- a/f\n+++ b/f\n@@ -{line},1 +{line},1 @@\n-{before}\n+{after}\n")
    }

    /// A unified diff creating a whole file.
    fn whole_file_diff(content: &str) -> String {
        let lines: Vec<&str> = content.lines().collect();
        let mut diff = format!("--- /dev/null\n+++ b/f\n@@ -0,0 +1,{} @@\n", lines.len());
        for line in lines {
            diff.push('+');
            diff.push_str(line);
            diff.push('\n');
        }
        diff
    }

    #[test]
    fn applies_all_four_actions_in_one_batch_and_rolls_them_all_back() {
        let fixture = fixture();
        let root = &fixture.root;

        // The pre-apply workspace. `modified`, `deleted`, and `original` exist; `created` does not.
        std::fs::write(root.join("src/modified.ts"), "keep\nbefore\ntail\n").expect("write");
        std::fs::write(root.join("src/deleted.ts"), "doomed content\n").expect("write");
        std::fs::write(root.join("src/original.ts"), "moving content\n").expect("write");

        let request = serde_json::json!({
            "plan_id": "plan_1",
            "run_id": "run_1",
            "checkpoint": true,
            "files": [
                {
                    "path": "src/created.ts",
                    "action": "create",
                    "unified_diff": whole_file_diff("brand new"),
                    "base_digest": ABSENT_DIGEST,
                },
                {
                    "path": "src/modified.ts",
                    "action": "modify",
                    "unified_diff": replace_line_diff("before", "after", 2),
                },
                { "path": "src/deleted.ts", "action": "delete" },
                {
                    "path": "src/renamed.ts",
                    "action": "rename",
                    "source_path": "src/original.ts",
                },
            ],
        });

        let response = post(
            fixture.port,
            "/workspace/apply-hunks",
            Some(TEST_TOKEN),
            &request.to_string(),
        );
        assert!(response.contains(" 200 "), "{response}");
        let applied = json_of(&response);
        let checkpoint_id = applied["checkpoint_id"]
            .as_str()
            .expect("a checkpoint id")
            .to_string();
        assert_eq!(applied["applied"].as_array().map(Vec::len), Some(4));

        // R10.10: all four actions landed.
        // No trailing newline, because the diff's one added line has none: the patcher writes back
        // exactly the lines the hunk names, which is what makes a whole-file create expressible as
        // hunks at all (R10.16).
        assert_eq!(
            std::fs::read_to_string(root.join("src/created.ts")).expect("created"),
            "brand new"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("src/modified.ts")).expect("modified"),
            "keep\nafter\ntail\n"
        );
        assert!(!root.join("src/deleted.ts").exists());
        assert_eq!(
            std::fs::read_to_string(root.join("src/renamed.ts")).expect("renamed"),
            "moving content\n"
        );
        assert!(!root.join("src/original.ts").exists());

        // R10.6, R10.7: one checkpoint covers the whole apply, and rollback restores all of it.
        let rolled = post(
            fixture.port,
            "/workspace/rollback",
            Some(TEST_TOKEN),
            &serde_json::json!({ "checkpoint_id": checkpoint_id }).to_string(),
        );
        assert!(rolled.contains(" 200 "), "{rolled}");
        let report = json_of(&rolled);
        assert_eq!(
            report["checkpoint_id"].as_str(),
            Some(checkpoint_id.as_str())
        );
        // Four files, five paths — the rename is one file across two of them.
        assert_eq!(report["restored_files"].as_u64(), Some(4));
        assert_eq!(report["restored_paths"].as_u64(), Some(5));

        assert!(
            !root.join("src/created.ts").exists(),
            "R10.15: rolling back a create removes the file"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("src/modified.ts")).expect("modified"),
            "keep\nbefore\ntail\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("src/deleted.ts")).expect("restored"),
            "doomed content\n",
            "R10.15: a deleted file comes back byte for byte"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("src/original.ts")).expect("returned"),
            "moving content\n",
            "R10.15: a renamed file returns to its source path"
        );
        assert!(!root.join("src/renamed.ts").exists());
    }

    #[test]
    fn a_stale_digest_refuses_the_whole_batch_and_writes_nothing() {
        let fixture = fixture();
        let root = &fixture.root;
        std::fs::write(root.join("src/fresh.ts"), "keep\nbefore\ntail\n").expect("write");
        std::fs::write(root.join("src/moved.ts"), "changed under us\n").expect("write");

        let request = serde_json::json!({
            "plan_id": "plan_1",
            "run_id": "run_1",
            "files": [
                {
                    "path": "src/fresh.ts",
                    "action": "modify",
                    "unified_diff": replace_line_diff("before", "after", 2),
                },
                {
                    "path": "src/moved.ts",
                    "action": "modify",
                    "unified_diff": replace_line_diff("old", "new", 1),
                    "base_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
                },
            ],
        });

        let response = post(
            fixture.port,
            "/workspace/apply-hunks",
            Some(TEST_TOKEN),
            &request.to_string(),
        );
        assert!(response.contains(" 409 "), "{response}");
        assert!(response.contains("hunk_stale"), "{response}");
        // R10.4: the batch is atomic, so the file that *was* applicable is untouched as well.
        assert_eq!(
            std::fs::read_to_string(root.join("src/fresh.ts")).expect("fresh"),
            "keep\nbefore\ntail\n"
        );
    }

    #[test]
    fn an_apply_that_cannot_be_checkpointed_writes_nothing() {
        let guard = tempfile::tempdir().expect("temp");
        let root = guard.path().join("workspace");
        std::fs::create_dir_all(&root).expect("mkdir");
        std::fs::write(root.join("a.ts"), "keep\nbefore\ntail\n").expect("write");

        // A store whose directory cannot be created, because its parent is a file. Standing in for
        // any unwritable store: the point is that the apply is refused rather than performed
        // without a rollback point.
        let blocker = guard.path().join("blocked");
        std::fs::write(&blocker, "not a directory").expect("write");
        let store = Arc::new(CheckpointStore::new(blocker.join("checkpoints")));

        let bridge = Arc::new(RuntimeBridge::default());
        let runtime = Arc::new(AgentRuntimeSupervisor::default());
        runtime.install_token_for_test(TEST_TOKEN);
        let workspace = Arc::new(WorkspaceState::default());
        workspace.set(Some(root.clone()));
        let port = start(
            bridge.clone(),
            Arc::new(SecretVault::system()),
            runtime,
            workspace,
            store,
        )
        .expect("bind");

        let request = serde_json::json!({
            "plan_id": "plan_1",
            "run_id": "run_1",
            "files": [{
                "path": "a.ts",
                "action": "modify",
                "unified_diff": replace_line_diff("before", "after", 2),
            }],
        });
        let response = post(
            port,
            "/workspace/apply-hunks",
            Some(TEST_TOKEN),
            &request.to_string(),
        );

        assert!(response.contains(" 500 "), "{response}");
        assert!(response.contains("checkpoint_failed"), "{response}");
        assert_eq!(
            std::fs::read_to_string(root.join("a.ts")).expect("unchanged"),
            "keep\nbefore\ntail\n",
            "an apply with no checkpoint must not have happened"
        );
        bridge.shutdown();
    }

    #[test]
    fn rollback_refuses_an_id_it_did_not_mint() {
        let fixture = fixture();
        for id in ["ckpt_nope", "../../etc", ""] {
            let response = post(
                fixture.port,
                "/workspace/rollback",
                Some(TEST_TOKEN),
                &serde_json::json!({ "checkpoint_id": id }).to_string(),
            );
            assert!(response.contains(" 404 "), "{id}: {response}");
            assert!(response.contains("no_such_checkpoint"), "{id}: {response}");
        }
    }

    #[test]
    fn an_opted_out_apply_reports_no_checkpoint_rather_than_failing() {
        let fixture = fixture();
        std::fs::write(fixture.root.join("src/a.ts"), "keep\nbefore\ntail\n").expect("write");

        let request = serde_json::json!({
            "plan_id": "plan_1",
            "run_id": "run_1",
            "checkpoint": false,
            "files": [{
                "path": "src/a.ts",
                "action": "modify",
                "unified_diff": replace_line_diff("before", "after", 2),
            }],
        });
        let response = post(
            fixture.port,
            "/workspace/apply-hunks",
            Some(TEST_TOKEN),
            &request.to_string(),
        );

        assert!(response.contains(" 200 "), "{response}");
        // `null`, which the receipt renders as "this cannot be rolled back here" rather than as a
        // rollback control that would fail when pressed.
        assert!(json_of(&response)["checkpoint_id"].is_null(), "{response}");
    }

    // ── Property 84: the four file actions round-trip through apply and rollback ──
    //
    // *For any* plan of up to eight files over the four actions, applying it and then rolling the
    // checkpoint back leaves the workspace byte-identical — content and mode — to what it was before
    // the apply.
    //
    // ## Why this runs here rather than in the Agent_Runtime's suite
    //
    // Task 18.9 places it in the runtime's suite, on the grounds that apply-and-rollback is a
    // Workspace_Services contract driven by the runtime's tool. The implementation of that contract
    // is this file: a Rust TCP listener inside the desktop crate, started by the Tauri app. Driving
    // it from Vitest would mean either shipping a second apply implementation for the test to talk to
    // — which is exactly the two-enforcement-points mistake this module's header refuses — or
    // building a harness that launches the desktop binary. The property is about the inverse of two
    // functions in this crate, so it is asserted against them, over the real HTTP surface the runtime
    // uses. `workspace-client.ts`'s own tests cover the request shaping on the other side.

    #[derive(Debug, Clone, Copy)]
    enum GeneratedAction {
        Create,
        Modify,
        Delete,
        Rename,
        /// A rename whose source is then re-created by a second change in the same batch — the
        /// collision the design names as legal, and the one the transaction's write-before-delete
        /// ordering gets wrong without `write_targets`.
        RenameThenCreate,
    }

    fn generated_action() -> impl proptest::strategy::Strategy<Value = GeneratedAction> {
        use proptest::prelude::Just;
        proptest::prop_oneof![
            Just(GeneratedAction::Create),
            Just(GeneratedAction::Modify),
            Just(GeneratedAction::Delete),
            Just(GeneratedAction::Rename),
            Just(GeneratedAction::RenameThenCreate),
        ]
    }

    /// Every file under `root`, with its bytes and mode. The comparison unit for the property.
    fn snapshot(root: &Path) -> std::collections::BTreeMap<PathBuf, (Vec<u8>, Option<u32>)> {
        fn walk(
            dir: &Path,
            root: &Path,
            into: &mut std::collections::BTreeMap<PathBuf, (Vec<u8>, Option<u32>)>,
        ) {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, root, into);
                    continue;
                }
                let Ok(bytes) = std::fs::read(&path) else {
                    continue;
                };
                #[cfg(unix)]
                let mode = {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::metadata(&path)
                        .ok()
                        .map(|meta| meta.permissions().mode())
                };
                #[cfg(not(unix))]
                let mode = None;
                let relative = path.strip_prefix(root).unwrap_or(&path).to_path_buf();
                into.insert(relative, (bytes, mode));
            }
        }
        let mut into = std::collections::BTreeMap::new();
        walk(root, root, &mut into);
        into
    }

    proptest::proptest! {
        #![proptest_config(proptest::test_runner::Config::with_cases(24))]

        #[test]
        fn the_four_file_actions_round_trip_through_apply_and_rollback(
            actions in proptest::collection::vec(generated_action(), 1..=8)
        ) {
            let fixture = fixture();
            let root = fixture.root.clone();

            // Seed whatever the drawn actions need to already exist. A `create` needs its target
            // absent, so nothing is seeded for it.
            //
            // `expected` is the post-apply state the plan describes, accumulated alongside the
            // request. Asserting the *forward* direction as well as the round-trip is what makes the
            // rename-then-create collision visible: rollback restores every touched path from its
            // pre-apply state, so a batch whose apply silently lost the created file still passes an
            // inverse-only property.
            let mut files = Vec::new();
            let mut expected: Vec<(String, Option<String>)> = Vec::new();
            for (index, action) in actions.iter().enumerate() {
                let existing = format!("src/f{index}.ts");
                match action {
                    GeneratedAction::Create => {
                        files.push(serde_json::json!({
                            "path": format!("src/new{index}.ts"),
                            "action": "create",
                            "unified_diff": whole_file_diff(&format!("created {index}")),
                            "base_digest": ABSENT_DIGEST,
                        }));
                        expected.push((
                            format!("src/new{index}.ts"),
                            Some(format!("created {index}")),
                        ));
                    }
                    GeneratedAction::Modify => {
                        std::fs::write(
                            root.join(&existing),
                            format!("line one\nvalue {index}\nline three\n"),
                        )
                        .expect("seed");
                        files.push(serde_json::json!({
                            "path": existing,
                            "action": "modify",
                            "unified_diff": replace_line_diff(
                                &format!("value {index}"),
                                &format!("changed {index}"),
                                2,
                            ),
                        }));
                        expected.push((
                            existing,
                            Some(format!("line one\nchanged {index}\nline three\n")),
                        ));
                    }
                    GeneratedAction::Delete => {
                        std::fs::write(root.join(&existing), format!("doomed {index}\n"))
                            .expect("seed");
                        files.push(serde_json::json!({ "path": existing.clone(), "action": "delete" }));
                        expected.push((existing, None));
                    }
                    GeneratedAction::Rename | GeneratedAction::RenameThenCreate => {
                        std::fs::write(root.join(&existing), format!("moving {index}\n"))
                            .expect("seed");
                        files.push(serde_json::json!({
                            "path": format!("src/moved{index}.ts"),
                            "action": "rename",
                            "source_path": existing.clone(),
                        }));
                        expected.push((
                            format!("src/moved{index}.ts"),
                            Some(format!("moving {index}\n")),
                        ));
                        if matches!(action, GeneratedAction::RenameThenCreate) {
                            files.push(serde_json::json!({
                                "path": existing.clone(),
                                "action": "create",
                                "unified_diff": whole_file_diff(&format!("replacement {index}")),
                            }));
                            expected.push((existing, Some(format!("replacement {index}"))));
                        } else {
                            expected.push((existing, None));
                        }
                    }
                }
            }

            let before = snapshot(&root);

            let request = serde_json::json!({
                "plan_id": "plan_prop",
                "run_id": "run_prop",
                "checkpoint": true,
                "files": files,
            });
            let response = post(
                fixture.port,
                "/workspace/apply-hunks",
                Some(TEST_TOKEN),
                &request.to_string(),
            );
            proptest::prop_assert!(response.contains(" 200 "), "apply failed: {}", response);
            let checkpoint_id = json_of(&response)["checkpoint_id"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            proptest::prop_assert!(!checkpoint_id.is_empty(), "no checkpoint id: {}", response);

            // The forward direction: every file the plan described is in the state it described.
            for (path, content) in &expected {
                let absolute = root.join(path);
                match content {
                    Some(body) => {
                        let actual = std::fs::read_to_string(&absolute).unwrap_or_default();
                        proptest::prop_assert_eq!(&actual, body, "{} after apply", path);
                    }
                    None => proptest::prop_assert!(
                        !absolute.exists(),
                        "{} should not exist after apply",
                        path
                    ),
                }
            }

            // And the apply has to have *done* something, or the round-trip below is vacuous.
            let after_apply = snapshot(&root);
            proptest::prop_assert_ne!(&before, &after_apply, "the apply changed nothing");

            let rolled = post(
                fixture.port,
                "/workspace/rollback",
                Some(TEST_TOKEN),
                &serde_json::json!({ "checkpoint_id": checkpoint_id }).to_string(),
            );
            proptest::prop_assert!(rolled.contains(" 200 "), "rollback failed: {}", rolled);

            // The property: apply then rollback is the identity on the workspace.
            proptest::prop_assert_eq!(snapshot(&root), before);
        }
    }
}
