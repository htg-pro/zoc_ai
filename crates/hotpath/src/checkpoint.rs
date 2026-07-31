//! Git "pre-run checkpoint" helper (Part 7.2) and the apply checkpoint store
//! (zoc-agent-chat-rebuild R10.5, R10.6, R10.7, R10.15, task 18.7).
//!
//! Two mechanisms with different jobs, deliberately kept in one module because a
//! reader looking for "how do I undo an apply" should find both in one place.
//!
//! [`git_checkpoint`] shells out to the `git` CLI to snapshot a dirty workspace
//! around a Run. It is a best-effort safety net: it does nothing in a workspace
//! that is not a repository, and nothing when the tree is already clean.
//!
//! [`CheckpointStore`] is the contract R10.15 asks for, and it exists because the
//! git helper cannot satisfy it. Three gaps, each fatal on its own: a non-repository
//! workspace gets no checkpoint at all; a clean tree returns `None`, so the surface
//! is handed no id and offers no rollback for an apply that certainly can be undone;
//! and a commit sha identifies neither the Run, nor the applied files, nor the
//! timestamp, which is what R10.5 says a checkpoint must identify.
//!
//! ## The store records path *states*, not per-action undo operations
//!
//! The design's table describes rollback per action — delete a created file, restore
//! a deleted one, move a renamed one back. Implementing it that way means four undo
//! branches whose correctness depends on replay order, which is why the design also
//! requires reverse-order replay: renaming `a → b` and then creating a new `a` is a
//! legal plan, and undoing it forwards collides.
//!
//! This store records, for every path an apply *touches*, that path's pre-apply state
//! — its bytes and mode, or the fact that it did not exist — deduplicated so the
//! first (earliest, therefore true) state for a path wins. Rollback then restores
//! every recorded path to its recorded state, and:
//!
//!   - the four actions need no branches at all, because "delete the created file" and
//!     "restore the deleted file" are both just "put this path back as it was";
//!   - order stops mattering, because each path has exactly one target state, which is
//!     strictly stronger than replaying in reverse and cannot collide;
//!   - a rename is two touched paths and one file, which is why the report carries both
//!     counts and R10.7's user-facing figure is the file one.
//!
//! ## Failure is refused rather than absorbed
//!
//! A capture that fails leaves no checkpoint, and the caller is expected to refuse the
//! apply rather than proceed. Writing files the user cannot undo, having shown them a
//! review that promised they could, is the one outcome R10 exists to prevent.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::transaction::Transaction;

/// Why a checkpoint could not be created.
#[derive(Debug)]
pub enum CheckpointError {
    /// The `git` binary could not be launched.
    GitUnavailable(String),
    /// A git subcommand exited non-zero; carries the trimmed stderr.
    GitFailed(String),
    /// The checkpoint store could not be read or written.
    Io(String),
    /// No checkpoint with that id, or an id that is not one this store would mint.
    NotFound(String),
    /// A manifest that is present but unusable.
    Corrupt(String),
}

impl std::fmt::Display for CheckpointError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CheckpointError::GitUnavailable(e) => write!(f, "git unavailable: {e}"),
            CheckpointError::GitFailed(e) => write!(f, "git failed: {e}"),
            CheckpointError::Io(e) => write!(f, "checkpoint store io: {e}"),
            CheckpointError::NotFound(e) => write!(f, "no such checkpoint: {e}"),
            CheckpointError::Corrupt(e) => write!(f, "checkpoint unusable: {e}"),
        }
    }
}

impl std::error::Error for CheckpointError {}

/// Run `git` in `root`, returning stdout on success or the trimmed stderr.
fn git(root: &Path, args: &[&str]) -> Result<String, CheckpointError> {
    let out = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .map_err(|e| CheckpointError::GitUnavailable(e.to_string()))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(CheckpointError::GitFailed(
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ))
    }
}

/// Whether `root` is inside a git work tree.
pub fn is_git_repo(root: &Path) -> bool {
    git(root, &["rev-parse", "--is-inside-work-tree"])
        .map(|s| s.trim() == "true")
        .unwrap_or(false)
}

