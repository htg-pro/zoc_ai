//! Atomic multi-file transaction primitive (Part 7.2).
//!
//! Stage writes/deletes, then [`Transaction::commit`] applies them
//! all-or-nothing: each write goes to a temp file in the same directory and is
//! renamed into place; if any step fails, every already-applied change is
//! rolled back from an in-memory backup so the workspace is left exactly as it
//! was. Pure `std::fs` (no Tauri), so it is unit-tested here in the hot-path
//! crate and reused by the desktop `apply_patch` command.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone)]
enum FileOp {
    Write {
        path: PathBuf,
        content: Vec<u8>,
        /// Unix mode bits to force onto the written file, when the caller knows
        /// them. `None` means "inherit whatever the target already has", which is
        /// the right default for an ordinary overwrite.
        mode: Option<u32>,
    },
    Delete {
        path: PathBuf,
    },
}

impl FileOp {
    fn path(&self) -> &Path {
        match self {
            FileOp::Write { path, .. } => path,
            FileOp::Delete { path } => path,
        }
    }
}

/// The error returned when a transaction cannot be committed. `path` names the
/// operation that failed; the workspace has been rolled back to its prior state.
#[derive(Debug)]
pub struct TransactionError {
    pub path: PathBuf,
    pub source: io::Error,
}

impl std::fmt::Display for TransactionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "transaction failed at {}: {}",
            self.path.display(),
            self.source
        )
    }
}

impl std::error::Error for TransactionError {}

/// Outcome of a successful commit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommitResult {
    pub written: usize,
    pub deleted: usize,
}

/// A path's prior state: `Some(bytes)` if it existed, `None` if it did not.
struct Backup {
    path: PathBuf,
    original: Option<Vec<u8>>,
    permissions: Option<fs::Permissions>,
}

/// A staged, all-or-nothing set of filesystem operations.
#[derive(Default)]
pub struct Transaction {
    ops: Vec<FileOp>,
}

impl Transaction {
    pub fn new() -> Self {
        Self { ops: Vec::new() }
    }

    /// Stage a write (create or overwrite) of `path` with `content`.
    pub fn add_write(&mut self, path: impl Into<PathBuf>, content: impl Into<Vec<u8>>) {
        self.ops.push(FileOp::Write {
            path: path.into(),
            content: content.into(),
            mode: None,
        });
    }

    /// Stage a write that also forces the file's Unix mode bits.
    ///
    /// Needed by checkpoint rollback and by nothing else: restoring a *deleted*
    /// file means recreating a path that does not exist, so there is no target to
    /// inherit permissions from, and an executable script restored as `0644` is a
    /// rollback that did not finish (see `checkpoint::CheckpointStore`). Ignored on
    /// platforms with no Unix mode bits.
    pub fn add_write_with_mode(
        &mut self,
        path: impl Into<PathBuf>,
        content: impl Into<Vec<u8>>,
        mode: Option<u32>,
    ) {
        self.ops.push(FileOp::Write {
            path: path.into(),
            content: content.into(),
            mode,
        });
    }

    /// Stage a delete of `path` (a missing target is a no-op at commit time).
    pub fn add_delete(&mut self, path: impl Into<PathBuf>) {
        self.ops.push(FileOp::Delete { path: path.into() });
    }

    pub fn len(&self) -> usize {
        self.ops.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ops.is_empty()
    }

