//! Workspace walker and parallel indexer.
//!
//! Streams files (respecting `.gitignore`) for chunking and indexing by the
//! Python agent, and — for monorepos with 100k+ files — reads and chunks them
//! in parallel with `rayon` (§9.1).
//!
//! Three properties make the large-repo path affordable:
//!
//! * **Parallel reads.** [`index_workspace`] fans the candidate file list out
//!   over the rayon thread pool, so wall time is bounded by the slowest core
//!   rather than the sum of every read.
//! * **Size skipping.** Files larger than [`MAX_INDEXED_FILE_BYTES`] (1 MiB)
//!   are never read; they are reported in
//!   [`IndexOutcome::skipped_large`] so the caller can explain the omission.
//! * **An LRU read cache.** [`read_cached`] memoizes recently read file
//!   contents (capacity [`FILE_CACHE_CAPACITY`]), keyed by path and
//!   invalidated on size/mtime change, so the Python gateway can re-request a
//!   hot file without a disk round trip.
//!
//! Progress is reported through a plain [`std::sync::mpsc`] channel: one
//! [`IndexProgress`] every [`PROGRESS_EVERY`] files plus a final event with
//! `indexed == total`, which is what drives the frontend progress bar.

use anyhow::Result;
use ignore::WalkBuilder;
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

use crate::chunker::{chunk_text, Chunk};

/// Files strictly larger than this are skipped by the indexer (§9.1: "skip
/// files larger than 1MB"). 1 MiB of source is already far past the point
/// where chunk-level retrieval is useful, and minified/vendored blobs are the
/// dominant cost in large monorepos.
pub const MAX_INDEXED_FILE_BYTES: u64 = 1024 * 1024;

/// Capacity of the process-wide LRU read cache (§9.1).
pub const FILE_CACHE_CAPACITY: usize = 500;

/// Emit an [`IndexProgress`] event every this many indexed files (§9.1).
pub const PROGRESS_EVERY: usize = 1_000;

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct FileEntry {
    pub path: String,
    pub bytes: u64,
}

/// Incremental indexing progress, emitted on the caller's channel.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
pub struct IndexProgress {
    pub indexed: usize,
    pub total: usize,
}

/// One successfully indexed file and its chunks.
#[derive(Serialize, Debug, Clone)]
pub struct IndexedFile {
    pub path: String,
    pub bytes: u64,
    pub chunks: Vec<Chunk>,
}

/// A file the indexer deliberately or unavoidably did not index.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct SkippedFile {
    pub path: String,
    pub bytes: u64,
    pub reason: String,
}

/// The result of one [`index_workspace`] pass.
#[derive(Serialize, Debug, Clone, Default)]
pub struct IndexOutcome {
    /// Candidate files discovered by the walker (the progress denominator).
    pub total: usize,
    /// Files actually read and chunked.
    pub indexed: usize,
    /// Files skipped because they exceed [`MAX_INDEXED_FILE_BYTES`].
    pub skipped_large: Vec<SkippedFile>,
    /// Files that could not be read as UTF-8 text (binaries, permissions…).
    pub failed: Vec<SkippedFile>,
    /// Indexed files, sorted by path for deterministic output.
    pub files: Vec<IndexedFile>,
}

/// Tunables for one indexing pass.
#[derive(Debug, Clone, Copy)]
pub struct IndexOptions {
    /// Stop after this many candidate files (`None` = whole tree).
    pub max_files: Option<usize>,
    /// Target lines per chunk; `None` uses the chunker default.
    pub target_lines: Option<usize>,
    /// Skip files larger than this many bytes.
    pub max_file_bytes: u64,
    /// When false, files are read (populating the cache) but not chunked.
    pub emit_chunks: bool,
}

impl Default for IndexOptions {
    fn default() -> Self {
        Self {
            max_files: None,
            target_lines: None,
            max_file_bytes: MAX_INDEXED_FILE_BYTES,
            emit_chunks: true,
        }
    }
}

pub fn count_files<P: AsRef<Path>>(root: P) -> Result<usize> {
    let mut n = 0usize;
    for entry in WalkBuilder::new(root).hidden(false).build().flatten() {
        if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            n += 1;
        }
    }
    Ok(n)
}