/// Whether the work tree has any staged, unstaged, or untracked changes.
pub fn is_dirty(root: &Path) -> Result<bool, CheckpointError> {
    Ok(!git(root, &["status", "--porcelain"])?.trim().is_empty())
}

/// Commit the current dirty work tree as a checkpoint with `message`, returning
/// the new commit's full hash. Returns `Ok(None)` when there is nothing to
/// checkpoint — a clean tree, or a `root` that is not a git repository (a
/// checkpoint is a best-effort safety net, never a hard requirement).
pub fn git_checkpoint(root: &Path, message: &str) -> Result<Option<String>, CheckpointError> {
    if !is_git_repo(root) {
        return Ok(None);
    }
    if !is_dirty(root)? {
        return Ok(None);
    }
    git(root, &["add", "-A"])?;
    git(root, &["commit", "--no-verify", "-m", message])?;
    let hash = git(root, &["rev-parse", "HEAD"])?.trim().to_string();
    Ok(Some(hash))
}

// ── The apply checkpoint store ────────────────────────────────────────────

/// One file change an apply is about to make, as the caller describes it.
#[derive(Debug, Clone)]
pub struct PlannedChange {
    /// Workspace-relative target path — what will exist after the apply.
    pub path: String,
    /// `create` | `modify` | `delete` | `rename` (R10.10). Recorded for reporting only.
    pub action: String,
    /// A rename's origin, workspace-relative. `None` for the other three.
    pub source_path: Option<String>,
}

/// One touched path's pre-apply state. The unit rollback restores.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathState {
    pub path: String,
    /// False when the path did not exist — the distinction R10.15 turns on, and the
    /// reason a create rolls back to a deletion rather than to an empty file.
    pub existed: bool,
    /// Blob file holding the pre-apply bytes, relative to the checkpoint directory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blob: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
}

/// One file change, kept so a receipt can name the action per file (R10.15).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangeRecord {
    pub path: String,
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
}

/// The manifest: what R10.5 says a checkpoint identifies, plus what rollback needs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Checkpoint {
    pub id: String,
    pub run_id: String,
    pub plan_id: String,
    /// Epoch milliseconds. R10.5's timestamp, in the one format that needs no dependency.
    pub created_at_ms: u128,
    pub root: String,
    /// The pre-run git commit, when there was one. Recorded, never the id: a workspace
    /// without git still gets a checkpoint, so the id cannot be a commit sha.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_commit: Option<String>,
    pub changes: Vec<ChangeRecord>,
    pub states: Vec<PathState>,
}

/// What a rollback did (R10.7).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreReport {
    pub checkpoint_id: String,
    /// Files restored — the figure a user reads. A rename is one file.
    pub restored_files: usize,
    /// Paths restored. A rename is two, which is why this is reported separately.
    pub restored_paths: usize,
}

/// Where checkpoints live. One directory per checkpoint, one blob per touched path.
pub struct CheckpointStore {
    dir: PathBuf,
}

/// A checkpoint id is minted here and later arrives over a loopback socket, so it is
/// validated on the way back in: it names a directory, and a caller must not be able to
/// reach one this store did not create.
fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.starts_with("ckpt_")
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// A recorded path must stay inside the workspace, even if the manifest was edited.
fn is_safe_relative(path: &str) -> bool {
    let candidate = Path::new(path);
    !path.is_empty()
        && candidate.is_relative()
        && candidate
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
}

fn digest_of(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{:x}", hasher.finalize())
}

#[cfg(unix)]
fn mode_of(metadata: &fs::Metadata) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    Some(metadata.permissions().mode())
}

#[cfg(not(unix))]
fn mode_of(_metadata: &fs::Metadata) -> Option<u32> {
    None
}

fn io(error: impl std::fmt::Display) -> CheckpointError {
    CheckpointError::Io(error.to_string())
}

