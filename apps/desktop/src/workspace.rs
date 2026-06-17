//! Workspace + legacy-migration helpers.
//!
//! The frontend's onboarding flow asks the user to pick a workspace, then
//! we persist that choice in `~/.llama-studio/desktop.json` and check the
//! `legacy/` directory for an old Zoc AI config we can import.
//!
//! Additionally exposes a `WorkspaceState` shared via Tauri-managed state
//! holding the currently-active workspace root. All filesystem and patch
//! commands consult this state to ensure they only ever read/write inside
//! the user's chosen workspace — never anywhere else on disk.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

/// Shared, mutable handle to the active workspace root. Filesystem and
/// patch commands take this as `tauri::State` and reject any operation
/// whose target path escapes the canonicalized root.
#[derive(Default)]
pub struct WorkspaceState {
    pub root: Mutex<Option<PathBuf>>,
}

impl WorkspaceState {
    pub fn get(&self) -> Option<PathBuf> {
        self.root.lock().clone()
    }

    pub fn set(&self, p: Option<PathBuf>) {
        *self.root.lock() = p;
    }
}

/// Resolve `target` against the active workspace root and ensure the
/// resulting path stays inside it. Accepts both absolute and relative
/// inputs. For paths that don't exist yet (e.g. a file we're about to
/// create), the parent directory must exist and be inside the root.
pub fn ensure_within_workspace(
    state: &WorkspaceState,
    target: &Path,
) -> Result<PathBuf, String> {
    let root = state
        .get()
        .ok_or_else(|| "no workspace root configured".to_string())?;
    let root_canon = std::fs::canonicalize(&root)
        .map_err(|e| format!("workspace root invalid: {e}"))?;

    let joined = if target.is_absolute() {
        target.to_path_buf()
    } else {
        root_canon.join(target)
    };

    let resolved = if joined.exists() {
        std::fs::canonicalize(&joined).map_err(|e| e.to_string())?
    } else {
        // Canonicalize the parent + reattach the filename so we can validate
        // write/create paths whose final component doesn't exist yet.
        let parent = joined
            .parent()
            .ok_or_else(|| format!("bad path: {}", joined.display()))?;
        let parent_canon = std::fs::canonicalize(parent)
            .map_err(|e| format!("parent of {}: {e}", joined.display()))?;
        let name = joined
            .file_name()
            .ok_or_else(|| format!("bad path: {}", joined.display()))?;
        parent_canon.join(name)
    };

    if !resolved.starts_with(&root_canon) {
        return Err(format!(
            "path {} is outside the active workspace ({})",
            resolved.display(),
            root_canon.display()
        ));
    }
    // Defence in depth against TOCTOU: reject paths whose components
    // include a symlink. A malicious actor could re-target the symlink
    // between this canonicalize() and the eventual fs op, escaping the
    // workspace even though our canonical-form check passed. We accept
    // the workspace root itself being a symlink (we already followed it
    // above), but no link inside it.
    let mut walk = root_canon.clone();
    if let Ok(rel) = resolved.strip_prefix(&root_canon) {
        for comp in rel.iter() {
            walk.push(comp);
            match std::fs::symlink_metadata(&walk) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    return Err(format!(
                        "path {} traverses a symlink ({}); refusing for safety",
                        resolved.display(),
                        walk.display()
                    ));
                }
                _ => {}
            }
        }
    }
    Ok(resolved)
}

#[derive(Serialize, Deserialize, Default, Debug, Clone)]
pub struct DesktopConfig {
    pub workspace_root: Option<String>,
    pub first_run_done: bool,
    pub telemetry_opt_in: bool,
    #[serde(default)]
    pub legacy_imported: bool,
}

fn config_path() -> PathBuf {
    let base = dirs::home_dir()
        .map(|h| h.join(".llama-studio"))
        .unwrap_or_else(|| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&base);
    base.join("desktop.json")
}

pub fn load_config() -> DesktopConfig {
    let path = config_path();
    if let Ok(text) = std::fs::read_to_string(&path) {
        serde_json::from_str(&text).unwrap_or_default()
    } else {
        DesktopConfig::default()
    }
}

#[tauri::command]
pub fn desktop_config_get(state: tauri::State<'_, Arc<WorkspaceState>>) -> DesktopConfig {
    let cfg = load_config();
    // Keep the in-memory workspace state in sync with persisted config.
    state.set(cfg.workspace_root.as_ref().map(PathBuf::from));
    cfg
}

