//! Tauri shell entry point. Owns the agent-sidecar supervisor, exposes IPC
//! commands for the frontend (sidecar status, secrets, filesystem ops,
//! patch application, workspace onboarding, telemetry), and forwards FS
//! watcher + sidecar status events on `fs://changed` / `agent://status`.

mod checks;
mod fs_commands;
mod git;
mod hardware_fit;
mod runtime_bridge;
mod llama_server;
mod patch;
mod search_commands;
mod secrets;
mod share;
mod sidecar;
mod workspace;

use std::sync::Arc;

use crate::fs_commands::WatcherState;
use crate::llama_server::LlamaServerSupervisor;
use crate::share::ShareState;
use crate::sidecar::{AgentRuntimeSupervisor, AgentStatus, AgentSupervisor};
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
    let runtime_supervisor: Arc<AgentRuntimeSupervisor> =
        Arc::new(AgentRuntimeSupervisor::default());
    let watcher: Arc<WatcherState> = Arc::new(WatcherState::default());
    let workspace: Arc<WorkspaceState> = Arc::new(WorkspaceState::default());
    let llama_server: Arc<LlamaServerSupervisor> = Arc::new(LlamaServerSupervisor::default());
    let share: Arc<ShareState> = Arc::new(ShareState::default());
    // The Secret_Vault probes its backend at construction (R14.7), so the
    // degraded state is known before the first key is entered rather than
    // discovered on the first save.
    let vault: Arc<secrets::SecretVault> = Arc::new(secrets::SecretVault::system());
    // The loopback transport the Agent_Runtime reaches Desktop_Core through
    // (R6.1, R14.10): a separate OS process cannot invoke a Tauri command.
    let bridge: Arc<runtime_bridge::RuntimeBridge> =
        Arc::new(runtime_bridge::RuntimeBridge::default());
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
        // §11.3: auto-update. The updater is inert until `plugins.updater.active`
        // is true *and* a minisign `pubkey` is configured in tauri.conf.json, so
        // registering it unconditionally is safe — `check()` simply reports that
        // updates are unavailable, which the frontend treats as "up to date".
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(supervisor.clone())
        .manage(runtime_supervisor.clone())
        .manage(watcher.clone())
        .manage(workspace.clone())
        .manage(llama_server.clone())
        .manage(share.clone())
        .manage(vault.clone())
        .manage(bridge.clone())
        .setup({
            let supervisor = supervisor.clone();
            let runtime_supervisor = runtime_supervisor.clone();
            let vault = vault.clone();
            let bridge = bridge.clone();
            move |app| {
                let handle = app.handle().clone();
                // Start the bridge before the runtime, so the first spawn already
                // has a URL to be given.
                runtime_bridge::start(
                    bridge.clone(),
                    vault.clone(),
                    runtime_supervisor.clone(),
                    workspace.clone(),
                );
                sidecar::supervise(handle.clone(), supervisor.clone());
                // The runtime is supervised alongside the Python sidecar rather
                // than after it. It reads Workspace_Services' port on every
                // spawn, so it tolerates starting first and needs no ordering
                // guarantee between the two.
                sidecar::supervise_runtime(handle.clone(), runtime_supervisor.clone(), supervisor.clone());
                // R14.8: the vault owns *when* there is something to say about
                // its backend; the shell owns the emit. Installing the publisher
                // announces the probed backend once, so the renderer's degraded
                // notice does not wait for a first write, and every later tier
                // change — a keychain that goes away mid-session, or comes back —
                // reaches the same subscriber without a restart.
                {
                    let events = handle.clone();
                    vault.set_status_publisher(Box::new(move |status| {
                        use tauri::Emitter;
                        let _ = events.emit(secrets::STATUS_EVENT, status);
                    }));
                }
                Ok(())
            }
        })
        .on_window_event({
            let supervisor = supervisor.clone();
            let runtime_supervisor = runtime_supervisor.clone();
            let bridge = bridge.clone();
            let llama_server = llama_server.clone();
            let share = share.clone();
            move |_window, event| {
                if let tauri::WindowEvent::Destroyed = event {
                    supervisor.shutdown();
                    // R3.7: no orphan. Same proven path as the Python sidecar.
                    runtime_supervisor.shutdown();
                    bridge.shutdown();
                    llama_server.shutdown();
                    // Never leave a LAN listener behind after the window closes.
                    share.stop();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            agent_port,
            agent_status,
            secrets::secret_get,
            secrets::secret_set,
            secrets::secret_clear,
            secrets::secret_has,
            secrets::secret_backend_status,
            secrets::runtime_secret_get,
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
            patch::apply_transaction,
            workspace::desktop_config_get,
            workspace::desktop_config_set,
            workspace::set_workspace_root,
            workspace::legacy_detect,
            workspace::legacy_import,
            workspace::telemetry_log,
            workspace::telemetry_event,
            workspace::telemetry_stats,
            workspace::telemetry_drain,
            workspace::telemetry_clear,
            llama_server::llamacpp_load,
            llama_server::llamacpp_unload,
            llama_server::llamacpp_status,
            share::share_session,
            share::share_session_stop,
            share::share_session_status,
            sidecar::agent_crash_reports,
            sidecar::agent_crash_reports_clear,
            sidecar::agent_restart,
            // ── Agent_Runtime (zoc-agent-chat-rebuild R3.4, R3.8, R13.6) ──
            sidecar::agent_runtime_endpoint,
            sidecar::agent_runtime_status,
            sidecar::runtime_restart,
            hardware_fit::local_model_hardware_fit,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
