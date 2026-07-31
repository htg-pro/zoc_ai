//! Workspace + legacy-migration helpers.
//!
//! The frontend's onboarding flow asks the user to pick a workspace, then
//! we persist that choice in `~/.zoc-studio/desktop.json` and check the
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

use crate::sidecar::AgentSupervisor;

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
pub fn ensure_within_workspace(state: &WorkspaceState, target: &Path) -> Result<PathBuf, String> {
    let root = state
        .get()
        .ok_or_else(|| "no workspace root configured".to_string())?;
    let root_canon =
        std::fs::canonicalize(&root).map_err(|e| format!("workspace root invalid: {e}"))?;

    let joined = if target.is_absolute() {
        target.to_path_buf()
    } else {
        root_canon.join(target)
    };

    let resolved = if joined.exists() {
        std::fs::canonicalize(&joined).map_err(|e| e.to_string())?
    } else {
        // Canonicalize the nearest existing ancestor, then reattach every
        // missing component. This permits transaction writes to create nested
        // parents without weakening confinement or accepting `..` escapes.
        let mut ancestor = joined.as_path();
        while !ancestor.exists() {
            ancestor = ancestor
                .parent()
                .ok_or_else(|| format!("bad path: {}", joined.display()))?;
        }
        let ancestor_canon = std::fs::canonicalize(ancestor)
            .map_err(|e| format!("ancestor of {}: {e}", joined.display()))?;
        let suffix = joined
            .strip_prefix(ancestor)
            .map_err(|e| format!("bad path {}: {e}", joined.display()))?;
        if suffix.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        }) {
            return Err(format!(
                "path {} contains unsafe traversal",
                joined.display()
            ));
        }
        ancestor_canon.join(suffix)
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
    let relative = if target.is_absolute() {
        target
            .strip_prefix(&root)
            .or_else(|_| joined.strip_prefix(&root_canon))
            .or_else(|_| resolved.strip_prefix(&root_canon))
    } else {
        joined
            .strip_prefix(&root_canon)
            .or_else(|_| resolved.strip_prefix(&root_canon))
    };
    if let Ok(rel) = relative {
        for comp in rel.components() {
            match comp {
                std::path::Component::CurDir => continue,
                std::path::Component::Normal(name) => walk.push(name),
                _ => {
                    return Err(format!(
                        "path {} contains unsafe traversal",
                        joined.display()
                    ));
                }
            }
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
    /// The installed local-model list — zoc-agent-chat-rebuild R13.6, task 22.1.
    ///
    /// Held as opaque JSON objects rather than a typed struct on purpose. The
    /// `LocalModel` shape is the renderer's (`lib/local-models.ts`), it carries a
    /// dozen optional llama.cpp tuning fields, and Desktop_Core is a *store* for
    /// it, not a validator: a typed mirror here would be a second definition to
    /// keep in step, and every field added on the TypeScript side would silently
    /// drop out of the file until someone remembered this struct.
    ///
    /// Written only by [`local_models_set`]. [`desktop_config_set`] carries the
    /// stored value across untouched, so a renderer config write can never wipe
    /// the model list by omitting it.
    #[serde(default)]
    pub local_models: Vec<serde_json::Value>,
}

fn config_path() -> PathBuf {
    let base = dirs::home_dir()
        .map(|h| h.join(".zoc-studio"))
        .unwrap_or_else(|| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&base);
    base.join("desktop.json")
}

/// Read a config file by path. Missing or unparseable is [`DesktopConfig::default`].
///
/// Split from [`load_config`] so the read-modify-write below can be exercised
/// against a temp file rather than against `$HOME` — the same split
/// `hardware_fit.rs` makes for the same reason, and the only way these tests can
/// run without mutating the process environment.
fn read_config_at(path: &Path) -> DesktopConfig {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => DesktopConfig::default(),
    }
}

