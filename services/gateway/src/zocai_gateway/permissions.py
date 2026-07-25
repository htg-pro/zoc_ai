"""Python twin of the frontend permission engine (Part 7.1).

A faithful port of ``apps/frontend/src/lib/permissions-engine.ts``
``evaluatePermission`` + helpers, so the gateway can gate agent tools with the
exact policy the UI configures (the frontend sends its `PermissionConfig` on the
run request). Pure and unit-testable; :func:`build_permission_gate` adapts it to
the ReAct ``PermissionGate`` seam ``(kind, target) -> effect``.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Literal

__all__ = [
    "ActionRequest",
    "Decision",
    "PermissionConfig",
    "basename",
    "build_permission_gate",
    "config_from_mapping",
    "evaluate_permission",
    "is_dotfile",
    "is_external_path",
    "matches_allowlist",
]

TrustState = Literal["trusted", "restricted"]
RunMode = Literal["ask", "allowlist", "sandboxed", "all"]
Effect = Literal["allow", "deny", "prompt"]

#: Execution kinds a restricted workspace blocks until trusted.
_EXECUTION_KINDS = frozenset({"terminal", "task", "plugin", "agent_tool", "mcp", "git"})
_RUN_MODES = frozenset({"ask", "allowlist", "sandboxed", "all"})


@dataclass(frozen=True)
class PermissionConfig:
    trust: TrustState = "restricted"
    run_mode: RunMode = "ask"
    command_allowlist: tuple[str, ...] = ()
    mcp_allowlist: tuple[str, ...] = ()
    network_allowlist: tuple[str, ...] = ()
    protect_deletions: bool = True
    protect_dotfiles: bool = True
    protect_external: bool = True


@dataclass(frozen=True)
class ActionRequest:
    kind: str  # one of the ActionKind values (terminal/fs/git/mcp/plugin/task/agent_tool)
    name: str
    target: str | None = None
    destructive: bool = False
    network: bool = False
    host: str | None = None
    read_only: bool = False
    sandboxable: bool = False


@dataclass(frozen=True)
class Decision:
    effect: Effect
    reason: str


def basename(path: str) -> str:
    parts = [p for p in re.split(r"[/\\]", path) if p]
    return parts[-1] if parts else path


def is_dotfile(target: str | None) -> bool:
    return bool(target) and basename(target or "").startswith(".")


def is_external_path(target: str | None, workspace_root: str | None) -> bool:
    if not target:
        return False
    is_absolute = target.startswith("/") or re.match(r"^[A-Za-z]:[/\\]", target) is not None
    if not workspace_root:
        return is_absolute

    def norm(p: str) -> str:
        normalized = re.sub(r"[/\\]+", "/", p).rstrip("/")
        # Windows paths are case-insensitive; case-folding is harmless for the
        # lexical safety check on other platforms and avoids drive-case bypasses.
        return normalized.casefold()

    if not is_absolute:
        return ".." in re.split(r"[/\\]", target)
    candidate = norm(target)
    root = norm(workspace_root)
    return candidate != root and not candidate.startswith(f"{root}/")


def matches_allowlist(allowlist: tuple[str, ...], name: str) -> bool:
    n = name.strip()
    for entry in allowlist:
        e = entry.strip()
        if e and (n == e or n.startswith(f"{e} ")):
            return True
    return False


def _is_allowlisted(config: PermissionConfig, req: ActionRequest) -> bool:
    if req.kind == "mcp":
        return matches_allowlist(config.mcp_allowlist, req.name)
    if req.kind in ("terminal", "task"):
        return matches_allowlist(config.command_allowlist, req.name)
    return False


def evaluate_permission(
    config: PermissionConfig, req: ActionRequest, workspace_root: str | None = None
) -> Decision:
    """Evaluate one action against the policy (mirrors the TS precedence)."""
    if req.read_only:
        return Decision("allow", "Read-only action.")
    if config.trust == "restricted" and req.kind in _EXECUTION_KINDS:
        return Decision("deny", f"Workspace is restricted — trust it to run {req.kind} actions.")

    allowlisted = _is_allowlisted(config, req)

    if req.kind == "fs":
        if req.destructive and config.protect_deletions:
            return Decision("prompt", "File deletion is protected — confirm to proceed.")
        if config.protect_dotfiles and is_dotfile(req.target):
            return Decision("prompt", "Editing a protected dotfile — confirm to proceed.")
        if config.protect_external and is_external_path(req.target, workspace_root):
            return Decision("prompt", "Target is outside the workspace — confirm to proceed.")

    if req.destructive and not allowlisted:
        return Decision("prompt", "Destructive action requires explicit confirmation.")

    if req.network and (not req.host or not matches_allowlist(config.network_allowlist, req.host)):
        return Decision("prompt", f"Network host {req.host or '(unknown)'} is not allowlisted.")

    if config.run_mode == "all":
        return Decision("allow", "Run-everything mode.")
    if config.run_mode == "allowlist":
        return (
            Decision("allow", "Command is allowlisted.")
            if allowlisted
            else Decision("prompt", "Not on the allowlist — confirm to proceed.")
        )
    if config.run_mode == "sandboxed":
        return (
            Decision("allow", "Runs in an isolated sandbox.")
            if req.sandboxable
            else Decision("prompt", "Can't be sandboxed — confirm to proceed.")
        )
    return (
        Decision("allow", "Command is allowlisted.")
        if allowlisted
        else Decision("prompt", "Ask-every-time mode.")
    )


def config_from_mapping(raw: object) -> PermissionConfig:
    """Tolerantly build a config from the frontend's camelCase payload."""
    if not isinstance(raw, Mapping):
        return PermissionConfig()

    def arr(value: object) -> tuple[str, ...]:
        return tuple(x for x in value if isinstance(x, str)) if isinstance(value, list) else ()

    trust = raw.get("trust")
    run_mode = raw.get("runMode")
    return PermissionConfig(
        trust="trusted" if trust == "trusted" else "restricted",
        run_mode=run_mode if run_mode in _RUN_MODES else "ask",
        command_allowlist=arr(raw.get("commandAllowlist")),
        mcp_allowlist=arr(raw.get("mcpAllowlist")),
        network_allowlist=arr(raw.get("networkAllowlist")),
        protect_deletions=raw.get("protectDeletions") is not False,
        protect_dotfiles=raw.get("protectDotfiles") is not False,
        protect_external=raw.get("protectExternal") is not False,
    )