impl CheckpointStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// The directory holding one checkpoint's manifest and blobs.
    fn path_of(&self, id: &str) -> PathBuf {
        self.dir.join(id)
    }

    /// Record every touched path's pre-apply state. Call this *before* the apply commits.
    ///
    /// The touched set is each change's target path, plus a rename's source. Deduplicated with
    /// the first state winning: a plan that renames `a → b` and then creates a new `a` touches
    /// `a` twice, and the state that has to be restored is the one from before the whole apply.
    pub fn capture(
        &self,
        root: &Path,
        run_id: &str,
        plan_id: &str,
        git_commit: Option<String>,
        changes: &[PlannedChange],
    ) -> Result<Checkpoint, CheckpointError> {
        let created_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|since| since.as_millis())
            .unwrap_or(0);
        let id = format!("ckpt_{created_at_ms}_{:04x}", next_sequence());
        let checkpoint_dir = self.path_of(&id);
        let blobs = checkpoint_dir.join("blobs");
        fs::create_dir_all(&blobs).map_err(io)?;

        let mut touched: Vec<String> = Vec::with_capacity(changes.len() + 1);
        for change in changes {
            for candidate in [Some(&change.path), change.source_path.as_ref()]
                .into_iter()
                .flatten()
            {
                if !is_safe_relative(candidate) {
                    return Err(CheckpointError::Io(format!(
                        "refusing to checkpoint {candidate}: not a workspace-relative path"
                    )));
                }
                if !touched.iter().any(|seen| seen == candidate) {
                    touched.push(candidate.clone());
                }
            }
        }

        let mut states = Vec::with_capacity(touched.len());
        for (index, relative) in touched.iter().enumerate() {
            let absolute = root.join(relative);
            match fs::read(&absolute) {
                Ok(bytes) => {
                    let name = format!("{index:04}");
                    fs::write(blobs.join(&name), &bytes).map_err(io)?;
                    let mode = fs::metadata(&absolute).ok().and_then(|m| mode_of(&m));
                    states.push(PathState {
                        path: relative.clone(),
                        existed: true,
                        blob: Some(name),
                        mode,
                        digest: Some(digest_of(&bytes)),
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    states.push(PathState {
                        path: relative.clone(),
                        existed: false,
                        blob: None,
                        mode: None,
                        digest: None,
                    });
                }
                // An unreadable path is not an absent one. Recording it as absent would make
                // rollback *delete* a file it could not read, which is data loss dressed as a
                // restore — so the capture fails and the caller refuses the apply.
                Err(error) => return Err(io(error)),
            }
        }

        let checkpoint = Checkpoint {
            id: id.clone(),
            run_id: run_id.to_string(),
            plan_id: plan_id.to_string(),
            created_at_ms,
            root: root.to_string_lossy().into_owned(),
            git_commit,
            changes: changes
                .iter()
                .map(|change| ChangeRecord {
                    path: change.path.clone(),
                    action: change.action.clone(),
                    source_path: change.source_path.clone(),
                })
                .collect(),
            states,
        };

        let body = serde_json::to_vec_pretty(&checkpoint).map_err(io)?;
        // Temp-then-rename, so a manifest is either complete or absent. A half-written manifest
        // would be a checkpoint that looks present and cannot restore.
        let manifest = checkpoint_dir.join("manifest.json");
        let staging = checkpoint_dir.join("manifest.json.partial");
        fs::write(&staging, &body).map_err(io)?;
        fs::rename(&staging, &manifest).map_err(io)?;

        Ok(checkpoint)
    }

    /// Read one checkpoint's manifest.
    pub fn load(&self, id: &str) -> Result<Checkpoint, CheckpointError> {
        if !is_valid_id(id) {
            return Err(CheckpointError::NotFound(id.to_string()));
        }
        let manifest = self.path_of(id).join("manifest.json");
        let raw = match fs::read(&manifest) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(CheckpointError::NotFound(id.to_string()))
            }
            Err(error) => return Err(io(error)),
        };
        serde_json::from_slice(&raw).map_err(|error| CheckpointError::Corrupt(error.to_string()))
    }

    /// Restore every path the checkpoint recorded, atomically (R10.6, R10.7).
    ///
    /// Atomic on the same terms as apply: one transaction, so a failure part-way leaves the
    /// workspace as it was rather than half rolled back — a state neither the agent nor the
    /// checkpoint describes.
    pub fn rollback(&self, id: &str) -> Result<RestoreReport, CheckpointError> {
        let checkpoint = self.load(id)?;
        let root = PathBuf::from(&checkpoint.root);
        let blobs = self.path_of(&checkpoint.id).join("blobs");

        let mut transaction = Transaction::new();
        for state in &checkpoint.states {
            if !is_safe_relative(&state.path) {
                return Err(CheckpointError::Corrupt(format!(
                    "{} is not a workspace-relative path",
                    state.path
                )));
            }
            let absolute = root.join(&state.path);
            if !state.existed {
                transaction.add_delete(absolute);
                continue;
            }
            let Some(name) = state.blob.as_deref() else {
                return Err(CheckpointError::Corrupt(format!(
                    "{} was recorded as existing with no blob",
                    state.path
                )));
            };
            let bytes = fs::read(blobs.join(name)).map_err(|error| {
                CheckpointError::Corrupt(format!("blob for {} is unreadable: {error}", state.path))
            })?;
            if let Some(expected) = state.digest.as_deref() {
                // The blob is the authority for the content; the digest is what makes a corrupted
                // blob a refusal rather than a restore of the wrong bytes.
                let actual = digest_of(&bytes);
                if actual != expected {
                    return Err(CheckpointError::Corrupt(format!(
                        "blob for {} does not match its recorded digest",
                        state.path
                    )));
                }
            }
            transaction.add_write_with_mode(absolute, bytes, state.mode);
        }

        transaction
            .commit()
            .map_err(|error| CheckpointError::Io(error.to_string()))?;

        Ok(RestoreReport {
            checkpoint_id: checkpoint.id,
            restored_files: checkpoint.changes.len(),
            restored_paths: checkpoint.states.len(),
        })
    }
}

