//! Validation/check runner (develop.md Phase 5).
//!
//! Runs a *known* checker (never an arbitrary command) inside the workspace and
//! returns its raw output for the frontend to parse with a problem matcher. The
//! `kind` is an allow-listed enum, and the optional `cwd` is validated to stay
//! inside the workspace, so this can't be used to execute arbitrary binaries or
//! escape the workspace.

use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use serde::Serialize;

use crate::workspace::{ensure_within_workspace, WorkspaceState};

#[derive(Serialize, Debug, Clone)]
pub struct CheckResult {
    pub kind: String,
    pub stdout: String,
    pub stderr: String,
    /// Process exit code (checkers exit non-zero when they find problems —
    /// that is expected, not an error).
    pub code: i32,
}

/// Map an allow-listed kind to its argv. Returns None for unknown kinds.
fn argv_for(kind: &str) -> Option<(&'static str, Vec<&'static str>)> {
    match kind {
        "tsc" => Some(("npx", vec!["--no-install", "tsc", "--noEmit", "--pretty", "false"])),
        "eslint" => Some(("npx", vec!["--no-install", "eslint", ".", "-f", "stylish"])),
        "ruff" => Some(("ruff", vec!["check"])),
        "cargo" => Some(("cargo", vec!["check", "--message-format=short", "-q"])),
        _ => None,
    }
}

#[tauri::command]
pub fn run_check(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    kind: String,
    cwd: Option<String>,
) -> Result<CheckResult, String> {
    let (bin, args) = argv_for(&kind).ok_or_else(|| format!("unknown check kind: {kind}"))?;

    // Resolve the working directory: workspace root, or a validated subdir.
    let dir = match &cwd {
        Some(rel) if !rel.trim().is_empty() => ensure_within_workspace(&workspace, Path::new(rel))?,
        _ => workspace
            .get()
            .ok_or_else(|| "no workspace root configured".to_string())?,
    };

    let out = Command::new(bin)
        .args(&args)
        .current_dir(&dir)
        .output()
        .map_err(|e| format!("could not run {bin}: {e}"))?;

    Ok(CheckResult {
        kind,
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        code: out.status.code().unwrap_or(-1),
    })
}

#[derive(Serialize, Debug, Clone)]
pub struct TaskResult {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

/// Run a user-defined task command inside the workspace. The command comes from
/// the project's own tasks.json / package scripts / manifests (i.e. the user's
/// own config), and the working directory is validated to stay inside the
/// workspace. Output is captured and returned (blocking).
#[tauri::command]
pub fn run_task(
    workspace: tauri::State<'_, Arc<WorkspaceState>>,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<TaskResult, String> {
    if command.trim().is_empty() {
        return Err("task command is empty".into());
    }
    let dir = match &cwd {
        Some(rel) if !rel.trim().is_empty() => ensure_within_workspace(&workspace, Path::new(rel))?,
        _ => workspace
            .get()
            .ok_or_else(|| "no workspace root configured".to_string())?,
    };
    let out = Command::new(&command)
        .args(&args)
        .current_dir(&dir)
        .output()
        .map_err(|e| format!("could not run {command}: {e}"))?;
    Ok(TaskResult {
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        code: out.status.code().unwrap_or(-1),
    })
}
