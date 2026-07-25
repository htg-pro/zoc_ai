"""Shared data models for the generic MCP host (Part 4, §4.1).

Every ``mcp_host`` module imports these interfaces: the normalized server
definition (a faithful mirror of ``McpServer`` in
``apps/frontend/src/lib/mcp-config.ts``), the raw/aggregated tool records, the
per-server runtime state, and the two typed-outcome unions.

The host follows the "never raise into the run, return a typed value" contract
established by :mod:`zocai_gateway.context.mcp_gateway`: transport/host faults
become a :class:`ToolCallError` (or an ``error`` :class:`ServerRuntimeState`),
never an exception that escapes into the agent run.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import Enum
from typing import Literal, Protocol

__all__ = [
    "DEFAULT_CALL_TIMEOUT",
    "DEFAULT_DISCOVERY_TIMEOUT",
    "DEFAULT_STARTUP_TIMEOUT",
    "McpToolRecord",
    "RawTool",
    "Scope",
    "ServerDefinition",
    "ServerRuntimeState",
    "ServerStatus",
    "SessionLike",
    "TestFailure",
    "TestOutcome",
    "TestSuccess",
    "TestUnsupported",
    "TestValidationFailure",
    "ToolCallError",
    "ToolCallErrorKind",
    "ToolCallOutcome",
    "ToolCallSuccess",
    "Transport",
]

Transport = Literal["stdio", "sse", "http"]
Scope = Literal["user", "workspace"]
ServerStatus = Literal["running", "stopped", "error"]

# Default wall-clock budgets (seconds); overridable per MCPHost instance.
DEFAULT_STARTUP_TIMEOUT = 30.0
DEFAULT_DISCOVERY_TIMEOUT = 30.0
DEFAULT_CALL_TIMEOUT = 60.0


@dataclass(frozen=True)
class ServerDefinition:
    """A normalized MCP server definition (mirror of ``McpServer`` in TS).

    ``args`` element boundaries and ``env`` string entries are preserved exactly
    (R2.1, R2.2). Validity is decided at normalization time: a stdio definition
    requires a non-empty ``command``; an sse/http definition requires a non-empty
    ``url`` (R1.8).
    """

    id: str
    transport: Transport
    command: str | None = None
    args: tuple[str, ...] = ()
    env: Mapping[str, str] = field(default_factory=dict)
    url: str | None = None
    auto_approve: tuple[str, ...] = ()
    disabled: bool = False
    scope: Scope = "workspace"


@dataclass(frozen=True)
class RawTool:
    """A tool exactly as reported by a server's ``tools/list`` response."""

    name: str
    input_schema: Mapping[str, object] = field(default_factory=dict)
    description: str | None = None


@dataclass(frozen=True)
class McpToolRecord:
    """An aggregated tool: its owning server, bare name, and injective alias.

    ``namespaced_name`` is ``"mcp::" + esc(server_id) + "::" + esc(bare_name)``
    (see :mod:`.registry`), collision-free by construction (R4.1, R4.2). The
    owning ``server_id``, ``bare_name``, ``input_schema``, and ``description``
    are preserved exactly from discovery (R4.3).
    """

    server_id: str
    bare_name: str
    namespaced_name: str
    input_schema: Mapping[str, object] = field(default_factory=dict)
    description: str | None = None


class SessionLike(Protocol):
    """The session surface :class:`MCPHost` drives (a real ``ServerSession`` or a fake)."""

    async def start(self) -> None: ...
    async def initialize(self, timeout: float) -> None: ...
    async def list_tools(self, timeout: float) -> list[RawTool]: ...
    async def call_tool(
        self, bare_name: str, arguments: Mapping[str, object], timeout: float
    ) -> dict[str, object]: ...
    async def aclose(self) -> None: ...


@dataclass
class ServerRuntimeState:
    """Mutable per-server runtime state held by :class:`MCPHost`.

    ``error_reason`` is present iff ``status == "error"`` and names the server
    ``id`` plus a category (``spawn`` / ``handshake`` / ``startup-timeout`` /
    ``discovery`` / ``crash``). ``session`` is present only while a live stdio
    session is open.
    """

    definition: ServerDefinition
    status: ServerStatus = "stopped"
    error_reason: str | None = None
    session: SessionLike | None = None


class ToolCallErrorKind(str, Enum):
    """Typed transport/host failure kinds for a proxied tool call."""

    UNAVAILABLE = "unavailable"  # name not aggregated / session gone (R6.4, R6.6)
    TIMEOUT = "timeout"  # per-call wall-clock budget exceeded (R6.5, R9.2)
    FAILURE = "failure"  # transport failure / session failed mid-call (R6.5)
    DECLINED = "declined"  # Trust_Gate rejected (R7.8)


@dataclass(frozen=True)
class ToolCallSuccess:
    """A completed tool call. ``result`` may itself carry a tool-level
    ``isError`` payload from a healthy server (the two-level error model, R6.3)."""

    server_id: str
    tool: str
    result: Mapping[str, object]


@dataclass(frozen=True)
class ToolCallError:
    """A transport/host failure carrying no partial content (R6.7)."""

    server_id: str | None
    tool: str
    kind: ToolCallErrorKind
    reason: str


ToolCallOutcome = ToolCallSuccess | ToolCallError


@dataclass(frozen=True)
class TestSuccess:
    """A candidate that started, initialized, and discovered tools (count ≥ 0)."""

    tool_count: int
    bare_names: tuple[str, ...]


@dataclass(frozen=True)
class TestValidationFailure:
    """An invalid candidate: no process, message, or network attempt (R11.2)."""

    reason: str


@dataclass(frozen=True)
class TestFailure:
    """A startup/handshake/discovery/cleanup failure during candidate test."""

    reason: str


@dataclass(frozen=True)
class TestUnsupported:
    """An sse/http candidate: not live-testable in v1, no network (R11.7)."""

    transport: Literal["sse", "http"]


TestOutcome = TestSuccess | TestValidationFailure | TestFailure | TestUnsupported
