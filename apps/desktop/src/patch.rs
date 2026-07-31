//! Apply unified-diff patches to disk. Used by diff-card accept in the UI.
//!
//! Uses the shared fuzzy patch implementation from zoc-studio-hotpath for
//! robust patch application with tolerance for line drift.

use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use zoc_studio_hotpath::checkpoint::{git_checkpoint, CheckpointStore};
use zoc_studio_hotpath::patch::apply_unified_fuzzy;
use zoc_studio_hotpath::transaction::Transaction;

use crate::workspace::{ensure_within_workspace, WorkspaceState};

#[derive(Serialize, Deserialize, Debug)]
pub struct ApplyPatchArgs {
    pub workspace_root: String,
    pub file_path: String, // relative or absolute
    pub unified_diff: String,
}

#[derive(Serialize, Debug)]
pub struct ApplyPatchResult {
    pub path: String,
    pub created: bool,
    pub deleted: bool,
    pub bytes_written: usize,
}

#[tauri::command]
pub fn apply_patch(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    args: ApplyPatchArgs,
) -> Result<ApplyPatchResult, String> {
    // The frontend passes its idea of `workspace_root` for traceability,
    // but we authoritatively validate against the in-process WorkspaceState
    // so a compromised renderer can't escape the active workspace.
    let _claimed = args.workspace_root;
    let target = ensure_within_workspace(&workspace, Path::new(&args.file_path))?;
    let created = !target.exists();
    let original = read_existing_text(&target)?;

    // Use fuzzy patch matching with fuzz=3 (allows ±3 lines of drift)
    let result = apply_unified_fuzzy(&original, &args.unified_diff, 3);

    if !result.success {
        let error_msg = if result.failed_hunks.is_empty() {
            format!("apply_patch {}: patch failed", target.display())
        } else {
            let hunk_errors: Vec<String> = result
                .failed_hunks
                .iter()
                .map(|h| format!("Hunk {}: {}", h.hunk_index, h.reason))
                .collect();
            format!(
                "apply_patch {}: {}",
                target.display(),
                hunk_errors.join("; ")
            )
        };
        return Err(error_msg);
    }

    let new_content = result
        .new_content
        .ok_or_else(|| format!("apply_patch {}: no content returned", target.display()))?;

    let deleted = new_content.is_empty()
        && !original.is_empty()
        && unified_is_full_delete(&args.unified_diff);
    let bytes_written = if deleted { 0 } else { new_content.len() };
    let mut tx = Transaction::new();
    if deleted {
        tx.add_delete(target.clone());
    } else {
        tx.add_write(target.clone(), new_content.into_bytes());
    }
    tx.commit().map_err(|e| e.to_string())?;

    Ok(ApplyPatchResult {
        path: target.to_string_lossy().into_owned(),
        created: created && !deleted,
        deleted,
        bytes_written,
    })
}

fn unified_is_full_delete(diff: &str) -> bool {
    diff.lines().any(|l| l.starts_with("+++ /dev/null"))
}

fn read_existing_text(path: &Path) -> Result<String, String> {
    match std::fs::read_to_string(path) {
        Ok(content) => Ok(content),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(format!("read {}: {error}", path.display())),
    }
}

/// One staged filesystem operation in an atomic transaction: `kind` is
/// `"write"` (with `content`), `"delete"`, or `"patch"` (with `unified_diff`).
#[derive(Deserialize, Debug)]
pub struct TransactionOpArg {
    pub kind: String,
    pub path: String,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub unified_diff: Option<String>,
}

#[derive(Deserialize, Debug)]
pub struct ApplyTransactionArgs {
    pub workspace_root: String,
    pub ops: Vec<TransactionOpArg>,
}

#[derive(Serialize, Debug)]
pub struct ApplyTransactionResult {
    pub written: usize,
    pub deleted: usize,
    /// The `zoc: pre-run checkpoint` commit hash, if one was created.
    pub checkpoint: Option<String>,
    /// A non-fatal git error after filesystem commit, surfaced to the UI.
    pub checkpoint_error: Option<String>,
}

