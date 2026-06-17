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

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileStat {
    pub exists: bool,
    pub is_dir: bool,
    pub is_file: bool,
    pub size: u64,
    /// Last-modified time in milliseconds since the Unix epoch, when known.
    pub modified_ms: Option<u64>,
}

#[tauri::command]
pub fn fs_stat(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    path: String,
) -> Result<FileStat, String> {
    let resolved = ensure_within_workspace(&workspace, Path::new(&path))?;
    match std::fs::metadata(&resolved) {
        Ok(meta) => {
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64);
            Ok(FileStat {
                exists: true,
                is_dir: meta.is_dir(),
                is_file: meta.is_file(),
                size: meta.len(),
                modified_ms,
            })
        }
        Err(_) => Ok(FileStat {
            exists: false,
            is_dir: false,
            is_file: false,
            size: 0,
            modified_ms: None,
        }),
    }
}

#[tauri::command]
pub fn fs_create_file(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    path: String,
) -> Result<String, String> {
    let resolved = ensure_within_workspace(&workspace, Path::new(&path))?;
    if resolved.exists() {
        return Err(format!("{} already exists", resolved.display()));
    }
    if let Some(parent) = resolved.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&resolved, "").map_err(|e| format!("create {}: {e}", resolved.display()))?;
    Ok(resolved.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn fs_create_dir(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    path: String,
) -> Result<String, String> {
    let resolved = ensure_within_workspace(&workspace, Path::new(&path))?;
    if resolved.exists() {
        return Err(format!("{} already exists", resolved.display()));
    }
    std::fs::create_dir_all(&resolved).map_err(|e| format!("mkdir {}: {e}", resolved.display()))?;
    Ok(resolved.to_string_lossy().into_owned())
}

/// Rename/move `from` → `to`. Both endpoints are validated against the
/// workspace so neither side can escape it. `to` must not already exist.
fn move_within(
    workspace: &WorkspaceState,
    from: &str,
    to: &str,
) -> Result<String, String> {
    let src = ensure_within_workspace(workspace, Path::new(from))?;
    if !src.exists() {
        return Err(format!("{} does not exist", src.display()));
    }
    let dst = ensure_within_workspace(workspace, Path::new(to))?;
    if dst.exists() {
        return Err(format!("{} already exists", dst.display()));
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&src, &dst)
        .map_err(|e| format!("move {} -> {}: {e}", src.display(), dst.display()))?;
    Ok(dst.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn fs_rename(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    from: String,
    to: String,
) -> Result<String, String> {
    move_within(&workspace, &from, &to)
}

#[tauri::command]
pub fn fs_move(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    from: String,
    to: String,
) -> Result<String, String> {
    move_within(&workspace, &from, &to)
}

#[tauri::command]
pub fn fs_delete(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    path: String,
) -> Result<(), String> {
    let resolved = ensure_within_workspace(&workspace, Path::new(&path))?;
    if !resolved.exists() {
        return Err(format!("{} does not exist", resolved.display()));
    }
    // Guard: never delete the workspace root itself.
    if let Some(root) = workspace.get() {
        if let Ok(root_canon) = std::fs::canonicalize(&root) {
            if resolved == root_canon {
                return Err("refusing to delete the workspace root".into());
            }
        }
    }
    let meta = std::fs::symlink_metadata(&resolved).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        std::fs::remove_dir_all(&resolved)
            .map_err(|e| format!("delete dir {}: {e}", resolved.display()))
    } else {
        std::fs::remove_file(&resolved)
            .map_err(|e| format!("delete {}: {e}", resolved.display()))
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let target = dst.join(entry.file_name());
        if ft.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else if ft.is_file() {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Compute a non-colliding "… copy" sibling path for `src`.
fn unique_copy_path(src: &Path) -> PathBuf {
    let parent = src.parent().unwrap_or_else(|| Path::new("."));
    let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = src.extension().map(|e| e.to_string_lossy().into_owned());
    let make = |suffix: String| -> PathBuf {
        let name = match &ext {
            Some(e) => format!("{stem}{suffix}.{e}"),
            None => format!("{stem}{suffix}"),
        };
        parent.join(name)
    };
    let first = make(" copy".into());
    if !first.exists() {
        return first;
    }
    let mut n = 2;
    loop {
        let candidate = make(format!(" copy {n}"));
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

#[tauri::command]
pub fn fs_duplicate(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    path: String,
) -> Result<String, String> {
    let src = ensure_within_workspace(&workspace, Path::new(&path))?;
    if !src.exists() {
        return Err(format!("{} does not exist", src.display()));
    }
    let dst = unique_copy_path(&src);
    // Validate the computed destination stays in the workspace too.
    let dst = ensure_within_workspace(&workspace, &dst)?;
    let meta = std::fs::symlink_metadata(&src).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        copy_dir_recursive(&src, &dst).map_err(|e| format!("duplicate dir: {e}"))?;
    } else {
        std::fs::copy(&src, &dst).map_err(|e| format!("duplicate: {e}"))?;
    }
    Ok(dst.to_string_lossy().into_owned())
}

/// Reveal a path in the OS file manager. Best-effort: errors from the spawned
/// helper are surfaced so the UI can fall back to copy-path.
#[tauri::command]
pub fn fs_reveal(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    path: String,
) -> Result<(), String> {
    let resolved = ensure_within_workspace(&workspace, Path::new(&path))?;
    let p = resolved.to_string_lossy().into_owned();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg("-R").arg(&p).spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer")
        .arg(format!("/select,{p}"))
        .spawn();
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let result = {
        // Linux/BSD: xdg-open has no "select" semantics, so open the parent
        // directory containing the entry.
        let dir = resolved
            .parent()
            .map(|d| d.to_string_lossy().into_owned())
            .unwrap_or(p.clone());
        std::process::Command::new("xdg-open").arg(dir).spawn()
    };
    result.map(|_| ()).map_err(|e| format!("reveal {p}: {e}"))
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::WorkspaceState;
    use std::fs;

    fn temp_ws() -> (PathBuf, WorkspaceState) {
        let base = std::env::temp_dir().join(format!(
            "zoc-fs-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&base).unwrap();
        let ws = WorkspaceState::default();
        ws.set(Some(base.clone()));
        (base, ws)
    }

    #[test]
    fn move_within_renames_inside_workspace() {
        let (base, ws) = temp_ws();
        let src = base.join("a.txt");
        fs::write(&src, "hi").unwrap();
        let dst = base.join("b.txt");
        let out = move_within(&ws, src.to_str().unwrap(), dst.to_str().unwrap()).unwrap();
        assert!(dst.exists());
        assert!(!src.exists());
        assert!(out.ends_with("b.txt"));
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn move_within_rejects_destination_outside_workspace() {
        let (base, ws) = temp_ws();
        let src = base.join("a.txt");
        fs::write(&src, "hi").unwrap();
        // Destination parent (the system temp dir) is outside the workspace root.
        let outside = std::env::temp_dir().join("zoc-escape-target.txt");
        let res = move_within(&ws, src.to_str().unwrap(), outside.to_str().unwrap());
        assert!(res.is_err(), "moving outside the workspace must be rejected");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn unique_copy_path_avoids_collisions() {
        let (base, _ws) = temp_ws();
        let f = base.join("note.md");
        fs::write(&f, "x").unwrap();
        let c1 = unique_copy_path(&f);
        assert_eq!(c1.file_name().unwrap().to_string_lossy(), "note copy.md");
        fs::write(&c1, "x").unwrap();
        let c2 = unique_copy_path(&f);
        assert_eq!(c2.file_name().unwrap().to_string_lossy(), "note copy 2.md");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn copy_dir_recursive_copies_tree() {
        let (base, _ws) = temp_ws();
        let src = base.join("src");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("a.txt"), "a").unwrap();
        fs::write(src.join("sub").join("b.txt"), "b").unwrap();
        let dst = base.join("dst");
        copy_dir_recursive(&src, &dst).unwrap();
        assert!(dst.join("a.txt").exists());
        assert!(dst.join("sub").join("b.txt").exists());
        fs::remove_dir_all(&base).ok();
    }
}