pub fn walk<P: AsRef<Path>>(root: P, max: Option<usize>) -> Result<Vec<FileEntry>> {
    let mut out = Vec::new();
    for entry in WalkBuilder::new(root).hidden(false).build().flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
        out.push(FileEntry {
            path: entry.path().display().to_string(),
            bytes,
        });
        if let Some(m) = max {
            if out.len() >= m {
                break;
            }
        }
    }
    Ok(out)
}

/// Read and chunk every file under `root` in parallel (§9.1).
///
/// The walk itself is sequential (it is I/O-bound on directory metadata and
/// must respect `.gitignore` ordering), then the resulting file list is
/// processed with `files.par_iter()` so reads and chunking saturate the
/// available cores.
///
/// Files above `opts.max_file_bytes` are recorded in
/// [`IndexOutcome::skipped_large`] without being opened. Unreadable or
/// non-UTF-8 files land in [`IndexOutcome::failed`]; they never abort the pass,
/// because one vendored binary must not fail an entire monorepo index.
///
/// When `progress` is supplied, an [`IndexProgress`] is sent every
/// [`PROGRESS_EVERY`] completed files and once more at the end, so a
/// subscriber always observes a terminal `indexed == total` event. A closed
/// receiver is ignored: progress reporting is best-effort and never fails the
/// index.
pub fn index_workspace<P: AsRef<Path>>(
    root: P,
    opts: IndexOptions,
    progress: Option<&Sender<IndexProgress>>,
) -> Result<IndexOutcome> {
    let candidates = walk(root, opts.max_files)?;
    let total = candidates.len();
    let done = AtomicUsize::new(0);

    let results: Vec<FileOutcome> = candidates
        .par_iter()
        .map(|entry| {
            let outcome = read_and_chunk(entry, &opts);
            let completed = done.fetch_add(1, Ordering::Relaxed) + 1;
            if completed % PROGRESS_EVERY == 0 {
                report(progress, completed, total);
            }
            outcome
        })
        .collect();

    // Always finish on a terminal event so a subscriber can close its bar even
    // when the file count is not a multiple of PROGRESS_EVERY.
    report(progress, total, total);

    let mut out = IndexOutcome {
        total,
        ..IndexOutcome::default()
    };
    for result in results {
        match result {
            FileOutcome::Indexed(file) => {
                out.indexed += 1;
                out.files.push(file);
            }
            FileOutcome::TooLarge(skipped) => out.skipped_large.push(skipped),
            FileOutcome::Failed(skipped) => out.failed.push(skipped),
        }
    }
    out.files.sort_by(|a, b| a.path.cmp(&b.path));
    out.skipped_large.sort_by(|a, b| a.path.cmp(&b.path));
    out.failed.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

enum FileOutcome {
    Indexed(IndexedFile),
    TooLarge(SkippedFile),
    Failed(SkippedFile),
}

fn report(progress: Option<&Sender<IndexProgress>>, indexed: usize, total: usize) {
    if let Some(tx) = progress {
        // A dropped receiver is not an error: progress is advisory.
        let _ = tx.send(IndexProgress { indexed, total });
    }
}

fn read_and_chunk(entry: &FileEntry, opts: &IndexOptions) -> FileOutcome {
    if entry.bytes > opts.max_file_bytes {
        return FileOutcome::TooLarge(SkippedFile {
            path: entry.path.clone(),
            bytes: entry.bytes,
            reason: format!("larger than {} bytes", opts.max_file_bytes),
        });
    }
    match read_cached(&entry.path) {
        Ok(text) => {
            let chunks = if opts.emit_chunks {
                chunk_text(&entry.path, &text, opts.target_lines)
            } else {
                Vec::new()
            };
            FileOutcome::Indexed(IndexedFile {
                path: entry.path.clone(),
                bytes: entry.bytes,
                chunks,
            })
        }
        Err(err) => FileOutcome::Failed(SkippedFile {
            path: entry.path.clone(),
            bytes: entry.bytes,
            reason: err.to_string(),
        }),
    }
}

// ── LRU read cache ──────────────────────────────────────────────────────────

/// Identity of a cached file version. A size or mtime change invalidates the
/// entry, so the cache can never hand back stale content after an edit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileVersion {
    len: u64,
    modified: Option<SystemTime>,
}

struct CacheSlot {
    version: FileVersion,
    content: Arc<str>,
    /// Monotonic access stamp; the smallest stamp is evicted first.
    used: u64,
}

