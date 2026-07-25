"""One live stdio MCP server session (Part 4, R2, R4, R6, R9, R18).

Owns a single spawned server process and speaks MCP over newline JSON-RPC. The
subprocess is an injected :data:`SpawnProcess` seam (the same pattern as
:mod:`zocai_gateway.routes.lsp`), so sessions are unit-tested with an in-memory
fake process — no real subprocess.

Usage is serial (``start`` → ``initialize`` → ``list_tools`` → ``call_tool*`` →
``aclose``). Handshake ordering is guaranteed by construction: ``initialize``
blocks until the matching valid response arrives before sending
``notifications/initialized`` and before any ``tools/list`` (R2.5). A stdout EOF
during a request surfaces as :class:`SessionClosed` (the crash path, R18.5).
"""

from __future__ import annotations

import asyncio
import contextlib
import os
from collections.abc import Awaitable, Callable, Mapping, Sequence
from pathlib import Path
from typing import Protocol

from .framing import AsyncByteReader, Eof, JsonRpcMessage, encode_message, read_message
from .models import RawTool

__all__ = [
    "AsyncByteWriter",
    "McpProcess",
    "ServerSession",
    "SessionClosed",
    "SessionError",
    "SpawnProcess",
    "default_spawn",
]

PROTOCOL_VERSION = "2024-11-05"
_CLIENT_INFO = {"name": "zoc-studio", "version": "0.0.1"}


class SessionError(Exception):
    """A session-level failure carrying a category naming the failed phase."""

    def __init__(self, category: str, reason: str) -> None:
        self.category = category
        self.reason = reason
        super().__init__(f"{category}: {reason}")


class SessionClosed(SessionError):
    """The server closed its stdout / exited (EOF), i.e. a crash (R18.5)."""

    def __init__(self, reason: str = "server stream closed") -> None:
        super().__init__("crash", reason)


class AsyncByteWriter(Protocol):
    """The byte-writing surface the session needs for a process's stdin."""

    def write(self, data: bytes) -> None: ...

    async def drain(self) -> None: ...


class McpProcess(Protocol):
    """The subset of an asyncio subprocess the session relies on."""

    @property
    def stdin(self) -> AsyncByteWriter | None: ...

    @property
    def stdout(self) -> AsyncByteReader | None: ...

    def terminate(self) -> None: ...

    async def wait(self) -> int: ...


SpawnProcess = Callable[[Sequence[str], Path, Mapping[str, str]], Awaitable[McpProcess]]


async def default_spawn(argv: Sequence[str], cwd: Path, env: Mapping[str, str]) -> McpProcess:
    """Spawn a stdio MCP server (the default seam). ``argv`` is a list, never a
    shell string (R9.1); ``env`` is the already-overlaid environment; stderr is
    discarded so an unread pipe can't deadlock the server."""
    return await asyncio.create_subprocess_exec(
        *argv,
        cwd=cwd,
        env=dict(env),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )


