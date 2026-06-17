//! Workspace text search & replace (develop.md Phase 3).
//!
//! Thin Tauri command layer over the hot-path search engine
//! (`llama_studio_hotpath::search`). Every command validates the active
//! workspace root (and, for replace, each targeted path) so a renderer can't
//! search or rewrite files outside the user's chosen workspace.

use std::path::Path;
use std::sync::Arc;

use llama_studio_hotpath::search::{
    grep, replace_apply, replace_preview, FileReplace, ReplaceOptions, ReplaceSummary,
    SearchOptions, SearchResults,
};

use crate::workspace::{ensure_within_workspace, WorkspaceState};

#[tauri::command]
pub fn fs_search(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    options: SearchOptions,
) -> Result<SearchResults, String> {
    if options.query.trim().is_empty() {
        return Ok(SearchResults {
            files: vec![],
            total: 0,
            truncated: false,
        });
    }
    let root = workspace
        .get()
        .ok_or_else(|| "no workspace root configured".to_string())?;
    let root = std::fs::canonicalize(&root).map_err(|e| format!("workspace root invalid: {e}"))?;
    grep(&root, &options, None).map_err(|e| e.to_string())
}

/// Confirm the optional `paths` subset stays inside the workspace.
fn validate_paths(workspace: &WorkspaceState, opts: &ReplaceOptions) -> Result<(), String> {
    if let Some(paths) = &opts.paths {
        for p in paths {
            ensure_within_workspace(workspace, Path::new(p))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn fs_replace_preview(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    options: ReplaceOptions,
) -> Result<Vec<FileReplace>, String> {
    if options.search.query.trim().is_empty() {
        return Ok(vec![]);
    }
    validate_paths(&workspace, &options)?;
    let root = workspace
        .get()
        .ok_or_else(|| "no workspace root configured".to_string())?;
    let root = std::fs::canonicalize(&root).map_err(|e| format!("workspace root invalid: {e}"))?;
    replace_preview(&root, &options).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_replace_apply(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    options: ReplaceOptions,
) -> Result<ReplaceSummary, String> {
    if options.search.query.trim().is_empty() {
        return Ok(ReplaceSummary {
            files: vec![],
            total_replacements: 0,
        });
    }
    validate_paths(&workspace, &options)?;
    let root = workspace
        .get()
        .ok_or_else(|| "no workspace root configured".to_string())?;
    let root = std::fs::canonicalize(&root).map_err(|e| format!("workspace root invalid: {e}"))?;
    replace_apply(&root, &options).map_err(|e| e.to_string())
}
