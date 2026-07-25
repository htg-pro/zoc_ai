"""Tests for the gateway permission engine port (Part 7.1)."""

from __future__ import annotations

from zocai_gateway.permissions import (
    ActionRequest,
    PermissionConfig,
    build_permission_gate,
    config_from_mapping,
    evaluate_permission,
)


def test_read_only_is_always_allowed() -> None:
    cfg = PermissionConfig(trust="restricted")
    assert (
        evaluate_permission(cfg, ActionRequest(kind="fs", name="x", read_only=True)).effect
        == "allow"
    )


def test_restricted_denies_execution_kinds() -> None:
    cfg = PermissionConfig(trust="restricted")
    for kind in ("terminal", "task", "plugin", "agent_tool", "mcp", "git"):
        assert evaluate_permission(cfg, ActionRequest(kind=kind, name="x")).effect == "deny"


def test_trusted_run_all_allows_execution() -> None:
    cfg = PermissionConfig(trust="trusted", run_mode="all")
    assert (
        evaluate_permission(cfg, ActionRequest(kind="terminal", name="npm test")).effect == "allow"
    )


def test_fs_protections_prompt() -> None:
    cfg = PermissionConfig(trust="trusted", run_mode="all")
    assert (
        evaluate_permission(
            cfg, ActionRequest(kind="fs", name="f", target="a.txt", destructive=True)
        ).effect
        == "prompt"
    )
    assert (
        evaluate_permission(cfg, ActionRequest(kind="fs", name="f", target=".env")).effect
        == "prompt"
    )
    assert (
        evaluate_permission(
            cfg, ActionRequest(kind="fs", name="f", target="/etc/hosts"), workspace_root="/ws"
        ).effect
        == "prompt"
    )


def test_allowlist_mode() -> None:
    cfg = PermissionConfig(trust="trusted", run_mode="allowlist", command_allowlist=("npm test",))
    assert (
        evaluate_permission(cfg, ActionRequest(kind="terminal", name="npm test")).effect == "allow"
    )
    assert evaluate_permission(cfg, ActionRequest(kind="terminal", name="rm x")).effect == "prompt"


def test_network_allowlist() -> None:
    cfg = PermissionConfig(trust="trusted", run_mode="all", network_allowlist=("api.example.com",))
    denied = evaluate_permission(
        cfg, ActionRequest(kind="fs", name="f", network=True, host="evil.test")
    )
    assert denied.effect == "prompt"
    ok = evaluate_permission(
        cfg, ActionRequest(kind="fs", name="f", network=True, host="api.example.com")
    )
    assert ok.effect == "allow"


def test_config_from_mapping_camelcase_and_defaults() -> None:
    cfg = config_from_mapping(
        {
            "trust": "trusted",
            "runMode": "allowlist",
            "commandAllowlist": ["npm test", 5],
            "protectDotfiles": False,
        }
    )
    assert cfg.trust == "trusted"
    assert cfg.run_mode == "allowlist"
    assert cfg.command_allowlist == ("npm test",)  # non-strings dropped
    assert cfg.protect_dotfiles is False
    assert cfg.protect_deletions is True  # default preserved
    # Junk / missing → safe restricted default.
    fallback = config_from_mapping(None)
    assert fallback.trust == "restricted" and fallback.run_mode == "ask"


def test_build_permission_gate_maps_kind_target_to_effect() -> None:
    restricted = build_permission_gate(PermissionConfig(trust="restricted"))
    assert restricted("terminal", "run_shell", "rm -rf x").effect == "deny"
    assert restricted("fs", "write_file", "a.txt").effect == "prompt"

    trusted = build_permission_gate(PermissionConfig(trust="trusted", run_mode="all"))
    assert trusted("terminal", "run_shell", "echo hi").effect == "allow"
    assert trusted("fs", "write_file", "src/a.ts").effect == "allow"


def test_external_path_uses_component_boundary() -> None:
    from zocai_gateway.permissions import is_external_path

    assert not is_external_path("/workspace/src/a.py", "/workspace")
    assert is_external_path("/workspace-evil/a.py", "/workspace")
    assert not is_external_path(r"C:\\Work\\src\\a.py", r"c:\\work")
    assert is_external_path(r"C:\\Worker\\a.py", r"C:\\Work")


def test_permission_gate_marks_reads_and_destructive_shell_commands() -> None:
    gate = build_permission_gate(PermissionConfig(trust="trusted", run_mode="all"), "/workspace")

    assert gate("fs", "read_file", "src/a.py").effect == "allow"
    assert gate("terminal", "run_shell", "rm -rf build").effect == "prompt"


def test_permission_gate_marks_fetch_url_as_network_access() -> None:
    gate = build_permission_gate(
        PermissionConfig(
            trust="trusted",
            run_mode="all",
            network_allowlist=("api.example.com",),
        )
    )
    assert (
        gate(
            "agent_tool",
            "fetch_url",
            "https://api.example.com/v1/models",
        ).effect
        == "allow"
    )
    assert gate("agent_tool", "fetch_url", "https://evil.test/data").effect == "prompt"