    /// Apply every staged op atomically. On any failure, roll back all applied
    /// changes from the in-memory backup and return the failing path; the
    /// workspace is left exactly as it was before the commit.
    pub fn commit(&self) -> Result<CommitResult, TransactionError> {
        // Phase 0 — snapshot the prior state of every touched path. A read error
        // that is not "not found" aborts before any change (so an unreadable
        // file is never mistaken for absent and deleted on rollback).
        let mut backups: Vec<Backup> = Vec::with_capacity(self.ops.len());
        for op in &self.ops {
            let path = op.path();
            let (original, permissions) = match fs::read(path) {
                Ok(bytes) => {
                    let permissions = fs::metadata(path)
                        .map_err(|source| TransactionError {
                            path: path.to_path_buf(),
                            source,
                        })?
                        .permissions();
                    (Some(bytes), Some(permissions))
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => (None, None),
                Err(e) => {
                    return Err(TransactionError {
                        path: path.to_path_buf(),
                        source: e,
                    })
                }
            };
            backups.push(Backup {
                path: path.to_path_buf(),
                original,
                permissions,
            });
        }

        // Phase 1 — write each content to a temp file in the same directory. No
        // final path is touched yet, so a failure here is trivially atomic.
        let mut temps: Vec<(PathBuf, PathBuf)> = Vec::new(); // (temp, final)
        let mut created_dirs: Vec<PathBuf> = Vec::new();
        for op in &self.ops {
            if let FileOp::Write {
                path,
                content,
                mode,
            } = op
            {
                if let Some(parent) = path.parent() {
                    if !parent.as_os_str().is_empty() {
                        if let Err(e) = create_parent_dirs(parent, &mut created_dirs) {
                            cleanup_temps(&temps);
                            cleanup_created_dirs(&created_dirs);
                            return Err(TransactionError {
                                path: path.clone(),
                                source: e,
                            });
                        }
                    }
                }
                let temp = temp_path(path);
                if let Err(e) = fs::write(&temp, content) {
                    cleanup_temps(&temps);
                    cleanup_created_dirs(&created_dirs);
                    return Err(TransactionError {
                        path: path.clone(),
                        source: e,
                    });
                }
                // An explicit mode wins; otherwise the existing target's permissions are inherited,
                // which is the prior behaviour and the right one for an overwrite.
                if let Err(e) = apply_mode(&temp, path, *mode) {
                    let _ = fs::remove_file(&temp);
                    cleanup_temps(&temps);
                    cleanup_created_dirs(&created_dirs);
                    return Err(TransactionError {
                        path: path.clone(),
                        source: e,
                    });
                }
                temps.push((temp, path.clone()));
            }
        }

        // Phase 2 — rename temps into place, then apply deletes. Any failure
        // restores the full backup set (undoing renames + deletes) and removes
        // leftover temps.
        let mut written = 0usize;
        let mut deleted = 0usize;
        for (temp, final_path) in &temps {
            if let Err(e) = replace_temp(temp, final_path) {
                restore(&backups);
                cleanup_temps(&temps);
                cleanup_created_dirs(&created_dirs);
                return Err(TransactionError {
                    path: final_path.clone(),
                    source: e,
                });
            }
            written += 1;
        }
        for op in &self.ops {
            if let FileOp::Delete { path } = op {
                match fs::remove_file(path) {
                    Ok(()) => deleted += 1,
                    Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                    Err(e) => {
                        restore(&backups);
                        cleanup_temps(&temps);
                        cleanup_created_dirs(&created_dirs);
                        return Err(TransactionError {
                            path: path.clone(),
                            source: e,
                        });
                    }
                }
            }
        }
        Ok(CommitResult { written, deleted })
    }
}

/// Give `temp` the permissions the final file should have.
///
/// An explicit `mode` is used when the caller has one — a rollback restoring a deleted file knows the
/// bits and has no target to read them from. Otherwise the existing target's permissions are inherited,
/// so an ordinary overwrite does not silently reset a file's mode.
#[cfg(unix)]
fn apply_mode(temp: &Path, target: &Path, mode: Option<u32>) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    if let Some(bits) = mode {
        return fs::set_permissions(temp, fs::Permissions::from_mode(bits));
    }
    if let Ok(metadata) = fs::metadata(target) {
        return fs::set_permissions(temp, metadata.permissions());
    }
    Ok(())
}

/// The same, on a platform with no Unix mode bits: inherit where possible, ignore an explicit mode.
#[cfg(not(unix))]
fn apply_mode(temp: &Path, target: &Path, _mode: Option<u32>) -> io::Result<()> {
    if let Ok(metadata) = fs::metadata(target) {
        return fs::set_permissions(temp, metadata.permissions());
    }
    Ok(())
}

fn replace_temp(temp: &Path, target: &Path) -> io::Result<()> {
    match fs::rename(temp, target) {
        Ok(()) => Ok(()),
        Err(first_error) if target.exists() => {
            // Unix rename replaces atomically; Windows requires the existing
            // destination to be removed first. Any subsequent error is handled
            // by the transaction's full backup restoration.
            fs::remove_file(target)?;
            fs::rename(temp, target).map_err(|second_error| {
                io::Error::new(
                    second_error.kind(),
                    format!("{first_error}; replacement retry failed: {second_error}"),
                )
            })
        }
        Err(error) => Err(error),
    }
}

fn create_parent_dirs(parent: &Path, created_dirs: &mut Vec<PathBuf>) -> io::Result<()> {
    let mut cursor = parent;
    let mut missing = Vec::new();
    while !cursor.exists() {
        missing.push(cursor.to_path_buf());
        cursor = cursor.parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "path has no existing ancestor")
        })?;
    }
    fs::create_dir_all(parent)?;
    created_dirs.extend(missing);
    Ok(())
}

fn cleanup_created_dirs(created_dirs: &[PathBuf]) {
    let mut deepest_first = created_dirs.to_vec();
    deepest_first.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    deepest_first.dedup();
    for path in deepest_first {
        // remove_dir intentionally removes only empty directories, so this can
        // never erase unrelated content created concurrently.
        let _ = fs::remove_dir(path);
    }
}