/// Apply N filesystem operations atomically (all-or-nothing) inside the active
/// workspace, then — post-commit — snapshot the dirty tree as a
/// `zoc: pre-run checkpoint` git commit so the applied changes are recoverable.
///
/// Every op's path is authoritatively validated against the in-process
/// `WorkspaceState` (so a compromised renderer can't escape the workspace); the
/// staged writes/deletes are committed via the hot-path [`Transaction`], which
/// leaves the workspace exactly as it was if any single op fails.
fn stage_transaction(
    workspace: &WorkspaceState,
    ops: &[TransactionOpArg],
) -> Result<Transaction, String> {
    let mut tx = Transaction::new();
    for op in ops {
        let target = ensure_within_workspace(workspace, Path::new(&op.path))?;
        match op.kind.as_str() {
            "write" => {
                let content = op
                    .content
                    .as_ref()
                    .ok_or_else(|| format!("write operation for {} has no content", op.path))?;
                tx.add_write(target, content.as_bytes().to_vec());
            }
            "delete" => tx.add_delete(target),
            "patch" => {
                let diff = op.unified_diff.as_deref().ok_or_else(|| {
                    format!("patch operation for {} has no unified_diff", op.path)
                })?;
                let original = read_existing_text(&target)?;
                let applied = apply_unified_fuzzy(&original, diff, 3);
                if !applied.success {
                    let reasons = applied
                        .failed_hunks
                        .iter()
                        .map(|hunk| format!("Hunk {}: {}", hunk.hunk_index, hunk.reason))
                        .collect::<Vec<_>>()
                        .join("; ");
                    return Err(format!(
                        "apply_transaction {}: {}",
                        target.display(),
                        if reasons.is_empty() {
                            "patch failed"
                        } else {
                            &reasons
                        }
                    ));
                }
                let content = applied.new_content.ok_or_else(|| {
                    format!(
                        "apply_transaction {}: no content returned",
                        target.display()
                    )
                })?;
                if content.is_empty() && !original.is_empty() && unified_is_full_delete(diff) {
                    tx.add_delete(target);
                } else {
                    tx.add_write(target, content.into_bytes());
                }
            }
            other => {
                return Err(format!(
                    "apply_transaction: unknown op kind {other:?} (expected \"write\", \"delete\", or \"patch\")"
                ));
            }
        }
    }
    Ok(tx)
}

