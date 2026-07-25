//! Git "pre-run checkpoint" helper (Part 7.2).
//!
//! Shells out to the `git` CLI (matching the desktop crate's convention of not
//! linking libgit2) to snapshot a dirty workspace around an agent run, so
//! applied changes are always recoverable with `git reset`. Kept in the hot-
//! path crate — free of Tauri — so it is unit-tested here against throwaway
//! repositories and reused by the desktop `apply_transaction` command.

use std::path::Path;
use std::process::Command;

/// Why a checkpoint could not be created.
#[derive(Debug)]
pub enum CheckpointError {
    /// The `git` binary could not be launched.
    GitUnavailable(String),
    /// A git subcommand exited non-zero; carries the trimmed stderr.
    GitFailed(String),
}

impl std::fmt::Display for CheckpointError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CheckpointError::GitUnavailable(e) => write!(f, "git unavailable: {e}"),
            CheckpointError::GitFailed(e) => write!(f, "git failed: {e}"),
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_repo() -> std::path::PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
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
        assert_eq!(git_checkpoint(&dir, "zoc: pre-run checkpoint").unwrap(), None);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn dirty_tree_creates_named_commit_and_cleans_tree() {
        let dir = temp_repo();
        fs::write(dir.join("a.txt"), "hello").unwrap();
        assert!(is_dirty(&dir).unwrap());

        let hash = git_checkpoint(&dir, "zoc: pre-run checkpoint").unwrap();
        assert!(hash.is_some(), "a dirty tree should produce a checkpoint commit");

        let subject = git(&dir, &["log", "-1", "--pretty=%s"]).unwrap();
        assert_eq!(subject.trim(), "zoc: pre-run checkpoint");
        assert!(!is_dirty(&dir).unwrap(), "tree should be clean after the checkpoint");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn non_repo_returns_none() {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("zoc-nonrepo-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(git_checkpoint(&dir, "x").unwrap(), None);
        assert!(!is_git_repo(&dir));
        fs::remove_dir_all(&dir).ok();
    }
}