fn cleanup_temps(temps: &[(PathBuf, PathBuf)]) {
    for (temp, _) in temps {
        let _ = fs::remove_file(temp);
    }
}

/// Restore every backed-up path to its prior state (content, or absence).
fn restore(backups: &[Backup]) {
    for backup in backups {
        match &backup.original {
            Some(bytes) => {
                if let Some(parent) = backup.path.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                let _ = fs::write(&backup.path, bytes);
                if let Some(permissions) = &backup.permissions {
                    let _ = fs::set_permissions(&backup.path, permissions.clone());
                }
            }
            None => {
                let _ = fs::remove_file(&backup.path);
            }
        }
    }
}

fn temp_path(target: &Path) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let base = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let temp_name = format!(".{base}.zoc_tmp_{nanos}_{counter}");
    match target.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.join(temp_name),
        _ => PathBuf::from(temp_name),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("zoc_tx_test_{nanos}_{counter}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn commit_applies_multiple_writes_atomically() {
        let dir = tmpdir();
        let mut tx = Transaction::new();
        tx.add_write(dir.join("a.txt"), b"alpha".to_vec());
        tx.add_write(dir.join("b.txt"), b"beta".to_vec());
        let result = tx.commit().unwrap();
        assert_eq!(
            result,
            CommitResult {
                written: 2,
                deleted: 0
            }
        );
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "alpha");
        assert_eq!(fs::read_to_string(dir.join("b.txt")).unwrap(), "beta");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn commit_creates_missing_parents_and_overwrites() {
        let dir = tmpdir();
        fs::write(dir.join("x.txt"), b"old").unwrap();
        let mut tx = Transaction::new();
        tx.add_write(dir.join("sub/deep/f.txt"), b"nested".to_vec());
        tx.add_write(dir.join("x.txt"), b"new".to_vec());
        tx.commit().unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("sub/deep/f.txt")).unwrap(),
            "nested"
        );
        assert_eq!(fs::read_to_string(dir.join("x.txt")).unwrap(), "new"); // overwritten
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn commit_deletes_files_and_ignores_missing() {
        let dir = tmpdir();
        fs::write(dir.join("gone.txt"), b"bye").unwrap();
        let mut tx = Transaction::new();
        tx.add_delete(dir.join("gone.txt"));
        tx.add_delete(dir.join("never-existed.txt")); // no-op, not an error
        let result = tx.commit().unwrap();
        assert_eq!(result.deleted, 1);
        assert!(!dir.join("gone.txt").exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn failed_operation_leaves_workspace_unchanged() {
        let dir = tmpdir();
        fs::write(dir.join("keep.txt"), b"original").unwrap();
        fs::write(dir.join("blocker"), b"i am a file").unwrap(); // a file, not a dir
        let mut tx = Transaction::new();
        tx.add_write(dir.join("keep.txt"), b"modified".to_vec()); // staged first
                                                                  // parent "blocker" is a regular file → create_dir_all fails → the whole
                                                                  // transaction aborts and applies nothing.
        tx.add_write(dir.join("blocker/child.txt"), b"nope".to_vec());
        let err = tx.commit().unwrap_err();
        assert!(err.path.ends_with("child.txt"));
        // All-or-nothing: the earlier write was NOT applied.
        assert_eq!(
            fs::read_to_string(dir.join("keep.txt")).unwrap(),
            "original"
        );
        assert!(!dir.join("blocker/child.txt").exists());
        assert_eq!(
            fs::read_to_string(dir.join("blocker")).unwrap(),
            "i am a file"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn delete_failure_rolls_back_renames_and_created_directories() {
        let dir = tmpdir();
        fs::write(dir.join("keep.txt"), b"original").unwrap();
        let mut tx = Transaction::new();
        tx.add_write(dir.join("keep.txt"), b"modified".to_vec());
        tx.add_write(dir.join("new/deep/child.txt"), b"created".to_vec());
        // Removing a directory with remove_file fails after both staged writes
        // have already been renamed, forcing the full phase-two rollback.
        tx.add_delete(dir.join("new"));

        let err = tx.commit().unwrap_err();
        assert!(err.path.ends_with("new"));
        assert_eq!(
            fs::read_to_string(dir.join("keep.txt")).unwrap(),
            "original"
        );
        assert!(!dir.join("new").exists());
        assert!(!fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains("zoc_tmp")));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn empty_transaction_commits_cleanly() {
        let tx = Transaction::new();
        assert!(tx.is_empty());
        assert_eq!(
            tx.commit().unwrap(),
            CommitResult {
                written: 0,
                deleted: 0
            }
        );
    }
}