/// Bounded, least-recently-used cache of file contents.
///
/// Recency is tracked with a monotonic counter rather than an intrusive list:
/// eviction is a linear scan over at most [`FILE_CACHE_CAPACITY`] entries,
/// which is cheaper in practice than maintaining a list and keeps the
/// implementation dependency-free and easy to verify.
pub struct FileCache {
    capacity: usize,
    clock: u64,
    hits: u64,
    misses: u64,
    entries: HashMap<PathBuf, CacheSlot>,
}

/// Snapshot of cache occupancy and hit/miss counters.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
pub struct CacheStats {
    pub len: usize,
    pub capacity: usize,
    pub hits: u64,
    pub misses: u64,
}

impl FileCache {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            clock: 0,
            hits: 0,
            misses: 0,
            entries: HashMap::new(),
        }
    }

    pub fn stats(&self) -> CacheStats {
        CacheStats {
            len: self.entries.len(),
            capacity: self.capacity,
            hits: self.hits,
            misses: self.misses,
        }
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.hits = 0;
        self.misses = 0;
    }

    fn get(&mut self, path: &Path, version: FileVersion) -> Option<Arc<str>> {
        let stamp = {
            self.clock += 1;
            self.clock
        };
        let slot = self.entries.get_mut(path)?;
        if slot.version != version {
            // Stale: the file changed under us. Drop it so the caller re-reads.
            self.entries.remove(path);
            self.misses += 1;
            return None;
        }
        slot.used = stamp;
        self.hits += 1;
        Some(Arc::clone(&slot.content))
    }

    fn insert(&mut self, path: PathBuf, version: FileVersion, content: Arc<str>) {
        self.clock += 1;
        let used = self.clock;
        self.misses += 1;
        self.entries.insert(
            path,
            CacheSlot {
                version,
                content,
                used,
            },
        );
        while self.entries.len() > self.capacity {
            let victim = self
                .entries
                .iter()
                .min_by_key(|(_, slot)| slot.used)
                .map(|(key, _)| key.clone());
            match victim {
                Some(key) => {
                    self.entries.remove(&key);
                }
                None => break,
            }
        }
    }
}

fn cache() -> &'static Mutex<FileCache> {
    static CACHE: OnceLock<Mutex<FileCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(FileCache::with_capacity(FILE_CACHE_CAPACITY)))
}

/// Read `path` as UTF-8 text, serving from the LRU cache when possible (§9.1).
///
/// The cache key is the path; the cache *value* is validated against the
/// file's current length and mtime, so an edited file is always re-read. A
/// poisoned cache mutex degrades to an uncached read rather than propagating a
/// panic — the cache is an optimisation, never a correctness dependency.
pub fn read_cached<P: AsRef<Path>>(path: P) -> Result<Arc<str>> {
    let path = path.as_ref();
    let version = current_version(path);

    if let Some(version) = version {
        if let Ok(mut guard) = cache().lock() {
            if let Some(hit) = guard.get(path, version) {
                return Ok(hit);
            }
        }
    }

    let content: Arc<str> = Arc::from(fs::read_to_string(path)?);

    if let Some(version) = version {
        if let Ok(mut guard) = cache().lock() {
            guard.insert(path.to_path_buf(), version, Arc::clone(&content));
        }
    }
    Ok(content)
}

/// Current occupancy/hit-rate snapshot of the process-wide read cache.
pub fn cache_stats() -> CacheStats {
    match cache().lock() {
        Ok(guard) => guard.stats(),
        Err(_) => CacheStats {
            len: 0,
            capacity: FILE_CACHE_CAPACITY,
            hits: 0,
            misses: 0,
        },
    }
}

/// Drop every cached entry (used by tests and by explicit re-index requests).
pub fn cache_clear() {
    if let Ok(mut guard) = cache().lock() {
        guard.clear();
    }
}