#[tauri::command]
pub fn apply_transaction(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    args: ApplyTransactionArgs,
) -> Result<ApplyTransactionResult, String> {
    // Validated authoritatively below; the claimed root is kept only for parity
    // with `apply_patch` (traceability), never trusted.
    let _claimed = args.workspace_root;

    let tx = stage_transaction(workspace.inner().as_ref(), &args.ops)?;
    let result = tx.commit().map_err(|e| e.to_string())?;

    // A filesystem commit cannot be undone merely because git checkpointing
    // fails, so expose that post-commit error separately instead of hiding it
    // or reporting the already-applied transaction as failed.
    let (checkpoint, checkpoint_error) = if result.written + result.deleted == 0 {
        (None, None)
    } else {
        match workspace.get() {
            Some(root) => match git_checkpoint(&root, "zoc: pre-run checkpoint") {
                Ok(hash) => (hash, None),
                Err(error) => (None, Some(error.to_string())),
            },
            None => (None, None),
        }
    };

    Ok(ApplyTransactionResult {
        written: result.written,
        deleted: result.deleted,
        checkpoint,
        checkpoint_error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applies_simple_hunk() {
        let src = "alpha\nbeta\ngamma\n";
        let diff = "--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n";
        let result = apply_unified_fuzzy(src, diff, 3);
        assert!(result.success, "Patch should apply successfully");
        assert_eq!(result.new_content.unwrap(), "alpha\nBETA\ngamma\n");
    }

    #[test]
    fn creates_new_file_from_dev_null() {
        let diff = "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+hi\n+there\n";
        let result = apply_unified_fuzzy("", diff, 3);
        assert!(result.success, "Patch should apply successfully");
        // Fuzzy patcher normalizes trailing newlines
        let content = result.new_content.unwrap();
        assert!(
            content.starts_with("hi\nthere"),
            "Should contain the added lines"
        );
    }

    #[test]
    fn rejects_mismatch_with_zero_fuzz() {
        let src = "alpha\nbeta\n";
        let diff = "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n alpha\n-WRONG\n";
        let result = apply_unified_fuzzy(src, diff, 0);
        assert!(!result.success, "Patch should fail with zero fuzz");
    }

    #[test]
    fn applies_with_drift() {
        let src = "extra1\nextra2\nalpha\nbeta\ngamma\n";
        let diff = "--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n";
        let result = apply_unified_fuzzy(src, diff, 3);
        assert!(result.success, "Patch should apply with drift");
        assert_eq!(
            result.new_content.unwrap(),
            "extra1\nextra2\nalpha\nBETA\ngamma\n"
        );
    }

    #[test]
    fn batch_patch_preparation_fails_before_any_workspace_change() {
        let root = std::env::temp_dir().join(format!(
            "zoc-patch-batch-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.txt"), "old a\n").unwrap();
        std::fs::write(root.join("b.txt"), "old b\n").unwrap();
        let workspace = WorkspaceState::default();
        workspace.set(Some(root.clone()));
        let ops = vec![
            TransactionOpArg {
                kind: "patch".into(),
                path: "a.txt".into(),
                content: None,
                unified_diff: Some(
                    "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old a\n+new a\n".into(),
                ),
            },
            TransactionOpArg {
                kind: "patch".into(),
                path: "b.txt".into(),
                content: None,
                unified_diff: Some(
                    "--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-WRONG\n+new b\n".into(),
                ),
            },
        ];

        assert!(stage_transaction(&workspace, &ops).is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "old a\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("b.txt")).unwrap(),
            "old b\n"
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn batch_patch_commit_updates_multiple_and_nested_files() {
        let root = std::env::temp_dir().join(format!(
            "zoc-patch-commit-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.txt"), "old\n").unwrap();
        let workspace = WorkspaceState::default();
        workspace.set(Some(root.clone()));
        let ops = vec![
            TransactionOpArg {
                kind: "patch".into(),
                path: "a.txt".into(),
                content: None,
                unified_diff: Some("--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n".into()),
            },
            TransactionOpArg {
                kind: "write".into(),
                path: "new/deep/file.txt".into(),
                content: Some("nested\n".into()),
                unified_diff: None,
            },
        ];

        let result = stage_transaction(&workspace, &ops)
            .unwrap()
            .commit()
            .unwrap();
        assert_eq!(result.written, 2);
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "new\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("new/deep/file.txt")).unwrap(),
            "nested\n"
        );
        std::fs::remove_dir_all(root).ok();
    }
}

// ── Checkpoint rollback (zoc-agent-chat-rebuild R10.6, R10.7, task 18.7) ──

#[derive(Deserialize, Debug)]
pub struct RollbackArgs {
    pub checkpoint_id: String,
}

#[derive(Serialize, Debug)]
pub struct RollbackResult {
    pub checkpoint_id: String,
    /// Files restored — R10.7's figure, and the one the receipt reports.
    pub restored_files: usize,
    /// Paths restored. A rename is one file across two of them.
    pub restored_paths: usize,
}

/// Restore one apply checkpoint (R10.6, R10.7).
///
/// The renderer's half of rollback, and it is a Tauri command rather than a bridge route because
/// the *user* rolls back, from the receipt on a plan card. The Agent_Runtime's own path to the same
/// store is `/workspace/rollback`, and both hold the same `CheckpointStore` — one store, or a
/// checkpoint taken by an apply would be invisible to the control offering to undo it.
///
/// Rolling back is deliberately **not** offered as a model-facing tool: a Run undoing a change the
/// user accepted is not something the review in R10.2 and R10.3 ever authorised.
#[tauri::command]
pub fn workspace_rollback(
    checkpoints: tauri::State<'_, Arc<CheckpointStore>>,
    args: RollbackArgs,
) -> Result<RollbackResult, String> {
    let report = checkpoints
        .rollback(&args.checkpoint_id)
        .map_err(|err| err.to_string())?;
    Ok(RollbackResult {
        checkpoint_id: report.checkpoint_id,
        restored_files: report.restored_files,
        restored_paths: report.restored_paths,
    })
}