fn write_config_at(path: &Path, config: &DesktopConfig) -> Result<(), String> {
    let text = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

/// Replace the stored model list, leaving every other config field as it was.
///
/// Read-modify-write rather than a whole-config write from the renderer: the
/// model list and the workspace root are edited from different surfaces at
/// different times, and a full-object write from either one would take the
/// other's stale copy with it.
fn set_local_models_at(
    path: &Path,
    models: Vec<serde_json::Value>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut cfg = read_config_at(path);
    cfg.local_models = models;
    write_config_at(path, &cfg)?;
    Ok(cfg.local_models)
}

pub fn load_config() -> DesktopConfig {
    read_config_at(&config_path())
}

/// Persist just the workspace root into `desktop.json`, merging with the
/// existing config.
///
/// The gateway's `WorkspaceBinder` re-reads `desktop.json` on every request
/// (R1.2), so writing the switch here is what lets a running sidecar rebind to
/// a new workspace **without a restart**. `set_workspace_root` no longer relies
/// on a respawn to hand the gateway the new root through the environment.
fn persist_workspace_root(next: Option<&Path>) -> Result<(), String> {
    let mut cfg = load_config();
    cfg.workspace_root = next.map(|p| p.to_string_lossy().into_owned());
    let path = config_path();
    let text = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())
}

/// Whether a workspace transition is the onboarding *first selection* (no
/// workspace was open before). Only that transition restarts the sidecar; a
/// later *switch* between two workspaces rebinds via `desktop.json` with no
/// restart (R1.2). Clearing the workspace also never restarts.
fn is_onboarding_selection(previous: &Option<PathBuf>, next: &Option<PathBuf>) -> bool {
    previous.is_none() && next.is_some()
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
    supervisor: tauri::State<'_, Arc<AgentSupervisor>>,
    config: DesktopConfig,
) -> Result<DesktopConfig, String> {
    // Canonicalize before persisting so the stored value and the in-memory root
    // agree, and so a bad folder is refused at the point the user chose it
    // rather than on the first file operation.
    let next = match config.workspace_root.as_deref() {
        Some(raw) => Some(canonical_workspace_root(raw)?),
        None => None,
    };
    let config = DesktopConfig {
        workspace_root: next.as_ref().map(|p| p.to_string_lossy().into_owned()),
        // The model list is owned by `local_models_set` and is never taken from
        // the incoming config: the renderer's config writers all send a whole
        // object built from an earlier read, so honouring their copy would let a
        // stale Settings page delete a model added since it loaded.
        local_models: read_config_at(&config_path()).local_models,
        ..config
    };
    let path = config_path();
    let text = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    let previous = state.get();
    state.set(next.clone());
    // R1.2: the gateway re-reads desktop.json on every request, so a workspace
    // *switch* rebinds without a restart. Only the onboarding first-selection
    // restarts the sidecar (permitted); the env fallback the respawn passes is
    // no longer required for a rebind.
    if is_onboarding_selection(&previous, &next) {
        supervisor.restart();
    }
    Ok(config)
}

/// The installed local-model list — zoc-agent-chat-rebuild R13.6, task 22.1.
///
/// Desktop_Core rather than `localStorage` because R13.6 requires the
/// hardware-fit state to come from Desktop_Core, and two stores for one list
/// guarantees they disagree: the picker would offer a model the fit probe has
/// never seen, or hide one it can measure.
#[tauri::command]
pub fn local_models_get() -> Vec<serde_json::Value> {
    load_config().local_models
}

/// Replace the stored model list, returning what was stored.
///
/// Returns the list rather than `()` so the caller's cache is seeded from the
/// file it was just written to rather than from what it hoped it wrote.
#[tauri::command]
pub fn local_models_set(
    models: Vec<serde_json::Value>,
) -> Result<Vec<serde_json::Value>, String> {
    set_local_models_at(&config_path(), models)
}

/// Resolve a user-supplied workspace root to an absolute, canonical directory.
///
/// Canonicalizing here — at the one place a root enters the shell — is what
/// makes every later confinement check a cheap prefix comparison. Storing the
/// raw string instead (the previous behaviour) meant a root given as a relative
/// path, with a trailing slash, or through a symlink produced a different string
/// than the canonical paths derived from it, so the same folder could be
/// accepted by one check and rejected by another.
///
/// A path that is not an existing directory is rejected rather than stored: a
/// file or a deleted folder is not a workspace, and accepting one only defers
/// the failure to the first operation that tries to use it.
fn canonical_workspace_root(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("workspace path is empty".to_string());
    }
    let candidate = PathBuf::from(trimmed);
    let canonical = std::fs::canonicalize(&candidate)
        .map_err(|e| format!("workspace not found: {trimmed} ({e})"))?;
    if !canonical.is_dir() {
        return Err(format!("workspace is not a directory: {trimmed}"));
    }
    Ok(canonical)
}