/// A per-process counter, so two checkpoints minted in the same millisecond differ.
fn next_sequence() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_repo() -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("zoc-ckpt-{nanos}-{n}"));
        fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init"]).unwrap();
        git(&dir, &["config", "user.email", "test@example.com"]).unwrap();
        git(&dir, &["config", "user.name", "Test"]).unwrap();
        git(&dir, &["config", "commit.gpgsign", "false"]).unwrap();
        dir
    }

    #[test]
    fn clean_tree_returns_none() {
        let dir = temp_repo();
        assert_eq!(
            git_checkpoint(&dir, "zoc: pre-run checkpoint").unwrap(),
            None
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn dirty_tree_creates_named_commit_and_cleans_tree() {
        let dir = temp_repo();
        fs::write(dir.join("a.txt"), "hello").unwrap();
        assert!(is_dirty(&dir).unwrap());

        let hash = git_checkpoint(&dir, "zoc: pre-run checkpoint").unwrap();
        assert!(
            hash.is_some(),
            "a dirty tree should produce a checkpoint commit"
        );

        let subject = git(&dir, &["log", "-1", "--pretty=%s"]).unwrap();
        assert_eq!(subject.trim(), "zoc: pre-run checkpoint");
        assert!(
            !is_dirty(&dir).unwrap(),
            "tree should be clean after the checkpoint"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn non_repo_returns_none() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("zoc-nonrepo-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(git_checkpoint(&dir, "x").unwrap(), None);
        assert!(!is_git_repo(&dir));
        fs::remove_dir_all(&dir).ok();
    }

    // ── The apply checkpoint store (R10.5, R10.6, R10.7, R10.15) ──────────

    struct Fixture {
        _guard: tempfile::TempDir,
        root: std::path::PathBuf,
        store: CheckpointStore,
    }

    fn fixture() -> Fixture {
        let guard = tempfile::tempdir().unwrap();
        let root = guard.path().join("workspace");
        let store = CheckpointStore::new(guard.path().join("checkpoints"));
        fs::create_dir_all(root.join("src")).unwrap();
        Fixture {
            _guard: guard,
            root,
            store,
        }
    }

    fn change(path: &str, action: &str, source: Option<&str>) -> PlannedChange {
        PlannedChange {
            path: path.to_string(),
            action: action.to_string(),
            source_path: source.map(str::to_string),
        }
    }

    #[test]
    fn all_four_actions_round_trip_through_capture_and_rollback() {
        let fixture = fixture();
        let root = &fixture.root;

        // The pre-apply workspace: three of the four actions need something to already exist.
        fs::write(root.join("src/modified.ts"), "before\n").unwrap();
        fs::write(root.join("src/deleted.ts"), "doomed\n").unwrap();
        fs::write(root.join("src/original.ts"), "moving\n").unwrap();

        let changes = [
            change("src/created.ts", "create", None),
            change("src/modified.ts", "modify", None),
            change("src/deleted.ts", "delete", None),
            change("src/renamed.ts", "rename", Some("src/original.ts")),
        ];
        let checkpoint = fixture
            .store
            .capture(root, "run_1", "plan_1", None, &changes)
            .expect("capture");

        // Now the apply itself, exactly as the bridge would perform it.
        fs::write(root.join("src/created.ts"), "new\n").unwrap();
        fs::write(root.join("src/modified.ts"), "after\n").unwrap();
        fs::remove_file(root.join("src/deleted.ts")).unwrap();
        fs::write(root.join("src/renamed.ts"), "moving\n").unwrap();
        fs::remove_file(root.join("src/original.ts")).unwrap();

        let report = fixture.store.rollback(&checkpoint.id).expect("rollback");

        // R10.7: the count is files, and a rename is one file across two paths.
        assert_eq!(report.restored_files, 4);
        assert_eq!(report.restored_paths, 5);
        assert_eq!(report.checkpoint_id, checkpoint.id);

        // R10.15, one clause at a time.
        assert!(
            !root.join("src/created.ts").exists(),
            "rolling back a create must remove the file, not empty it"
        );
        assert_eq!(
            fs::read_to_string(root.join("src/modified.ts")).unwrap(),
            "before\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("src/deleted.ts")).unwrap(),
            "doomed\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("src/original.ts")).unwrap(),
            "moving\n"
        );
        assert!(
            !root.join("src/renamed.ts").exists(),
            "rolling back a rename must return the file, not leave both ends"
        );
    }

    #[test]
    fn a_created_file_is_distinguished_from_one_that_existed_and_was_empty() {
        let fixture = fixture();
        let root = &fixture.root;
        fs::write(root.join("src/empty.ts"), "").unwrap();

        let checkpoint = fixture
            .store
            .capture(
                root,
                "run_1",
                "plan_1",
                None,
                &[
                    change("src/empty.ts", "modify", None),
                    change("src/fresh.ts", "create", None),
                ],
            )
            .expect("capture");

        fs::write(root.join("src/empty.ts"), "filled\n").unwrap();
        fs::write(root.join("src/fresh.ts"), "brand new\n").unwrap();
        fixture.store.rollback(&checkpoint.id).expect("rollback");

        // The whole reason `existed` is a field rather than an empty pre-image.
        assert_eq!(fs::read_to_string(root.join("src/empty.ts")).unwrap(), "");
        assert!(!root.join("src/fresh.ts").exists());
    }

    #[test]
    fn the_earliest_state_wins_when_one_path_is_touched_twice() {
        let fixture = fixture();
        let root = &fixture.root;
        fs::write(root.join("src/a.ts"), "original a\n").unwrap();

        // The collision the design's reverse-order rule exists for: `a` moves to `b`, and a new
        // `a` is created in its place. `a` is touched twice, and the state to restore is the one
        // from before the whole apply.
        let checkpoint = fixture
            .store
            .capture(
                root,
                "run_1",
                "plan_1",
                None,
                &[
                    change("src/b.ts", "rename", Some("src/a.ts")),
                    change("src/a.ts", "create", None),
                ],
            )
            .expect("capture");

        fs::write(root.join("src/b.ts"), "original a\n").unwrap();
        fs::write(root.join("src/a.ts"), "a different a\n").unwrap();
        fixture.store.rollback(&checkpoint.id).expect("rollback");

        assert_eq!(
            fs::read_to_string(root.join("src/a.ts")).unwrap(),
            "original a\n",
            "the pre-apply content of a path touched twice must be the earliest one"
        );
        assert!(!root.join("src/b.ts").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_restored_file_keeps_its_mode_bits() {
        use std::os::unix::fs::PermissionsExt;

        let fixture = fixture();
        let root = &fixture.root;
        let script = root.join("src/run.sh");
        fs::write(&script, "#!/bin/sh\necho hi\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();

        let checkpoint = fixture
            .store
            .capture(
                root,
                "run_1",
                "plan_1",
                None,
                &[change("src/run.sh", "delete", None)],
            )
            .expect("capture");

        fs::remove_file(&script).unwrap();
        fixture.store.rollback(&checkpoint.id).expect("rollback");

        // A restored executable that is no longer executable is a rollback that did not finish.
        let mode = fs::metadata(&script).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755);
    }

    #[test]
    fn the_manifest_identifies_the_run_the_files_and_the_time() {
        let fixture = fixture();
        let checkpoint = fixture
            .store
            .capture(
                &fixture.root,
                "run_42",
                "plan_7",
                Some("deadbeef".into()),
                &[change("src/created.ts", "create", None)],
            )
            .expect("capture");

        // R10.5's three facts, plus the git commit as a recorded extra rather than as the id.
        let reloaded = fixture.store.load(&checkpoint.id).expect("load");
        assert_eq!(reloaded.run_id, "run_42");
        assert_eq!(reloaded.plan_id, "plan_7");
        assert!(reloaded.created_at_ms > 0);
        assert_eq!(reloaded.changes.len(), 1);
        assert_eq!(reloaded.changes[0].action, "create");
        assert_eq!(reloaded.git_commit.as_deref(), Some("deadbeef"));
        assert!(reloaded.id.starts_with("ckpt_"));
    }

    #[test]
    fn an_id_that_is_not_ours_is_refused_rather_than_resolved() {
        let fixture = fixture();
        // Traversal, an empty id, and a plausible-but-absent id all have to be refusals: the id
        // arrives over a loopback socket and names a directory.
        for id in ["../../etc", "", "ckpt_../..", "nope", "ckpt_missing"] {
            let outcome = fixture.store.rollback(id);
            assert!(
                matches!(outcome, Err(CheckpointError::NotFound(_))),
                "{id} was not refused: {outcome:?}"
            );
        }
    }

    #[test]
    fn a_corrupted_blob_refuses_to_restore() {
        let fixture = fixture();
        let root = &fixture.root;
        fs::write(root.join("src/a.ts"), "good content\n").unwrap();

        let checkpoint = fixture
            .store
            .capture(
                root,
                "run_1",
                "plan_1",
                None,
                &[change("src/a.ts", "modify", None)],
            )
            .expect("capture");

        // Tamper with the stored pre-image. Restoring it would put content in the workspace that
        // the user never had, which is worse than refusing.
        let blob = fixture
            .store
            .path_of(&checkpoint.id)
            .join("blobs")
            .join("0000");
        fs::write(&blob, "tampered\n").unwrap();

        fs::write(root.join("src/a.ts"), "applied\n").unwrap();
        let outcome = fixture.store.rollback(&checkpoint.id);
        assert!(
            matches!(outcome, Err(CheckpointError::Corrupt(_))),
            "{outcome:?}"
        );
        assert_eq!(
            fs::read_to_string(root.join("src/a.ts")).unwrap(),
            "applied\n",
            "a refused rollback must change nothing"
        );
    }

    #[test]
    fn a_path_outside_the_workspace_is_refused_at_capture() {
        let fixture = fixture();
        for path in ["../escape.ts", "/etc/passwd", ""] {
            let outcome = fixture.store.capture(
                &fixture.root,
                "run_1",
                "plan_1",
                None,
                &[change(path, "modify", None)],
            );
            assert!(outcome.is_err(), "{path} was captured");
        }
    }
}
