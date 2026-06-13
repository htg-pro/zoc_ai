//! Filesystem watcher. `run` watches a path recursively and streams
//! JSON-line events to stdout until terminated; `probe` does a one-shot
//! viability check.

use anyhow::{Context, Result};
use notify::{recommended_watcher, EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::mpsc::channel;
use std::time::Duration;

#[derive(Serialize, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FsEvent {
    Created { path: String },
    Modified { path: String },
    Removed { path: String },
    Renamed { path: String },
    Other { path: String, raw: String },
}

pub fn probe<P: AsRef<Path>>(root: P) -> Result<String> {
    let p = root.as_ref();
    if !p.exists() {
        anyhow::bail!("path does not exist: {}", p.display());
    }
    Ok(format!("fs_watch: ready on {}", p.display()))
}

fn map_event(kind: &EventKind, paths: &[PathBuf]) -> Vec<FsEvent> {
    paths
        .iter()
        .map(|pb| {
            let path = pb.display().to_string();
            match kind {
                EventKind::Create(_) => FsEvent::Created { path },
                EventKind::Modify(notify::event::ModifyKind::Name(_)) => {
                    FsEvent::Renamed { path }
                }
                EventKind::Modify(_) => FsEvent::Modified { path },
                EventKind::Remove(_) => FsEvent::Removed { path },
                other => FsEvent::Other {
                    path,
                    raw: format!("{other:?}"),
                },
            }
        })
        .collect()
}

/// Run a recursive watcher, streaming events as JSON lines. If `duration`
/// is set, exits after that long (useful for tests and short-lived probes).
pub fn run<P: AsRef<Path>>(root: P, duration: Option<Duration>) -> Result<()> {
    let (tx, rx) = channel();
    let mut watcher =
        recommended_watcher(move |res| {
            let _ = tx.send(res);
        })
        .context("create watcher")?;
    watcher
        .watch(root.as_ref(), RecursiveMode::Recursive)
        .context("watch")?;
    let start = std::time::Instant::now();
    loop {
        let recv_timeout = duration
            .map(|d| {
                let remaining = d.saturating_sub(start.elapsed());
                remaining.max(Duration::from_millis(10))
            })
            .unwrap_or_else(|| Duration::from_secs(1));
        if let Some(d) = duration {
            if start.elapsed() >= d {
                break;
            }
        }
        match rx.recv_timeout(recv_timeout) {
            Ok(Ok(event)) => {
                for ev in map_event(&event.kind, &event.paths) {
                    if let Ok(line) = serde_json::to_string(&ev) {
                        println!("{line}");
                    }
                }
            }
            Ok(Err(e)) => eprintln!("fs_watch error: {e}"),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(_) => break,
        }
    }
    Ok(())
}
