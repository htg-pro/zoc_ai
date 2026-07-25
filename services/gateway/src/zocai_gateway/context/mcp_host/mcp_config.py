"""Config load/merge/validity + the built-in Default_Config (Part 4, R1, R17).

A faithful Python port of ``apps/frontend/src/lib/mcp-config.ts`` so the two
never drift: the same JSONC parse, the same ``detectTransport`` rules, the same
``normalizeServer`` validity gate, and the same replace-by-``id`` merge. On top
of that it adds a built-in ``DEFAULT_CONFIG`` base layer for the three bundled
servers, with precedence ``Workspace > User > Default`` by ``id``.
"""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import cast

from .models import Scope, ServerDefinition, Transport

__all__ = [
    "DEFAULT_CONFIG",
    "build_mcp_config",
    "detect_transport",
    "eligible_to_start",
    "merge",
    "normalize_server",
    "parse_config",
    "strip_json_comments",
]


def strip_json_comments(text: str) -> str:
    """Remove ``//`` line and ``/* */`` block comments, preserving string
    literals (a Python twin of the frontend ``stripJsonComments``)."""
    out: list[str] = []
    i = 0
    n = len(text)
    in_string = False
    string_quote = ""
    while i < n:
        ch = text[i]
        if in_string:
            out.append(ch)
            if ch == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if ch == string_quote:
                in_string = False
            i += 1
            continue
        if ch in ('"', "'"):
            in_string = True
            string_quote = ch
            out.append(ch)
            i += 1
            continue
        if ch == "/" and i + 1 < n and text[i + 1] == "/":
            i += 2
            while i < n and text[i] not in ("\n", "\r"):
                i += 1
            continue
        if ch == "/" and i + 1 < n and text[i + 1] == "*":
            i += 2
            while i + 1 < n and not (text[i] == "*" and text[i + 1] == "/"):
                i += 1
            i += 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _as_string_tuple(value: object) -> tuple[str, ...]:
    if isinstance(value, list):
        return tuple(x for x in value if isinstance(x, str))
    return ()


def _as_string_mapping(value: object) -> dict[str, str]:
    out: dict[str, str] = {}
    if isinstance(value, Mapping):
        for key, val in value.items():
            if isinstance(key, str) and isinstance(val, str):
                out[key] = val
    return out


def detect_transport(raw: Mapping[str, object]) -> Transport:
    """Explicit ``transport``/``type`` wins; else ``command`` → stdio,
    ``url`` → sse; default stdio (mirror of ``detectTransport``)."""
    transport_val = raw.get("transport")
    explicit: object = transport_val if isinstance(transport_val, str) else raw.get("type")
    if isinstance(explicit, str):
        t = explicit.lower()
        if t == "stdio":
            return "stdio"
        if t in ("http", "streamable-http", "streamablehttp"):
            return "http"
        if t == "sse":
            return "sse"
    if isinstance(raw.get("command"), str):
        return "stdio"
    if isinstance(raw.get("url"), str):
        return "sse"
    return "stdio"


def normalize_server(
    server_id: str, raw: Mapping[str, object], scope: Scope
) -> ServerDefinition | None:
    """Normalize one raw entry, or ``None`` when invalid (R1.8).

    A stdio definition requires a non-empty ``command``; an sse/http definition
    requires a non-empty ``url``.
    """
    transport = detect_transport(raw)
    command: str | None = None
    url: str | None = None
    if transport == "stdio":
        cmd = raw.get("command")
        if not isinstance(cmd, str) or len(cmd) == 0:
            return None
        command = cmd
    else:
        endpoint = raw.get("url")
        if not isinstance(endpoint, str) or len(endpoint) == 0:
            return None
        url = endpoint
    return ServerDefinition(
        id=server_id,
        transport=transport,
        command=command,
        args=_as_string_tuple(raw.get("args")),
        env=_as_string_mapping(raw.get("env")),
        url=url,
        auto_approve=_as_string_tuple(raw.get("autoApprove")),
        disabled=raw.get("disabled") is True,
        scope=scope,
    )