#[tauri::command]
pub fn desktop_config_set(
    state: tauri::State<'_, Arc<WorkspaceState>>,
    config: DesktopConfig,
) -> Result<DesktopConfig, String> {
    let path = config_path();
    let text = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    state.set(config.workspace_root.as_ref().map(PathBuf::from));
    Ok(config)
}

#[tauri::command]
pub fn set_workspace_root(
    state: tauri::State<'_, Arc<WorkspaceState>>,
    root: Option<String>,
) -> Result<(), String> {
    if let Some(ref r) = root {
        let p = PathBuf::from(r);
        if !p.exists() {
            return Err(format!("workspace not found: {r}"));
        }
    }
    state.set(root.map(PathBuf::from));
    Ok(())
}

#[derive(Serialize, Debug)]
pub struct LegacyDetection {
    pub present: bool,
    pub path: Option<String>,
    pub session_count: usize,
}

fn detect_legacy_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(home) = dirs::home_dir() {
        for cand in [".llama-studio-legacy", ".llamastudio", ".config/llama-studio"] {
            let p = home.join(cand);
            if p.exists() {
                out.push(p);
            }
        }
    }
    let local = PathBuf::from("legacy");
    if local.exists() {
        out.push(local);
    }
    out
}

#[tauri::command]
pub fn legacy_detect() -> LegacyDetection {
    let dirs = detect_legacy_dirs();
    let path = dirs.first().cloned();
    let session_count = path
        .as_ref()
        .map(|p| count_legacy_sessions(p))
        .unwrap_or(0);
    LegacyDetection {
        present: path.is_some(),
        path: path.map(|p| p.to_string_lossy().into_owned()),
        session_count,
    }
}

fn count_legacy_sessions(dir: &Path) -> usize {
    let sessions_dir = dir.join("sessions");
    if let Ok(rd) = std::fs::read_dir(&sessions_dir) {
        return rd.filter_map(|e| e.ok()).count();
    }
    0
}

#[derive(Serialize, Debug)]
pub struct LegacyImportResult {
    pub imported_sessions: usize,
    pub imported_settings: bool,
}

/// Import legacy config (best-effort). Conservative in Phase 4: flips
/// `legacy_imported` and copies any legacy `settings.json` into our
/// config dir as `legacy.settings.json`. Full session migration is owned
/// by the agent sidecar on first boot.
#[tauri::command]
pub fn legacy_import(
    state: tauri::State<'_, Arc<WorkspaceState>>,
) -> Result<LegacyImportResult, String> {
    let detection = legacy_detect();
    if !detection.present {
        return Ok(LegacyImportResult { imported_sessions: 0, imported_settings: false });
    }
    let mut cfg = load_config();
    let mut imported_settings = false;
    if let Some(p) = detection.path.as_ref() {
        let settings = Path::new(p).join("settings.json");
        if settings.exists() {
            let dest = config_path()
                .parent()
                .map(|d| d.join("legacy.settings.json"));
            if let Some(dest) = dest {
                let _ = std::fs::copy(&settings, &dest);
                imported_settings = true;
            }
        }
    }
    cfg.legacy_imported = true;
    let path = config_path();
    let text = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    state.set(cfg.workspace_root.as_ref().map(PathBuf::from));
    Ok(LegacyImportResult {
        imported_sessions: detection.session_count,
        imported_settings,
    })
}

#[derive(Serialize, Deserialize, Debug)]
pub struct TelemetryEvent {
    pub kind: String,
    #[serde(default)]
    pub meta: serde_json::Value,
}

#[tauri::command]
pub fn telemetry_log(event: TelemetryEvent) -> Result<(), String> {
    let cfg = load_config();
    if !cfg.telemetry_opt_in {
        return Ok(());
    }
    let dir = dirs::home_dir()
        .map(|h| h.join(".llama-studio").join("logs"))
        .ok_or_else(|| "no home dir".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("telemetry.log");
    let line = serde_json::json!({
        "at": chrono::Utc::now().to_rfc3339(),
        "kind": event.kind,
        "meta": event.meta,
    });
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    use std::io::Write;
    writeln!(f, "{line}").map_err(|e| e.to_string())?;
    Ok(())
}