fn current_version(path: &Path) -> Option<FileVersion> {
    let meta = fs::metadata(path).ok()?;
    Some(FileVersion {
        len: meta.len(),
        modified: meta.modified().ok(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::mpsc::channel;
    use tempfile::tempdir;

    #[test]
    fn walk_counts_files() {
        let td = tempdir().unwrap();
        fs::write(td.path().join("a.txt"), "hi").unwrap();
        fs::create_dir(td.path().join("sub")).unwrap();
        fs::write(td.path().join("sub/b.txt"), "yo").unwrap();
        let v = walk(td.path(), None).unwrap();
        assert_eq!(v.len(), 2);
        assert_eq!(count_files(td.path()).unwrap(), 2);
    }

    #[test]
    fn index_workspace_chunks_every_file() {
        let td = tempdir().unwrap();
        fs::write(td.path().join("a.rs"), "fn alpha() {}\n").unwrap();
        fs::write(td.path().join("b.rs"), "fn beta() {}\n").unwrap();

        let out = index_workspace(td.path(), IndexOptions::default(), None).unwrap();
        assert_eq!(out.total, 2);
        assert_eq!(out.indexed, 2);
        assert!(out.skipped_large.is_empty());
        assert!(out.failed.is_empty());
        assert_eq!(out.files.len(), 2);
        assert!(out.files.iter().all(|f| !f.chunks.is_empty()));
    }

    #[test]
    fn index_workspace_skips_files_over_one_mib() {
        let td = tempdir().unwrap();
        let big = "x".repeat((MAX_INDEXED_FILE_BYTES as usize) + 1);
        fs::write(td.path().join("big.txt"), &big).unwrap();
        fs::write(td.path().join("small.txt"), "ok\n").unwrap();

        let out = index_workspace(td.path(), IndexOptions::default(), None).unwrap();
        assert_eq!(out.total, 2);
        assert_eq!(out.indexed, 1);
        assert_eq!(out.skipped_large.len(), 1);
        assert!(out.skipped_large[0].path.ends_with("big.txt"));
    }

    #[test]
    fn index_workspace_reports_terminal_progress() {
        let td = tempdir().unwrap();
        for i in 0..5 {
            fs::write(td.path().join(format!("f{i}.txt")), "hello\n").unwrap();
        }
        let (tx, rx) = channel();
        let out = index_workspace(td.path(), IndexOptions::default(), Some(&tx)).unwrap();
        drop(tx);

        let events: Vec<IndexProgress> = rx.iter().collect();
        let last = *events.last().expect("at least the terminal event");
        assert_eq!(last.indexed, out.total);
        assert_eq!(last.total, out.total);
        // Progress is monotonic and never exceeds the denominator.
        assert!(events.windows(2).all(|w| w[0].indexed <= w[1].indexed));
        assert!(events.iter().all(|e| e.indexed <= e.total));
    }

    #[test]
    fn read_cached_serves_repeat_reads_and_invalidates_on_change() {
        let td = tempdir().unwrap();
        let file = td.path().join("hot.txt");
        fs::write(&file, "first").unwrap();

        cache_clear();
        assert_eq!(&*read_cached(&file).unwrap(), "first");
        let after_first = cache_stats();
        assert_eq!(after_first.misses, 1);

        assert_eq!(&*read_cached(&file).unwrap(), "first");
        assert_eq!(cache_stats().hits, 1);

        // A content change of a different length must invalidate the entry.
        fs::write(&file, "second value").unwrap();
        assert_eq!(&*read_cached(&file).unwrap(), "second value");
        cache_clear();
    }

    #[test]
    fn cache_evicts_least_recently_used_beyond_capacity() {
        let mut cache = FileCache::with_capacity(2);
        let version = FileVersion {
            len: 1,
            modified: None,
        };
        cache.insert(PathBuf::from("/a"), version, Arc::from("a"));
        cache.insert(PathBuf::from("/b"), version, Arc::from("b"));
        // Touch /a so /b becomes the least recently used entry.
        assert!(cache.get(Path::new("/a"), version).is_some());
        cache.insert(PathBuf::from("/c"), version, Arc::from("c"));

        assert_eq!(cache.stats().len, 2);
        assert!(cache.entries.contains_key(Path::new("/a")));
        assert!(cache.entries.contains_key(Path::new("/c")));
        assert!(!cache.entries.contains_key(Path::new("/b")));
    }

    #[test]
    fn cache_never_exceeds_capacity() {
        let mut cache = FileCache::with_capacity(8);
        let version = FileVersion {
            len: 1,
            modified: None,
        };
        for i in 0..200 {
            cache.insert(PathBuf::from(format!("/f{i}")), version, Arc::from("x"));
            assert!(cache.stats().len <= 8);
        }
    }
}
