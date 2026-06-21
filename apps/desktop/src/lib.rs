//! Tauri shell entry point. Owns the agent-sidecar supervisor, exposes IPC
//! commands for the frontend (sidecar status, secrets, filesystem ops,
//! patch application, workspace onboarding, telemetry), and forwards FS
//! watcher + sidecar status events on `fs://changed` / `agent://status`.

mod checks;
mod fs_commands;
mod git;
mod llama_server;
mod patch;
mod search_commands;
mod secrets;
mod sidecar;
mod workspace;

use std::sync::Arc;

use crate::fs_commands::WatcherState;
use crate::llama_server::LlamaServerSupervisor;
use crate::sidecar::{AgentStatus, AgentSupervisor};
use crate::workspace::WorkspaceState;

#[tauri::command]
fn agent_port(state: tauri::State<'_, Arc<AgentSupervisor>>) -> Option<u16> {
    state.status.lock().port
}

#[tauri::command]
fn agent_status(state: tauri::State<'_, Arc<AgentSupervisor>>) -> AgentStatus {
    state.current()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,zoc_studio_desktop=debug".into()),
        )
        .init();

    let supervisor: Arc<AgentSupervisor> = Arc::new(AgentSupervisor::default());
    let watcher: Arc<WatcherState> = Arc::new(WatcherState::default());
    let workspace: Arc<WorkspaceState> = Arc::new(WorkspaceState::default());
    let llama_server: Arc<LlamaServerSupervisor> = Arc::new(LlamaServerSupervisor::default());
    // Seed the in-memory workspace state from any persisted desktop.json so
    // FS commands work immediately after boot, even before the UI explicitly
    // pushes a workspace root via `set_workspace_root`.
    {
        let cfg = workspace::load_config();
        workspace.set(cfg.workspace_root.as_ref().map(std::path::PathBuf::from));
    }

    // NOTE: we deliberately do NOT register `tauri_plugin_log` here. Both it
    // and the `tracing_subscriber` above install a global `log` logger, and
    // `log::set_logger` panics if called twice. The desktop code logs via the
    // `tracing` macros, so `tracing_subscriber` is the single source of truth.
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {}))
        .manage(supervisor.clone())
        .manage(watcher.clone())
        .manage(workspace.clone())
        .manage(llama_server.clone())
        .setup({
            let supervisor = supervisor.clone();
            move |app| {
                let handle = app.handle().clone();
                sidecar::supervise(handle, supervisor.clone());
                Ok(())
            }
        })
        .on_window_event({
            let supervisor = supervisor.clone();
            let llama_server = llama_server.clone();
            move |_window, event| {
                if let tauri::WindowEvent::Destroyed = event {
                    supervisor.shutdown();
                    llama_server.shutdown();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            agent_port,
            agent_status,
            secrets::secret_get,
            secrets::secret_set,
            secrets::secret_clear,
            fs_commands::fs_list_dir,
            fs_commands::fs_read_text,
            fs_commands::fs_write_text,
            fs_commands::fs_watch_start,
            fs_commands::fs_watch_stop,
            fs_commands::fs_stat,
            fs_commands::fs_create_file,
            fs_commands::fs_create_dir,
            fs_commands::fs_rename,
            fs_commands::fs_move,
            fs_commands::fs_delete,
            fs_commands::fs_duplicate,
            fs_commands::fs_reveal,
            search_commands::fs_search,
            search_commands::fs_replace_preview,
            search_commands::fs_replace_apply,
            git::git_status,
            git::git_diff,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_commit,
            git::git_checkpoint_commit,
            git::git_branches,
            git::git_checkout,
            git::git_create_branch,
            git::git_pull,
            git::git_push,
            git::git_log,
            git::git_conflicts,
            git::git_blame,
            checks::run_check,
            checks::run_task,
            patch::apply_patch,
            workspace::desktop_config_get,
            workspace::desktop_config_set,
            workspace::set_workspace_root,
            workspace::legacy_detect,
            workspace::legacy_import,
            workspace::telemetry_log,
            llama_server::llamacpp_load,
            llama_server::llamacpp_unload,
            llama_server::llamacpp_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