class ServerSession:
    """A single live MCP stdio session over an injected spawn seam."""

    def __init__(
        self,
        definition_id: str,
        argv: Sequence[str],
        *,
        workspace_root: Path | str = ".",
        env: Mapping[str, str] | None = None,
        spawn: SpawnProcess = default_spawn,
        environ: Mapping[str, str] | None = None,
    ) -> None:
        self._id = definition_id
        self._argv = list(argv)
        self._root = Path(workspace_root).resolve()
        self._config_env = dict(env or {})
        self._spawn = spawn
        self._inherited_env = dict(os.environ if environ is None else environ)
        self._process: McpProcess | None = None
        self._reader: AsyncByteReader | None = None
        self._writer: AsyncByteWriter | None = None
        self._next_id = 0
        self._request_lock = asyncio.Lock()
        self._initialized = False
        self._closed = False

    @property
    def process(self) -> McpProcess | None:
        return self._process

    def _merged_env(self) -> dict[str, str]:
        """Inherited environment updated by the configured entries (R2.2)."""
        merged = dict(self._inherited_env)
        merged.update(self._config_env)
        return merged

    async def start(self) -> None:
        """Spawn the server process with argv=[command, *args], cwd pinned to
        the workspace root, and the overlaid environment (R2.1-R2.3).

        The cwd is pinned deliberately and is never allowed to default to the
        sidecar's own working directory: in a packaged build that directory is
        the application's install/bin path, so an MCP server started there would
        read and write next to the executable instead of inside the user's
        project.
        """
        if not self._root.is_dir():
            raise SessionError(
                "spawn",
                "workspace root is not an existing directory; open a project "
                "folder before starting MCP servers",
            )
        self._process = await self._spawn(self._argv, self._root, self._merged_env())
        self._reader = self._process.stdout
        self._writer = self._process.stdin
        if self._reader is None or self._writer is None:
            raise SessionError("spawn", "process has no stdio pipes")

    async def _send(self, message: JsonRpcMessage) -> None:
        if self._writer is None:
            raise SessionError("failure", "session not started")
        self._writer.write(encode_message(message))
        await self._writer.drain()

    def roots_result(self) -> list[dict[str, str]]:
        """The ``roots/list`` answer: the pinned workspace root (R2.6)."""
        return [{"uri": self._root.as_uri(), "name": self._root.name}]

    async def _handle_server_request(self, message: JsonRpcMessage) -> None:
        method = message.get("method")
        request_id = message.get("id")
        if method == "roots/list":
            await self._send(
                {"jsonrpc": "2.0", "id": request_id, "result": {"roots": self.roots_result()}}
            )
        else:  # unknown server→client request: reply method-not-found, keep going.
            await self._send(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {"code": -32601, "message": "method not found"},
                }
            )

    async def _await_response(self, request_id: int) -> JsonRpcMessage:
        if self._reader is None:
            raise SessionError("failure", "session not started")
        while True:
            message = await read_message(self._reader)
            if isinstance(message, Eof):
                raise SessionClosed
            if "method" in message and "id" in message:
                await self._handle_server_request(message)  # server request; answer + continue
                continue
            if "method" in message:  # notification from server; ignore
                continue
            if message.get("id") == request_id:
                return message
            # A response for another id (shouldn't happen in serial use); ignore.

    async def _request(
        self, method: str, params: Mapping[str, object], timeout: float, category: str
    ) -> JsonRpcMessage:
        async with self._request_lock:
            return await self._request_serial(method, params, timeout, category)

    async def _request_serial(
        self, method: str, params: Mapping[str, object], timeout: float, category: str
    ) -> JsonRpcMessage:
        self._next_id += 1
        request_id = self._next_id
        await self._send(
            {"jsonrpc": "2.0", "id": request_id, "method": method, "params": dict(params)}
        )
        try:
            return await asyncio.wait_for(self._await_response(request_id), timeout)
        except TimeoutError as exc:
            raise SessionError(category, f"{method} timed out") from exc

    async def initialize(self, timeout: float) -> None:
        """Complete the MCP handshake: send ``initialize`` and, only after the
        matching valid response, send ``notifications/initialized`` (R2.4-R2.8)."""
        response = await self._request(
            "initialize",
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"roots": {"listChanged": False}},
                "clientInfo": _CLIENT_INFO,
            },
            timeout,
            "startup-timeout",
        )
        if "error" in response or not isinstance(response.get("result"), Mapping):
            raise SessionError("handshake", "invalid initialize response")
        self._initialized = True
        await self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    async def list_tools(self, timeout: float) -> list[RawTool]:
        """Discover tools via ``tools/list`` (R4). Requires ``initialize`` first."""
        if not self._initialized:
            raise SessionError("discovery", "list_tools before initialize")
        response = await self._request("tools/list", {}, timeout, "discovery")
        result = response.get("result")
        if "error" in response or not isinstance(result, Mapping):
            raise SessionError("discovery", "invalid tools/list response")
        raw_tools = result.get("tools")
        if not isinstance(raw_tools, list):
            raise SessionError("discovery", "tools/list missing tools array")
        out: list[RawTool] = []
        for entry in raw_tools:
            if not isinstance(entry, Mapping):
                continue
            name = entry.get("name")
            if not isinstance(name, str) or not name:
                continue
            schema = entry.get("inputSchema")
            description = entry.get("description")
            out.append(
                RawTool(
                    name=name,
                    input_schema=schema if isinstance(schema, Mapping) else {},
                    description=description if isinstance(description, str) else None,
                )
            )
        return out

    async def call_tool(
        self, bare_name: str, arguments: Mapping[str, object], timeout: float
    ) -> JsonRpcMessage:
        """Send exactly one ``tools/call`` and return the raw response (R6.1)."""
        return await self._request(
            "tools/call", {"name": bare_name, "arguments": dict(arguments)}, timeout, "timeout"
        )

    async def wait_for_exit(self) -> int:
        """Wait for the owned child process to exit.

        The host uses this non-reading monitor to detect idle server crashes
        without racing the serial JSON-RPC stdout reader.
        """
        process = self._process
        if process is None:
            raise SessionClosed("session has no process")
        return await process.wait()

    async def aclose(self) -> None:
        """Terminate and reap the process; idempotent (R9.3)."""
        if self._closed:
            return
        self._closed = True
        process = self._process
        self._process = None
        self._reader = None
        self._writer = None
        if process is None:
            return
        with contextlib.suppress(Exception):
            process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=5.0)
        except TimeoutError:
            killer = getattr(process, "kill", None)
            if callable(killer):
                with contextlib.suppress(Exception):
                    killer()
            with contextlib.suppress(Exception):
                await asyncio.wait_for(process.wait(), timeout=5.0)
        except Exception:
            pass
