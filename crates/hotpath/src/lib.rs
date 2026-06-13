//! Hot-path crate. Owns the latency-sensitive primitives that FastAPI calls
//! into via the bundled CLI: PTY spawning, file-system watching, code
//! indexing/chunking, ripgrep-style search, and fuzzy patch application.

pub mod chunker;
pub mod fs_watch;
pub mod indexer;
pub mod patch;
pub mod pty;
pub mod search;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
