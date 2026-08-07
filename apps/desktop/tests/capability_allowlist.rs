//! Capability-allowlist guard — zoc-agent-chat-rebuild R3.4, R14.2.
//!
//! Three files have to agree for the renderer to reach a command:
//! `lib.rs`'s `generate_handler!`, `build.rs`'s app ACL manifest, and
//! `capabilities/default.json`. Two of the three disagreements are silent —
//! `tauri-macros` drops a command missing from the manifest with a build note
//! nobody reads, and the IPC layer refuses a command missing from the capability
//! at runtime, in the session, on the user's machine. Neither is a compile error.
//!
//! So the agreement is asserted here instead. The tests read the three files as
//! text rather than importing anything, because the facts under test are the
//! contents of those files and nothing else.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// Commands that are registered in Rust but must **not** be reachable from the
/// webview. Both return a provider key in plaintext (R14.2).
///
/// `runtime_secret_get` serves a caller holding the per-launch runtime token.
/// The Agent_Runtime is a separate OS process and reaches Desktop_Core over the
/// loopback bridge, never over Tauri IPC, so it has no need of an IPC grant —
/// and granting one would put a key-returning command one renderer bug away
/// from being called. It has been denied since it was written.
///
/// `secret_get` was granted until task 26.3, when the last three renderer
/// callers were repointed to `secret_has` or to services that resolve their own
/// credential. Both halves of that step were required: `secureStore.get`'s
/// vault-unavailable path fell through to the `localStorage` shadow, so
/// revoking this grant *first* would have started reading plaintext out of
/// renderer-accessible storage while this file looked correct.
const RENDERER_DENIED: &[&str] = &["runtime_secret_get", "secret_get"];

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|err| panic!("could not read {path:?}: {err}"))
}

/// Command names inside `lib.rs`'s `generate_handler![...]`, unqualified.
fn handler_commands() -> BTreeSet<String> {
    let source = read(&manifest_dir().join("src").join("lib.rs"));
    let start = source
        .find("generate_handler![")
        .expect("lib.rs has a generate_handler! block");
    let body = &source[start + "generate_handler![".len()..];
    let end = body.find(']').expect("generate_handler! block is closed");

    body[..end]
        .lines()
        .map(|line| line.split("//").next().unwrap_or("").trim())
        .filter(|line| !line.is_empty())
        .flat_map(|line| line.split(','))
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        // `module::command` → `command`
        .map(|entry| entry.rsplit("::").next().unwrap_or(entry).to_string())
        .collect()
}

/// Command names declared in `build.rs`'s `COMMANDS` list.
fn manifest_commands() -> BTreeSet<String> {
    let source = read(&manifest_dir().join("build.rs"));
    let start = source
        .find("const COMMANDS: &[&str] = &[")
        .expect("build.rs declares COMMANDS");
    let body = &source[start..];
    let end = body.find("];").expect("COMMANDS list is closed");

    body[..end]
        .lines()
        .map(|line| line.split("//").next().unwrap_or("").trim())
        .filter(|line| line.starts_with('"'))
        .map(|line| line.trim_matches(|c: char| c == '"' || c == ',' || c.is_whitespace()))
        .filter(|entry| !entry.is_empty())
        .map(str::to_string)
        .collect()
}

/// App-command permissions granted by `capabilities/default.json`.
///
/// Plugin permissions carry a `plugin:` prefix and are skipped: this set is
/// about the application's own commands.
fn capability_allowed_commands() -> BTreeSet<String> {
    let source = read(&manifest_dir().join("capabilities").join("default.json"));
    let capability: serde_json::Value =
        serde_json::from_str(&source).expect("capabilities/default.json is valid JSON");
    let permissions = capability["permissions"]
        .as_array()
        .expect("the capability has a permissions array");

    permissions
        .iter()
        .filter_map(|entry| entry.as_str())
        .filter(|identifier| !identifier.contains(':'))
        .filter_map(|identifier| identifier.strip_prefix("allow-"))
        // Permission identifiers are kebab-case; command names are snake_case.
        .map(|command| command.replace('-', "_"))
        .collect()
}

