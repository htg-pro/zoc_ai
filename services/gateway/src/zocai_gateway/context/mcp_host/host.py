"""The generic MCP host: lifecycle, aggregation, proxy, isolation (Part 4).

``MCPHost`` reads the effective ``MCP_Config`` (Default < User < Workspace),
starts each enabled stdio server independently, completes the MCP handshake,
discovers and aggregates tools under collision-free names, proxies tool calls
through the Trust_Gate + the run's approval channel, contains per-server
crashes, and exposes live server state.

The emit/approval channel is injected per call as ``emit`` (an
:class:`~shared_schema.agent_events.AgentEvent` sink, ``seq`` restamped by the
pipeline) and ``await_decision`` (returns ``"approve"``/``"reject"``), so the
host is unit-tested with in-process fakes and never touches a real subprocess,
network, or the SSE bus (design "Test seams").
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Awaitable, Callable, Mapping
from datetime import UTC, datetime
from pathlib import Path

from shared_schema.agent_events import AgentEvent, ApprovalEvent, CommandEvent

from .mcp_config import DEFAULT_CONFIG, build_mcp_config, eligible_to_start
from .models import (
    DEFAULT_CALL_TIMEOUT,
    DEFAULT_DISCOVERY_TIMEOUT,
    DEFAULT_STARTUP_TIMEOUT,
    ServerDefinition,
    ServerRuntimeState,
    SessionLike,
    TestFailure,
    TestOutcome,
    TestSuccess,
    TestUnsupported,
    TestValidationFailure,
    ToolCallError,
    ToolCallErrorKind,
    ToolCallOutcome,
    ToolCallSuccess,
)
from .registry import McpToolRegistry, record_for
from .session import ServerSession, SessionClosed, SessionError, SpawnProcess, default_spawn
from .trust import build_approval_prompt, is_auto_approved

__all__ = ["MCPHost", "SessionLike"]

EmitFn = Callable[[AgentEvent], None]
DecisionWaiter = Callable[[], Awaitable[str]]


SessionFactory = Callable[[ServerDefinition], SessionLike]


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _read_text(path: Path | str | None) -> str | None:
    if path is None:
        return None
    try:
        return Path(path).read_text(encoding="utf-8")
    except OSError:
        return None


class MCPHost:
    """Configuration-driven host for generic MCP servers (additive to MCPGateway)."""

    def __init__(
        self,
        *,
        workspace_root: Path | str = ".",
        user_config_path: Path | str | None = None,
        workspace_config_path: Path | str | None = None,
        registry: McpToolRegistry | None = None,
        default_config: tuple[ServerDefinition, ...] = DEFAULT_CONFIG,
        session_factory: SessionFactory | None = None,
        spawn: SpawnProcess = default_spawn,
        environ: Mapping[str, str] | None = None,
        startup_timeout: float = DEFAULT_STARTUP_TIMEOUT,
        discovery_timeout: float = DEFAULT_DISCOVERY_TIMEOUT,
        call_timeout: float = DEFAULT_CALL_TIMEOUT,
        now: Callable[[], str] = _now,
    ) -> None:
        self._workspace_root = Path(workspace_root).resolve()
        self._user_config_path = user_config_path
        self._workspace_config_path = workspace_config_path
        self._registry = registry if registry is not None else McpToolRegistry()
        self._default_config = default_config
        self._spawn = spawn
        self._environ = environ
        self._startup_timeout = startup_timeout
        self._discovery_timeout = discovery_timeout
        self._call_timeout = call_timeout
        self._now = now
        self._session_factory = session_factory or self._default_session_factory
        self._states: dict[str, ServerRuntimeState] = {}
        self._config: dict[str, ServerDefinition] = {}
        self._monitor_tasks: dict[str, asyncio.Task[None]] = {}

    @property
    def registry(self) -> McpToolRegistry:
        return self._registry

    def _default_session_factory(self, definition: ServerDefinition) -> SessionLike:
        argv = [definition.command or "", *definition.args]
        return ServerSession(
            definition.id,
            argv,
            workspace_root=self._workspace_root,
            env=definition.env,
            spawn=self._spawn,
            environ=self._environ,
        )

    def _build_config(self) -> dict[str, ServerDefinition]:
        return build_mcp_config(
            self._default_config,
            _read_text(self._user_config_path),
            _read_text(self._workspace_config_path),
        )

    # -- lifecycle ----------------------------------------------------------

    async def load(self) -> None:
        """Build MCP_Config and start each eligible server independently (R1.1, R2)."""
        self.configure()
        eligible = eligible_to_start(self._config)
        await asyncio.gather(
            *(self._start_server(definition) for definition in eligible),
            return_exceptions=True,
        )

    def configure(self) -> None:
        """Build MCP_Config and seed every server's state as ``stopped`` without
        opening any session or spawning any process. Lets the Settings surface
        list configured servers before (or without) starting them."""
        self._config = self._build_config()
        self._states = {
            definition.id: ServerRuntimeState(definition=definition, status="stopped")
            for definition in self._config.values()
        }

    async def reload(self) -> list[dict[str, object]]:
        """Re-read config and restart: close every live session, clear the
        registry, then recompute and start eligible servers (R1.11-R1.14).

        A full stop-then-start guarantees cleanup completes before any
        replacement starts and that the final state matches the recomputed
        config.
        """
        await self._shutdown_sessions()
        for server_id in list(self._states):
            self._registry.remove_server_tools(server_id)
        await self.load()
        return self.servers()

    async def _start_server(self, definition: ServerDefinition) -> None:
        """Run startup → handshake → discovery for one server; never raises."""
        state = self._states[definition.id]
        session = self._session_factory(definition)
        try:
            await session.start()
        except SessionError as exc:
            await self._fail(state, session, exc.category, exc.reason)
            return
        except OSError as exc:
            await self._fail(state, session, "spawn", str(exc))
            return
        except Exception as exc:
            await self._fail(state, session, "spawn", str(exc))
            return

        try:
            await session.initialize(self._startup_timeout)
        except SessionError as exc:
            await self._fail(state, session, exc.category, exc.reason)
            return
        except Exception as exc:
            await self._fail(state, session, "handshake", str(exc))
            return

        try:
            tools = await session.list_tools(self._discovery_timeout)
        except SessionError as exc:
            self._registry.remove_server_tools(definition.id)
            await self._fail(state, session, exc.category or "discovery", exc.reason)
            return
        except Exception as exc:
            self._registry.remove_server_tools(definition.id)
            await self._fail(state, session, "discovery", str(exc))
            return

        # Discovery success: atomically publish only this server's subset. An
        # empty list clears the subset while status stays 'running' (R4.5, R4.6).
        self._registry.replace_server_tools(
            definition.id, [record_for(definition.id, tool) for tool in tools]
        )
        state.session = session
        state.status = "running"
        state.error_reason = None
        wait_for_exit = getattr(session, "wait_for_exit", None)
        if callable(wait_for_exit):
            self._monitor_tasks[definition.id] = asyncio.create_task(
                self._monitor_server_exit(definition.id, session, wait_for_exit)
            )

    async def _monitor_server_exit(
        self,
        server_id: str,
        session: SessionLike,
        wait_for_exit: Callable[[], Awaitable[int]],
    ) -> None:
        """Convert an unexpected child exit into isolated server failure."""
        try:
            return_code = await wait_for_exit()
        except asyncio.CancelledError:
            return
        except Exception as exc:
            reason = f"process monitor failed: {exc}"
        else:
            reason = f"process exited with status {return_code}"
        state = self._states.get(server_id)
        if state is not None and state.session is session and state.status == "running":
            await self.notify_crash(server_id, reason)

    async def _fail(
        self, state: ServerRuntimeState, session: SessionLike, category: str, reason: str
    ) -> None:
        """Record an error status and reap the session's process (R2.12, R2.13)."""
        with contextlib.suppress(Exception):
            await session.aclose()
        state.session = None
        state.status = "error"
        state.error_reason = f"{state.definition.id}: {category} - {reason}"

    async def _shutdown_sessions(self) -> None:
        monitor_tasks = tuple(self._monitor_tasks.values())
        self._monitor_tasks.clear()
        for task in monitor_tasks:
            task.cancel()
        if monitor_tasks:
            await asyncio.gather(*monitor_tasks, return_exceptions=True)
        sessions: list[SessionLike] = []
        for state in self._states.values():
            if state.session is not None:
                sessions.append(state.session)
                state.session = None
        for session in sessions:
            with contextlib.suppress(Exception):
                await session.aclose()

    async def aclose(self) -> None:
        """Terminate and reap every process owned by the host (R9.4)."""
        await self._shutdown_sessions()

    async def notify_crash(self, server_id: str, reason: str = "server crashed") -> None:
        """Isolate a crashed server: drop only its tools + status, keep peers
        and the run intact (R8.1-R8.4, R18.5)."""
        state = self._states.get(server_id)
        if state is None:
            return
        self._registry.remove_server_tools(server_id)
        monitor = self._monitor_tasks.pop(server_id, None)
        current = asyncio.current_task()
        if monitor is not None and monitor is not current:
            monitor.cancel()
            await asyncio.gather(monitor, return_exceptions=True)
        session = state.session
        state.session = None
        if session is not None:
            with contextlib.suppress(Exception):
                await session.aclose()
        state.status = "error"
        state.error_reason = f"{server_id}: crash - {reason}"

    # -- introspection ------------------------------------------------------

    def servers(self) -> list[dict[str, object]]:
        """Serializable runtime state for Settings (R13.2)."""
        out: list[dict[str, object]] = []
        for server_id in sorted(self._states):
            state = self._states[server_id]
            definition = state.definition
            out.append(
                {
                    "id": definition.id,
                    "transport": definition.transport,
                    "scope": definition.scope,
                    "command": definition.command,
                    "args": list(definition.args),
                    "env": dict(definition.env),
                    "url": definition.url,
                    "disabled": definition.disabled,
                    "autoApprove": list(definition.auto_approve),
                    "status": state.status,
                    "errorReason": state.error_reason,
                }
            )
        return out

    # -- tool-call proxy (R6, R7, R12) --------------------------------------

    async def proxy_tool_call(
        self,
        namespaced_name: str,
        arguments: Mapping[str, object],
        *,
        run_id: str,
        emit: EmitFn,
        await_decision: DecisionWaiter,
    ) -> ToolCallOutcome:
        """Resolve → Trust_Gate → exactly one ``tools/call`` on the owning
        session; always returns a typed outcome (never raises, R6-R8)."""
        record = self._registry.get(namespaced_name)
        if record is None:
            return ToolCallError(
                server_id=None,
                tool=namespaced_name,
                kind=ToolCallErrorKind.UNAVAILABLE,
                reason="tool is not available",
            )
        state = self._states.get(record.server_id)
        if state is None or state.session is None or state.status != "running":
            return ToolCallError(
                server_id=record.server_id,
                tool=record.bare_name,
                kind=ToolCallErrorKind.UNAVAILABLE,
                reason="owning server is not running",
            )
        definition = state.definition

        # Trust_Gate: auto-approved iff exact member of autoApprove (R7.1-R7.3).
        if not is_auto_approved(definition, record.bare_name):
            emit(
                ApprovalEvent(
                    seq=0,
                    run_id=run_id,
                    ts=self._now(),
                    prompt=build_approval_prompt(definition, namespaced_name, arguments),
                )
            )
            decision = await await_decision()
            if decision != "approve":  # reject / anything else → declined, no call (R7.8)
                return ToolCallError(
                    server_id=record.server_id,
                    tool=record.bare_name,
                    kind=ToolCallErrorKind.DECLINED,
                    reason="user declined the tool call",
                )

        # Emit the command row (R12.1) right before the single tools/call.
        emit(
            CommandEvent(
                seq=0,
                run_id=run_id,
                ts=self._now(),
                command=namespaced_name,
                mcp_server_id=record.server_id,
            )
        )

        try:
            response = await state.session.call_tool(
                record.bare_name, arguments, self._call_timeout
            )
        except SessionClosed:
            await self.notify_crash(record.server_id, "session closed during call")
            return ToolCallError(
                server_id=record.server_id,
                tool=record.bare_name,
                kind=ToolCallErrorKind.FAILURE,
                reason="session closed during call",
            )
        except SessionError as exc:
            kind = (
                ToolCallErrorKind.TIMEOUT
                if exc.category == "timeout"
                else ToolCallErrorKind.FAILURE
            )
            return ToolCallError(
                server_id=record.server_id, tool=record.bare_name, kind=kind, reason=exc.reason
            )
        except Exception as exc:
            return ToolCallError(
                server_id=record.server_id,
                tool=record.bare_name,
                kind=ToolCallErrorKind.FAILURE,
                reason=str(exc),
            )

        result = response.get("result")
        if "error" in response or not isinstance(result, Mapping):
            # A JSON-RPC error response is a transport/protocol failure.
            return ToolCallError(
                server_id=record.server_id,
                tool=record.bare_name,
                kind=ToolCallErrorKind.FAILURE,
                reason="tool call returned an error response",
            )
        # Success — a tool-level ``isError`` result is carried through as-is (R6.3).
        return ToolCallSuccess(server_id=record.server_id, tool=record.bare_name, result=result)

    # -- candidate test (R11) -----------------------------------------------

    async def test_candidate(self, raw_definition: Mapping[str, object]) -> TestOutcome:
        """Test one candidate in full isolation from live state (R11)."""
        from .mcp_config import normalize_server  # local import: isolation helper

        server_id = raw_definition.get("id")
        raw = {k: v for k, v in raw_definition.items() if k != "id"}
        definition = normalize_server(
            server_id if isinstance(server_id, str) and server_id else "candidate",
            raw,
            "workspace",
        )
        if definition is None:
            return TestValidationFailure(reason="invalid server definition")
        if definition.transport != "stdio":
            return TestUnsupported(transport=definition.transport)

        session = self._session_factory(definition)
        try:
            await session.start()
            await session.initialize(self._startup_timeout)
            tools = await session.list_tools(self._discovery_timeout)
        except SessionError as exc:
            with contextlib.suppress(Exception):
                await session.aclose()
            return TestFailure(reason=f"{exc.category}: {exc.reason}")
        except Exception as exc:
            with contextlib.suppress(Exception):
                await session.aclose()
            return TestFailure(reason=str(exc))

        try:
            await session.aclose()
        except Exception as exc:
            return TestFailure(reason=f"cleanup failed: {exc}")
        return TestSuccess(tool_count=len(tools), bare_names=tuple(tool.name for tool in tools))
