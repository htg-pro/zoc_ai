//! Tauri build script — zoc-agent-chat-rebuild R3.4, R14.2.
//!
//! Declares the **application ACL manifest**, which is what makes
//! `capabilities/default.json` an allowlist for our own commands rather than
//! only for plugin commands.
//!
//! Why this exists at all: in Tauri v2 the ACL gates plugin commands by
//! default, and application commands registered through `generate_handler!` are
//! reachable from the webview whether or not any capability mentions them —
//! `tauri`'s IPC layer only consults the ACL for an app command once the app has
//! declared a manifest (`RuntimeAuthority::has_app_manifest`). So without this
//! file, listing `agent_runtime_endpoint` in a capability would be decoration,
//! and R14.2's later revocation of `secret_get` (task 26.2) would revoke
//! nothing.
//!
//! Consequences a reader needs to know before editing the list:
//!
//! - Every command in `lib.rs`'s `generate_handler!` must appear **here**, or
//!   `tauri-macros` removes it from the handler at compile time.
//! - Every command the renderer invokes must also appear in
//!   `capabilities/default.json` as `allow-<kebab-case-name>`, or the invoke is
//!   refused at runtime.
//! - A command declared here and *omitted* from the capability is registered in
//!   Rust and unreachable from the webview. That is the point for
//!   `runtime_secret_get`, which is a runtime-facing credential path and must
//!   never be callable from the renderer.
//!
//! `tests/capability_allowlist.rs` asserts all three, so a drift between the
//! handler, this list, and the capability fails `cargo test` rather than a user's
//! session.

/// Every `#[tauri::command]` registered in `lib.rs`'s `generate_handler!`.
///
/// Order mirrors the handler so the two lists can be diffed by eye.
const COMMANDS: &[&str] = &[
    // sidecar / status
    "agent_port",
    "agent_status",
    // Secret_Vault (R14)
    "secret_get",
    "secret_set",
    "secret_clear",
    "secret_has",
    "secret_backend_status",
    // Runtime-facing only: deliberately absent from the capability set.
    "runtime_secret_get",
    // filesystem
    "fs_list_dir",
    "fs_read_text",
    "fs_write_text",
    "fs_watch_start",
    "fs_watch_stop",
    "fs_stat",
    "fs_create_file",
    "fs_create_dir",
    "fs_rename",
    "fs_move",
    "fs_delete",
    "fs_duplicate",
    "fs_reveal",
    // search & replace
    "fs_search",
    "fs_replace_preview",
    "fs_replace_apply",
    // source control
    "git_status",
    "git_diff",
    "git_stage",
    "git_unstage",
    "git_discard",
    "git_commit",
    "git_checkpoint_commit",
    "git_branches",
    "git_checkout",
    "git_create_branch",
    "git_pull",
    "git_push",
    "git_log",
    "git_conflicts",
    "git_blame",
    // checks & tasks
    "run_check",
    "run_task",
    // patch application
    "apply_patch",
    "apply_transaction",
    // workspace, onboarding, telemetry
    "desktop_config_get",
    "desktop_config_set",
    "set_workspace_root",
    "legacy_detect",
    "legacy_import",
    "telemetry_log",
    "telemetry_event",
    "telemetry_stats",
    "telemetry_drain",
    "telemetry_clear",
    // local model server
    "llamacpp_load",
    "llamacpp_unload",
    "llamacpp_status",
    // read-only LAN share
    "share_session",
    "share_session_stop",
    "share_session_status",
    // crash reporting & restart
    "agent_crash_reports",
    "agent_crash_reports_clear",
    "agent_restart",
    // Agent_Runtime endpoint handoff (R3.4, R3.8) and hardware-fit probe (R13.6)
    "agent_runtime_endpoint",
    "agent_runtime_status",
    "runtime_restart",
    "local_model_hardware_fit",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