def parse_config(text: str, scope: Scope) -> list[ServerDefinition]:
    """Parse one JSONC config document into valid definitions (R1.9).

    Empty text, invalid JSONC, a missing/non-object ``mcpServers``, or an empty
    map all yield ``[]``. Invalid individual entries are dropped.
    """
    try:
        doc = json.loads(strip_json_comments(text))
    except (json.JSONDecodeError, ValueError):
        return []
    if not isinstance(doc, Mapping):
        return []
    servers = doc.get("mcpServers")
    if not isinstance(servers, Mapping):
        return []
    out: list[ServerDefinition] = []
    for server_id, raw in servers.items():
        if not isinstance(server_id, str) or not isinstance(raw, Mapping):
            continue
        definition = normalize_server(server_id, cast("Mapping[str, object]", raw), scope)
        if definition is not None:
            out.append(definition)
    return out


def merge(
    user: list[ServerDefinition], workspace: list[ServerDefinition]
) -> dict[str, ServerDefinition]:
    """Merge user + workspace by ``id``; a workspace entry replaces the whole
    user definition with the same ``id`` (no field blend, R1.2)."""
    by_id: dict[str, ServerDefinition] = {}
    for definition in user:
        by_id[definition.id] = definition
    for definition in workspace:
        by_id[definition.id] = definition
    return by_id


def build_mcp_config(
    default: tuple[ServerDefinition, ...], user_text: str | None, workspace_text: str | None
) -> dict[str, ServerDefinition]:
    """Compose the effective MCP_Config with precedence ``Workspace > User >
    Default`` by ``id`` (R1.1, R1.10, R17.5, R17.6)."""
    by_id: dict[str, ServerDefinition] = {}
    for definition in default:
        by_id[definition.id] = definition
    for definition in parse_config(user_text, "user") if user_text else []:
        by_id[definition.id] = definition
    for definition in parse_config(workspace_text, "workspace") if workspace_text else []:
        by_id[definition.id] = definition
    return by_id


def eligible_to_start(config: Mapping[str, ServerDefinition]) -> list[ServerDefinition]:
    """The definitions that open a live session: enabled stdio only (R1.6,
    R3.1, R3.3). Disabled and sse/http definitions are excluded."""
    return [
        definition
        for definition in config.values()
        if not definition.disabled and definition.transport == "stdio"
    ]


def _bundled(server_id: str, module: str, tools: tuple[str, ...]) -> ServerDefinition:
    """Build one enabled bundled-server definition for this runtime.

    In source/development runs the child is a normal Python interpreter and the
    repository's ``services`` directory is prepended to ``PYTHONPATH`` so the
    standalone ``mcp_servers`` package remains importable from any workspace
    cwd. In a PyInstaller build ``sys.executable`` is the sidecar itself, so its
    allowlisted ``--mcp-server`` dispatcher is used instead.
    """
    frozen = bool(getattr(sys, "frozen", False))
    args = ("--mcp-server", module) if frozen else ("-m", f"mcp_servers.{module}")
    env: dict[str, str] = {}
    if not frozen:
        services_root = Path(__file__).resolve().parents[5]
        if (services_root / "mcp_servers").is_dir():
            inherited = os.environ.get("PYTHONPATH", "")
            env["PYTHONPATH"] = os.pathsep.join(
                part for part in (str(services_root), inherited) if part
            )
    return ServerDefinition(
        id=server_id,
        transport="stdio",
        command=sys.executable,
        args=args,
        env=env,
        url=None,
        auto_approve=tools,
        disabled=False,
        scope="workspace",
    )


# The three bundled servers (R17.1-R17.4). No filesystem MCP server (R17.8);
# the fixed MCPGateway tools are a separate surface and are never touched (R17.9).
DEFAULT_CONFIG: tuple[ServerDefinition, ...] = (
    _bundled("web-search", "web_search", ("web_search",)),
    _bundled("docs", "docs", ("fetch_docs", "search_npm", "search_pypi")),
    _bundled("git-history", "git_history", ("git_log", "git_blame", "git_show")),
)
