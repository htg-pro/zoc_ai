//! Apply unified-diff patches to disk. Used by diff-card accept in the UI.
//!
//! Uses the shared fuzzy patch implementation from llama-studio-hotpath for
//! robust patch application with tolerance for line drift.

use std::path::Path;
use std::sync::Arc;

use llama_studio_hotpath::patch::apply_unified_fuzzy;
use serde::{Deserialize, Serialize};

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
    let original = std::fs::read_to_string(&target).unwrap_or_default();

    // Use fuzzy patch matching with fuzz=3 (allows ±3 lines of drift)
    let result = apply_unified_fuzzy(&original, &args.unified_diff, 3);
    
    if !result.success {
        let error_msg = if result.failed_hunks.is_empty() {
            format!("apply_patch {}: patch failed", target.display())
        } else {
            let hunk_errors: Vec<String> = result.failed_hunks
                .iter()
                .map(|h| format!("Hunk {}: {}", h.hunk_index, h.reason))
                .collect();
            format!("apply_patch {}: {}", target.display(), hunk_errors.join("; "))
        };
        return Err(error_msg);
    }

    let new_content = result.new_content
        .ok_or_else(|| format!("apply_patch {}: no content returned", target.display()))?;

    if new_content.is_empty() && !original.is_empty() && unified_is_full_delete(&args.unified_diff) {
        std::fs::remove_file(&target).map_err(|e| e.to_string())?;
        return Ok(ApplyPatchResult {
            path: target.to_string_lossy().into_owned(),
            created: false,
            deleted: true,
            bytes_written: 0,
        });
    }

    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&target, new_content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(ApplyPatchResult {
        path: target.to_string_lossy().into_owned(),
        created,
        deleted: false,
        bytes_written: new_content.len(),
    })
}

fn unified_is_full_delete(diff: &str) -> bool {
    diff.lines().any(|l| l.starts_with("+++ /dev/null"))
}

#[cfg(test)]
mod tests {
    use llama_studio_hotpath::patch::apply_unified_fuzzy;

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
        assert!(content.starts_with("hi\nthere"), "Should contain the added lines");
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
        assert_eq!(result.new_content.unwrap(), "extra1\nextra2\nalpha\nBETA\ngamma\n");
    }
}
