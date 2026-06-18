//! Thin CLI wrapping the hot-path primitives. Invoked by FastAPI when a
//! hot operation is needed; output is JSON on stdout for cheap parsing.
//!
//! Convention: every leaf command prints either
//!   * a single JSON object `{ "ok": true, "data": ... }`, or
//!   * a stream of JSON-line events (one event per line), terminated by EOF.

use anyhow::Result;
use clap::{Parser, Subcommand};
use zoc_studio_hotpath::{chunker, fs_watch, indexer, patch, pty, search, VERSION};
use serde::Serialize;
use std::time::Duration;

#[derive(Parser, Debug)]
#[command(name = "zoc-studio-hotpath", version = VERSION)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// Print the crate version.
    Version,
    /// Workspace walker.
    Index {
        #[command(subcommand)]
        sub: IndexCmd,
    },
    /// Filesystem watcher.
    Watch {
        #[command(subcommand)]
        sub: WatchCmd,
    },
    /// Ripgrep-style text search.
    Search {
        path: String,
        #[arg(long)]
        pattern: String,
        #[arg(long, default_value_t = false)]
        ignore_case: bool,
        #[arg(long)]
        max: Option<usize>,
    },
    /// Line-based code chunker.
    Chunk {
        path: String,
        #[arg(long)]
        target_lines: Option<usize>,
    },
    /// PTY primitives.
    Pty {
        #[command(subcommand)]
        sub: PtyCmd,
    },
    /// Apply a unified diff patch with fuzzy matching.
    ApplyPatch {
        /// Path to the file to patch
        file: String,
        /// The unified diff to apply (or read from stdin if not provided)
        #[arg(long)]
        diff: Option<String>,
        /// Maximum line offset to search for hunk context (0 = strict, 3 = recommended)
        #[arg(long, default_value_t = 3)]
        fuzz: u32,
    },
}

#[derive(Subcommand, Debug)]
enum IndexCmd {
    /// Count files under a directory.
    Count { path: String },
    /// Walk a directory and emit a JSON file list.
    Walk {
        path: String,
        #[arg(long)]
        max: Option<usize>,
    },
}

#[derive(Subcommand, Debug)]
enum WatchCmd {
    /// Probe whether a path is watchable.
    Probe { path: String },
    /// Watch recursively, streaming events as JSON lines.
    Run {
        path: String,
        #[arg(long)]
        duration_ms: Option<u64>,
    },
}

#[derive(Subcommand, Debug)]
enum PtyCmd {
    /// Describe a PTY spec (debug).
    Describe {
        #[arg(long)]
        cmd: String,
        #[arg(long, num_args = 0..)]
        args: Vec<String>,
    },
    /// Run a command in a PTY to completion, capturing combined output.
    Run {
        #[arg(long)]
        cmd: String,
        #[arg(long, num_args = 0..)]
        args: Vec<String>,
        #[arg(long)]
        cwd: Option<String>,
        #[arg(long, default_value_t = 120)]
        cols: u16,
        #[arg(long, default_value_t = 32)]
        rows: u16,
        #[arg(long)]
        timeout_ms: Option<u64>,
    },
    /// Spawn a command in a PTY and stream JSON-line events.
    Spawn {
        #[arg(long)]
        cmd: String,
        #[arg(long, num_args = 0..)]
        args: Vec<String>,
        #[arg(long)]
        cwd: Option<String>,
        #[arg(long, default_value_t = 120)]
        cols: u16,
        #[arg(long, default_value_t = 32)]
        rows: u16,
    },
}

#[derive(Serialize)]
struct JsonOk<T: Serialize> {
    ok: bool,
    data: T,
}

fn ok<T: Serialize>(data: T) -> Result<()> {
    println!("{}", serde_json::to_string(&JsonOk { ok: true, data })?);
    Ok(())
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "warn".into()),
        )
        .init();

    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Version => ok(VERSION)?,
        Cmd::Index { sub } => match sub {
            IndexCmd::Count { path } => ok(indexer::count_files(&path)?)?,
            IndexCmd::Walk { path, max } => ok(indexer::walk(&path, max)?)?,
        },
        Cmd::Watch { sub } => match sub {
            WatchCmd::Probe { path } => ok(fs_watch::probe(&path)?)?,
            WatchCmd::Run { path, duration_ms } => {
                fs_watch::run(&path, duration_ms.map(Duration::from_millis))?;
            }
        },
        Cmd::Search {
            path,
            pattern,
            ignore_case,
            max,
        } => ok(search::search(&path, &pattern, ignore_case, max)?)?,
        Cmd::Chunk { path, target_lines } => ok(chunker::chunk_file(&path, target_lines)?)?,
        Cmd::Pty { sub } => match sub {
            PtyCmd::Describe { cmd, args } => {
                let spec = pty::PtySpec {
                    cmd,
                    args,
                    cwd: None,
                    cols: 80,
                    rows: 24,
                };
                ok(pty::describe(&spec)?)?
            }
            PtyCmd::Run {
                cmd,
                args,
                cwd,
                cols,
                rows,
                timeout_ms,
            } => {
                let spec = pty::PtySpec {
                    cmd,
                    args,
                    cwd,
                    cols,
                    rows,
                };
                let (stdout, code) =
                    pty::run(&spec, timeout_ms.map(Duration::from_millis))?;
                ok(serde_json::json!({ "stdout": stdout, "exit_code": code }))?
            }
            PtyCmd::Spawn {
                cmd,
                args,
                cwd,
                cols,
                rows,
            } => {
                let spec = pty::PtySpec {
                    cmd,
                    args,
                    cwd,
                    cols,
                    rows,
                };
                pty::spawn_streaming(&spec)?;
            }
        },
        Cmd::ApplyPatch { file, diff, fuzz } => {
            use std::io::Read;
            
            // Read the original file
            let original = std::fs::read_to_string(&file)
                .unwrap_or_default();
            
            // Read diff from arg or stdin
            let diff_content = if let Some(d) = diff {
                d
            } else {
                let mut buf = String::new();
                std::io::stdin().read_to_string(&mut buf)?;
                buf
            };
            
            // Apply the patch
            let result = patch::apply_unified_fuzzy(&original, &diff_content, fuzz);
            
            // Output JSON result
            ok(result)?
        },
    }
    Ok(())
}
