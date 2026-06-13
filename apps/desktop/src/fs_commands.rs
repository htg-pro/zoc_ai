//! Workspace filesystem commands. The frontend uses these instead of the raw
//! `tauri-plugin-fs` API because we (a) restrict every operation to the
//! active workspace root via `WorkspaceState`, (b) hand back a richer
//! `FileNode` tree shape, and (c) own the file-watcher channel that drives
//! Monaco's "disk-truth" refresh.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};

use crate::workspace::{ensure_within_workspace, WorkspaceState};

#[derive(Default)]
pub struct WatcherState {
    debouncer: Mutex<Option<Debouncer<notify::RecommendedWatcher>>>,
    root: Mutex<Option<PathBuf>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub kind: String, // "file" | "dir"
    pub children: Option<Vec<FileNode>>,
}

const IGNORED: &[&str] = &[
    ".git", "node_modules", "target", "dist", ".venv", ".pythonlibs",
    "__pycache__", ".next", ".cache", ".local", ".pnpm-store",
];

fn ignored(name: &str) -> bool {
    IGNORED.contains(&name)
}

fn list(root: &Path, depth: usize) -> std::io::Result<Vec<FileNode>> {
    if depth == 0 {
        return Ok(vec![]);
    }
    let mut out: Vec<FileNode> = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if ignored(&name) { continue; }
        let path = entry.path();
        let path_s = path.to_string_lossy().into_owned();
        if ft.is_dir() {
            let children = list(&path, depth - 1).unwrap_or_default();
            out.push(FileNode { name, path: path_s, kind: "dir".into(), children: Some(children) });
        } else if ft.is_file() {
            out.push(FileNode { name, path: path_s, kind: "file".into(), children: None });
        }
    }
    out.sort_by(|a, b| match (a.kind.as_str(), b.kind.as_str()) {
        ("dir", "file") => std::cmp::Ordering::Less,
        ("file", "dir") => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

#[tauri::command]
pub fn fs_list_dir(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    root: String,
    depth: Option<usize>,
) -> Result<Vec<FileNode>, String> {
    let resolved = ensure_within_workspace(&workspace, Path::new(&root))?;
    list(&resolved, depth.unwrap_or(5)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_read_text(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    path: String,
) -> Result<String, String> {
    let resolved = ensure_within_workspace(&workspace, Path::new(&path))?;
    std::fs::read_to_string(&resolved).map_err(|e| format!("read {}: {e}", resolved.display()))
}

#[tauri::command]
pub fn fs_write_text(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    path: String,
    content: String,
) -> Result<(), String> {
    let resolved = ensure_within_workspace(&workspace, Path::new(&path))?;
    if let Some(parent) = resolved.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&resolved, content).map_err(|e| format!("write {}: {e}", resolved.display()))
}

#[tauri::command]
pub fn fs_watch_start<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, Arc<WatcherState>>,
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    root: String,
) -> Result<(), String> {
    let resolved = ensure_within_workspace(&workspace, Path::new(&root))?;

    state.debouncer.lock().take();

    let app_clone = app.clone();
    let mut debouncer = new_debouncer(Duration::from_millis(250), move |res: DebounceEventResult| {
        if let Ok(events) = res {
            let paths: Vec<String> = events
                .into_iter()
                .map(|e| e.path.to_string_lossy().into_owned())
                .collect();
            if !paths.is_empty() {
                let _ = app_clone.emit("fs://changed", paths);
            }
        }
    })
    .map_err(|e| e.to_string())?;

    debouncer
        .watcher()
        .watch(&resolved, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    *state.debouncer.lock() = Some(debouncer);
    *state.root.lock() = Some(resolved);
    Ok(())
}

#[tauri::command]
pub fn fs_watch_stop(state: tauri::State<'_, Arc<WatcherState>>) -> Result<(), String> {
    state.debouncer.lock().take();
    state.root.lock().take();
    Ok(())
}