#[test]
fn the_endpoint_handoff_is_granted_to_the_renderer() {
    // R3.4: the renderer resolves the runtime's port and per-launch token through
    // this command. Absent from the capability it compiles, ships, and fails on
    // the first Run.
    let granted = capability_allowed_commands();
    for command in [
        "agent_runtime_endpoint",
        "agent_runtime_status",
        "runtime_restart",
    ] {
        assert!(
            granted.contains(command),
            "{command} is missing from capabilities/default.json"
        );
    }
}

#[test]
fn every_registered_command_is_declared_in_the_app_manifest() {
    let declared = manifest_commands();
    let registered = handler_commands();
    let missing: Vec<_> = registered.difference(&declared).cloned().collect();
    assert!(
        missing.is_empty(),
        "commands in generate_handler! but not in build.rs's COMMANDS (tauri-macros \
         removes these from the handler at compile time): {missing:?}"
    );

    let stale: Vec<_> = declared.difference(&registered).cloned().collect();
    assert!(
        stale.is_empty(),
        "commands declared in build.rs but no longer registered in generate_handler!: {stale:?}"
    );
}

#[test]
fn every_declared_command_is_either_granted_or_deliberately_denied() {
    let declared = manifest_commands();
    let granted = capability_allowed_commands();
    let denied: BTreeSet<String> = RENDERER_DENIED.iter().map(|c| c.to_string()).collect();

    let ungranted: Vec<_> = declared
        .difference(&granted)
        .filter(|command| !denied.contains(*command))
        .cloned()
        .collect();
    assert!(
        ungranted.is_empty(),
        "declared commands that are neither granted in capabilities/default.json nor \
         listed in RENDERER_DENIED — each one is refused at runtime: {ungranted:?}"
    );
}

#[test]
fn no_key_returning_command_is_reachable_from_the_renderer() {
    // R14.2, closed structurally at task 26.3.
    let granted = capability_allowed_commands();
    for command in RENDERER_DENIED {
        assert!(
            !granted.contains(*command),
            "{command} is granted to the renderer; it returns a provider key and \
             must stay reachable only over the loopback bridge"
        );
    }

    // Belt and braces: `capability_allowed_commands` normalises kebab-case to
    // snake_case, so a re-added `allow-secret-get` is caught by the loop above.
    // This catches the other spelling — a raw `secret_get` identifier — which
    // would slip past the `allow-` prefix filter and never reach the set.
    let source = read(&manifest_dir().join("capabilities").join("default.json"));
    let capability: serde_json::Value =
        serde_json::from_str(&source).expect("capabilities/default.json is valid JSON");
    for entry in capability["permissions"]
        .as_array()
        .expect("the capability has a permissions array")
        .iter()
        .filter_map(|e| e.as_str())
    {
        let normalised = entry.replace('-', "_");
        assert!(
            !normalised.contains("secret_get"),
            "capabilities/default.json grants {entry:?}, which reaches a \
             key-returning command (R14.2)"
        );
    }

    let declared = manifest_commands();
    for command in RENDERER_DENIED {
        assert!(
            declared.contains(*command),
            "{command} must stay declared in build.rs — dropping it from the manifest \
             removes it from the handler entirely, which is a different change and \
             would make this test pass vacuously"
        );
    }
}

#[test]
fn granted_commands_all_exist() {
    // Catches the reverse drift: a stale `allow-*` entry for a command that was
    // renamed or removed. Tauri fails the build on an unknown permission, so this
    // is a faster and more legible signal than a build error inside tauri-build.
    let declared = manifest_commands();
    let unknown: Vec<_> = capability_allowed_commands()
        .difference(&declared)
        .cloned()
        .collect();
    assert!(
        unknown.is_empty(),
        "capabilities/default.json grants commands that do not exist: {unknown:?}"
    );
}