#[tauri::command]
pub fn set_workspace_root(
    state: tauri::State<'_, Arc<WorkspaceState>>,
    supervisor: tauri::State<'_, Arc<AgentSupervisor>>,
    root: Option<String>,
) -> Result<(), String> {
    let next = match root {
        Some(ref r) => Some(canonical_workspace_root(r)?),
        None => None,
    };
    let previous = state.get();
    state.set(next.clone());
    // Persist the switch so the gateway rebinds via desktop.json without a
    // restart (R1.2) — this command no longer depends on a respawn to hand the
    // new root to the sidecar through the environment.
    persist_workspace_root(next.as_deref())?;
    // Only the onboarding first-selection restarts; a later switch rebinds live.
    if is_onboarding_selection(&previous, &next) {
        supervisor.restart();
    }
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
        for cand in [".zoc-studio-legacy", ".llamastudio", ".config/zoc-studio"] {
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
    let session_count = path.as_ref().map(|p| count_legacy_sessions(p)).unwrap_or(0);
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
        return Ok(LegacyImportResult {
            imported_sessions: 0,
            imported_settings: false,
        });
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

/// Rotate `telemetry.jsonl` once it exceeds this size (§11.2).
const TELEMETRY_MAX_BYTES: u64 = 10 * 1024 * 1024;

/// Path of the append-only telemetry store (`~/.zoc-studio/telemetry.jsonl`).
pub fn telemetry_path() -> Result<PathBuf, String> {
    let dir = dirs::home_dir()
        .map(|h| h.join(".zoc-studio"))
        .ok_or_else(|| "no home dir".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("telemetry.jsonl"))
}

/// Rotate the store to `telemetry.jsonl.1` when it grows past the size cap.
///
/// A single generation is kept deliberately: telemetry is disposable, and the
/// point of the cap is to bound disk use, not to preserve history.
fn rotate_if_needed(path: &Path) {
    let Ok(meta) = std::fs::metadata(path) else {
        return;
    };
    if meta.len() < TELEMETRY_MAX_BYTES {
        return;
    }
    let rotated = path.with_extension("jsonl.1");
    let _ = std::fs::rename(path, rotated);
}

/// Append one *local diagnostic* line to `~/.zoc-studio/logs/telemetry.log`.
///
/// This is the legacy, never-uploaded channel: its payloads may contain tool
/// names, file paths and other workspace detail, so it deliberately writes to a
/// different file from [`telemetry_event`] and is not readable by
/// [`telemetry_drain`]. Nothing from this file can leave the machine.
#[tauri::command]
pub fn telemetry_log(event: TelemetryEvent) -> Result<(), String> {
    let cfg = load_config();
    if !cfg.telemetry_opt_in {
        return Ok(());
    }
    let dir = dirs::home_dir()
        .map(|h| h.join(".zoc-studio").join("logs"))
        .ok_or_else(|| "no home dir".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("telemetry.log");
    append_event_line(&path, &event)
}

/// Append one *anonymous usage* event to `~/.zoc-studio/telemetry.jsonl` (§11.2).
///
/// Only events from the closed frontend schema reach this file, and only this
/// file is eligible for batch upload — that separation is what makes the
/// "no code, no file names, no personal data" promise checkable.
#[tauri::command]
pub fn telemetry_event(event: TelemetryEvent) -> Result<(), String> {
    let cfg = load_config();
    if !cfg.telemetry_opt_in {
        return Ok(());
    }
    let path = telemetry_path()?;
    rotate_if_needed(&path);
    append_event_line(&path, &event)
}

fn append_event_line(path: &Path, event: &TelemetryEvent) -> Result<(), String> {
    let line = serde_json::json!({
        "at": chrono::Utc::now().to_rfc3339(),
        "kind": event.kind,
        "meta": event.meta,
    });
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    use std::io::Write;
    writeln!(f, "{line}").map_err(|e| e.to_string())?;
    Ok(())
}

/// Local telemetry store stats, used to decide whether a batch upload is due.
#[derive(Serialize, Debug, Default)]
pub struct TelemetryStats {
    pub opted_in: bool,
    pub events: u64,
    pub bytes: u64,
    pub path: String,
}

#[tauri::command]
pub fn telemetry_stats() -> TelemetryStats {
    let cfg = load_config();
    let Ok(path) = telemetry_path() else {
        return TelemetryStats::default();
    };
    let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let events = std::fs::read_to_string(&path)
        .map(|text| text.lines().filter(|l| !l.trim().is_empty()).count() as u64)
        .unwrap_or(0);
    TelemetryStats {
        opted_in: cfg.telemetry_opt_in,
        events,
        bytes,
        path: path.to_string_lossy().to_string(),
    }
}

/// Read and clear the pending events, returning them for upload.
///
/// Refuses when the user has not opted in, so a caller cannot obtain a payload
/// to transmit without consent. Clearing on read is what makes the upload
/// at-most-once; a failed upload loses that batch, which is the correct
/// trade-off for disposable usage counters.
#[tauri::command]
pub fn telemetry_drain(limit: Option<usize>) -> Result<Vec<serde_json::Value>, String> {
    let cfg = load_config();
    if !cfg.telemetry_opt_in {
        return Ok(Vec::new());
    }
    let path = telemetry_path()?;
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(Vec::new());
    };
    let cap = limit.unwrap_or(usize::MAX);
    let events: Vec<serde_json::Value> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str(line).ok())
        .take(cap)
        .collect();
    let _ = std::fs::remove_file(&path);
    Ok(events)
}

/// Delete every locally stored telemetry event.
#[tauri::command]
pub fn telemetry_clear() -> Result<(), String> {
    let path = telemetry_path()?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    let rotated = path.with_extension("jsonl.1");
    if rotated.exists() {
        let _ = std::fs::remove_file(rotated);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_workspace(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("zoc-workspace-{label}-{nanos}"));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn only_first_selection_is_onboarding() {
        // R1.2: only the first workspace selection (no previous) restarts the
        // sidecar. A switch between two workspaces, or clearing the workspace,
        // rebinds via desktop.json with no restart.
        let a = Some(PathBuf::from("/a"));
        let b = Some(PathBuf::from("/b"));
        assert!(is_onboarding_selection(&None, &a)); // first pick → restart
        assert!(!is_onboarding_selection(&a, &b)); // switch → no restart
        assert!(!is_onboarding_selection(&a, &None)); // clear → no restart
        assert!(!is_onboarding_selection(&None, &None)); // nothing → no restart
    }

    /// A config file in a temp directory, so nothing here reads or writes `$HOME`.
    fn temp_config(label: &str) -> PathBuf {
        temp_workspace(label).join("desktop.json")
    }

    #[test]
    fn local_models_round_trip_through_the_config_file() {
        // Task 22.1: the list survives the write verbatim, including the optional
        // llama.cpp tuning fields Desktop_Core knows nothing about. That is the
        // whole reason the field is opaque JSON.
        let path = temp_config("models-roundtrip");
        let models = vec![serde_json::json!({
            "id": "local:abc",
            "name": "Qwen2.5-Coder-32B",
            "path": "/models/qwen.gguf",
            "n_gpu_layers": 99,
            "readiness_deadline_secs": 300,
        })];

        let stored = set_local_models_at(&path, models.clone()).unwrap();
        assert_eq!(stored, models);
        assert_eq!(read_config_at(&path).local_models, models);

        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn writing_models_leaves_every_other_field_alone() {
        // The read-modify-write's reason for existing: the model list is edited
        // from Settings → Models while the workspace root and the telemetry
        // choice are owned elsewhere, and a whole-object write would carry a
        // stale copy of both.
        let path = temp_config("models-preserve");
        write_config_at(
            &path,
            &DesktopConfig {
                workspace_root: Some("/work/proj".to_string()),
                first_run_done: true,
                telemetry_opt_in: true,
                legacy_imported: true,
                local_models: vec![],
            },
        )
        .unwrap();

        set_local_models_at(&path, vec![serde_json::json!({ "id": "local:x" })]).unwrap();

        let cfg = read_config_at(&path);
        assert_eq!(cfg.workspace_root.as_deref(), Some("/work/proj"));
        assert!(cfg.first_run_done);
        assert!(cfg.telemetry_opt_in);
        assert!(cfg.legacy_imported);
        assert_eq!(cfg.local_models.len(), 1);

        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn a_config_written_before_the_field_existed_still_loads() {
        // R23.5: an existing install's desktop.json has no `local_models` key.
        // Without `#[serde(default)]` that file would fail to parse and the
        // user's workspace root would silently reset to none.
        let path = temp_config("models-legacy");
        std::fs::write(
            &path,
            br#"{"workspace_root":"/work/proj","first_run_done":true,"telemetry_opt_in":false}"#,
        )
        .unwrap();

        let cfg = read_config_at(&path);
        assert_eq!(cfg.workspace_root.as_deref(), Some("/work/proj"));
        assert!(cfg.local_models.is_empty());

        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn an_unreadable_config_reads_as_default_rather_than_panicking() {
        let path = temp_config("models-garbage");
        std::fs::write(&path, b"{ not json").unwrap();
        let cfg = read_config_at(&path);
        assert!(cfg.workspace_root.is_none());
        assert!(cfg.local_models.is_empty());
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn canonicalizes_a_workspace_root() {
        // A root given with redundant components must be stored in exactly one
        // form, so later confinement checks are a simple prefix comparison.
        let root = temp_workspace("canon");
        let messy = root.join(".").join("..").join(root.file_name().unwrap());
        let resolved = canonical_workspace_root(messy.to_str().unwrap()).unwrap();
        assert_eq!(resolved, std::fs::canonicalize(&root).unwrap());
        assert!(resolved.is_absolute());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn resolves_a_symlinked_workspace_root() {
        #[cfg(unix)]
        {
            let real = temp_workspace("symlink-real");
            let link = real.with_file_name("zoc-workspace-symlink-link");
            std::fs::remove_file(&link).ok();
            std::os::unix::fs::symlink(&real, &link).unwrap();

            let resolved = canonical_workspace_root(link.to_str().unwrap()).unwrap();
            assert_eq!(resolved, std::fs::canonicalize(&real).unwrap());

            std::fs::remove_file(&link).ok();
            std::fs::remove_dir_all(real).ok();
        }
    }

    #[test]
    fn rejects_a_missing_or_non_directory_root() {
        let root = temp_workspace("notdir");
        let file = root.join("a-file.txt");
        std::fs::write(&file, b"x").unwrap();

        assert!(canonical_workspace_root(file.to_str().unwrap()).is_err());
        assert!(canonical_workspace_root(root.join("missing").to_str().unwrap()).is_err());
        assert!(canonical_workspace_root("   ").is_err());
        assert!(canonical_workspace_root("").is_err());

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn accepts_a_root_with_surrounding_whitespace() {
        let root = temp_workspace("trim");
        let padded = format!("  {}  ", root.to_str().unwrap());
        assert_eq!(
            canonical_workspace_root(&padded).unwrap(),
            std::fs::canonicalize(&root).unwrap()
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn canonical_root_is_confinement_ready() {
        // The point of canonicalizing at entry: paths derived from the stored
        // root land inside it without any further normalisation.
        let root = temp_workspace("confine");
        let state = WorkspaceState::default();
        state.set(Some(
            canonical_workspace_root(root.to_str().unwrap()).unwrap(),
        ));

        assert!(ensure_within_workspace(&state, Path::new("src/main.rs")).is_ok());
        assert!(ensure_within_workspace(&state, Path::new("../escape.txt")).is_err());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn allows_nested_missing_paths_inside_workspace() {
        let root = temp_workspace("nested");
        let state = WorkspaceState::default();
        state.set(Some(root.clone()));

        let resolved = ensure_within_workspace(&state, Path::new("new/deep/file.txt")).unwrap();
        assert_eq!(resolved, root.join("new/deep/file.txt"));
        assert!(!root.join("new").exists());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn rejects_sibling_prefix_and_parent_traversal() {
        let root = temp_workspace("boundary");
        let sibling = root.with_file_name(format!(
            "{}-sibling",
            root.file_name().unwrap().to_string_lossy()
        ));
        std::fs::create_dir_all(&sibling).unwrap();
        let state = WorkspaceState::default();
        state.set(Some(root.clone()));

        assert!(ensure_within_workspace(&state, &sibling.join("file.txt")).is_err());
        assert!(ensure_within_workspace(&state, Path::new("../escape.txt")).is_err());
        std::fs::remove_dir_all(root).ok();
        std::fs::remove_dir_all(sibling).ok();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_internal_symlink_components() {
        use std::os::unix::fs::symlink;

        let root = temp_workspace("symlink");
        std::fs::create_dir_all(root.join("real")).unwrap();
        symlink(root.join("real"), root.join("link")).unwrap();
        let state = WorkspaceState::default();
        state.set(Some(root.clone()));

        assert!(ensure_within_workspace(&state, Path::new("link/file.txt")).is_err());
        std::fs::remove_dir_all(root).ok();
    }
}