_DESTRUCTIVE_COMMANDS = (
    re.compile(r"(?:^|\s)rm\s+-[^\s]*r[^\s]*f(?:\s|$)", re.IGNORECASE),
    re.compile(r"(?:^|\s)git\s+reset\s+--hard(?:\s|$)", re.IGNORECASE),
    re.compile(r"(?:^|\s)git\s+clean\s+-[^\s]*f", re.IGNORECASE),
    re.compile(r"(?:^|\s)git\s+push\b.*(?:--force(?:-with-lease)?|\s-f(?:\s|$))", re.IGNORECASE),
    re.compile(r"(?:^|\s)(?:mkfs|format)(?:\s|$)", re.IGNORECASE),
    re.compile(r"(?:^|\s)dd\b.*\bof=/dev/", re.IGNORECASE),
)


def _destructive_command(command: str) -> bool:
    return any(pattern.search(command) is not None for pattern in _DESTRUCTIVE_COMMANDS)


def build_permission_gate(
    config: PermissionConfig, workspace_root: str | None = None
) -> Callable[[str, str, str], Decision]:
    """Adapt the engine to the ReAct ``PermissionGate`` seam.

    The executor supplies ``(kind, tool_name, target)`` for every native and
    MCP tool. This adapter enriches those values with read/destructive metadata
    before returning the full decision, preserving its reason for audit events.
    Terminal allowlists intentionally match the rendered command target rather
    than the generic ``run_shell`` tool name.
    """

    def gate(kind: str, name: str, target: str) -> Decision:
        effective_name = target if kind == "terminal" else name
        return evaluate_permission(
            config,
            ActionRequest(
                kind=kind,
                name=effective_name,
                target=target or None,
                destructive=(name == "delete_file")
                or (kind == "terminal" and _destructive_command(target)),
                read_only=name == "read_file",
            ),
            workspace_root,
        )

    return gate
