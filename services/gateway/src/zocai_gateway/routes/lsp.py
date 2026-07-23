"""WebSocket ↔ stdio LSP proxy (Part 3, §3.1).

A browser Monaco ``MonacoLanguageClient`` speaks the Language Server Protocol as
newline-free JSON-RPC messages over a WebSocket. A real language server
(``pyright``, ``typescript-language-server``, ``rust-analyzer``) speaks the same
protocol over stdio using ``Content-Length`` framing. This module bridges the
two: it spawns the requested server as a subprocess and pumps JSON-RPC messages
in both directions, translating between WebSocket text frames and the stdio
framing, injecting the workspace ``rootUri`` into the ``initialize`` request, and
killing the subprocess when the socket closes.

Security posture: the gateway binds loopback-only (R12), and this proxy will
**only** spawn a server whose name is a key of :data:`LSP_SERVERS` — an unknown
name is rejected before any process starts. The command line is fixed by the
allowlist (never taken from the client) and the process runs with ``cwd`` pinned
to the run's workspace root, so a client cannot choose an arbitrary binary or
escape the workspace.

The core here is deliberately free of any FastAPI import: the WebSocket and the
subprocess are both narrow :class:`typing.Protocol` seams, so the proxy is unit
tested with an in-memory fake socket and a fake process — no real language-server
binary required. :func:`zocai_gateway.app.create_app` supplies the real FastAPI
``WebSocket`` and the default asyncio-subprocess spawner.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import Awaitable, Callable, Sequence
from pathlib import Path
from typing import Protocol

__all__ = [
    "ABNORMAL_SERVER_TERMINATION_CLOSE_CODE",
    "LSP_SERVERS",
    "SERVER_NOT_INSTALLED_CLOSE_CODE",
    "UNKNOWN_SERVER_CLOSE_CODE",
    "AsyncByteReader",
    "AsyncByteWriter",
    "LspProcess",
    "LspWebSocket",
    "SpawnProcess",
    "default_spawn",
    "frame_message",
    "inject_root_uri",
    "proxy_lsp",
    "read_framed_message",
    "resolve_server_command",
]

# Allowlist: WebSocket server-name key → the argv used to launch that server
# over stdio. Only these logical servers can ever be spawned (an unknown key is
# rejected before any process starts). ``pyright``'s language server binary is
# ``pyright-langserver`` (the ``pyright`` command is the one-shot type checker),
# so the logical name and the real binary intentionally differ.
LSP_SERVERS: dict[str, tuple[str, ...]] = {
    "typescript-language-server": ("typescript-language-server", "--stdio"),
    "pyright": ("pyright-langserver", "--stdio"),
    "rust-analyzer": ("rust-analyzer",),
}

# WebSocket close codes in the 4000-4999 application-private range, so they
# never collide with a protocol-level code. These names are kept in sync with
# the frontend mirror in `apps/frontend/src/features/editor/lsp/lsp-connection.ts`.
UNKNOWN_SERVER_CLOSE_CODE = 4004  # requested server name is not allowlisted
SERVER_NOT_INSTALLED_CLOSE_CODE = 4041  # Server_Binary missing on PATH (R6.2)
ABNORMAL_SERVER_TERMINATION_CLOSE_CODE = 4050  # subprocess exit / spawn failure (R6.3, R6.7)


def resolve_server_command(server_name: str) -> tuple[str, ...] | None:
    """Return the allowlisted argv for ``server_name``, or ``None`` if unknown."""
    return LSP_SERVERS.get(server_name)


# -- transport seams --------------------------------------------------------


class AsyncByteReader(Protocol):
    """The byte-reading surface the proxy needs from a process's stdout.

    Structurally satisfied by :class:`asyncio.StreamReader`.
    """

    async def readline(self) -> bytes: ...

    async def readexactly(self, n: int) -> bytes: ...


class AsyncByteWriter(Protocol):
    """The byte-writing surface the proxy needs for a process's stdin.

    Structurally satisfied by :class:`asyncio.StreamWriter`.
    """

    def write(self, data: bytes) -> None: ...

    async def drain(self) -> None: ...


class LspProcess(Protocol):
    """The subset of an asyncio subprocess the proxy relies on.

    Structurally satisfied by :class:`asyncio.subprocess.Process`.
    """

    @property
    def stdin(self) -> AsyncByteWriter | None: ...

    @property
    def stdout(self) -> AsyncByteReader | None: ...

    def terminate(self) -> None: ...

    async def wait(self) -> int: ...


class LspWebSocket(Protocol):
    """The subset of a WebSocket the proxy relies on.

    Structurally satisfied by :class:`fastapi.WebSocket`.
    """

    async def accept(self) -> None: ...

    async def receive_text(self) -> str: ...

    async def send_text(self, data: str) -> None: ...

    async def close(self, code: int = ...) -> None: ...


# Injectable process factory: launch ``argv`` with ``cwd`` and return a process.
SpawnProcess = Callable[[Sequence[str], Path], Awaitable[LspProcess]]


async def default_spawn(argv: Sequence[str], cwd: Path) -> LspProcess:
    """Spawn a stdio language server as an asyncio subprocess (the default seam).

    stderr is discarded so an unread stderr pipe can never dead-lock the
    server; stdin/stdout carry the JSON-RPC stream the proxy pumps.
    """
    return await asyncio.create_subprocess_exec(
        *argv,
        cwd=cwd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )


# -- JSON-RPC / LSP framing -------------------------------------------------


def frame_message(payload: str) -> bytes:
    """Frame a JSON-RPC ``payload`` with the LSP ``Content-Length`` header."""
    body = payload.encode("utf-8")
    header = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
    return header + body


async def read_framed_message(reader: AsyncByteReader) -> str | None:
    """Read one ``Content-Length``-framed JSON-RPC message from ``reader``.

    Returns the decoded JSON payload, or ``None`` at end of stream (the server
    closed stdout) or when a header block carries no usable ``Content-Length``.
    """
    content_length: int | None = None
    while True:
        line = await reader.readline()
        if not line:  # EOF: the server closed its stdout.
            return None
        stripped = line.strip()
        if not stripped:  # blank line terminates the header block.
            break
        if stripped.lower().startswith(b"content-length:"):
            try:
                content_length = int(stripped.split(b":", 1)[1].strip())
            except ValueError:
                content_length = None
    if content_length is None or content_length < 0:
        return None
    body = await reader.readexactly(content_length)
    return body.decode("utf-8")


def inject_root_uri(payload: str, workspace_root: Path) -> str:
    """Set the workspace ``rootUri`` on an ``initialize`` request (§3.1 step 3).

    The client's ``initialize`` request is patched so the server roots itself at
    the run's workspace: ``rootUri``, the legacy ``rootPath``, and a single
    ``workspaceFolders`` entry are all set to ``workspace_root``. Any other
    message — or an unparseable one — is returned unchanged.
    """
    try:
        message = json.loads(payload)
    except (json.JSONDecodeError, ValueError):
        return payload
    if not isinstance(message, dict) or message.get("method") != "initialize":
        return payload

    params = message.get("params")
    if not isinstance(params, dict):
        params = {}
        message["params"] = params

    root_uri = workspace_root.as_uri()
    params["rootUri"] = root_uri
    params["rootPath"] = str(workspace_root)
    params["workspaceFolders"] = [{"uri": root_uri, "name": workspace_root.name}]
    return json.dumps(message)


# -- the proxy ---------------------------------------------------------------


async def _pump_ws_to_process(
    ws: LspWebSocket, stdin: AsyncByteWriter, workspace_root: Path
) -> None:
    """Client → server: read WS text frames, frame them onto the process stdin."""
    while True:
        try:
            text = await ws.receive_text()
        except Exception:
            # Any receive error (disconnect / transport failure) ends the pump.
            return
        framed = frame_message(inject_root_uri(text, workspace_root))
        try:
            stdin.write(framed)
            await stdin.drain()
        except Exception:
            return


async def _pump_process_to_ws(stdout: AsyncByteReader, ws: LspWebSocket) -> None:
    """Server → client: read framed stdout messages, send them as WS text."""
    while True:
        try:
            payload = await read_framed_message(stdout)
        except Exception:
            # A truncated/failed read (e.g. the server died mid-message) ends it.
            return
        if payload is None:  # server closed stdout.
            return
        try:
            await ws.send_text(payload)
        except Exception:
            return


def _terminate(process: LspProcess) -> None:
    """Best-effort terminate; never raise from cleanup."""
    with contextlib.suppress(Exception):
        process.terminate()


async def proxy_lsp(
    ws: LspWebSocket,
    server_name: str,
    *,
    workspace_root: Path | str = ".",
    spawn: SpawnProcess = default_spawn,
) -> None:
    """Proxy a WebSocket LSP client to an allowlisted stdio language server.

    1. Resolve ``server_name`` against :data:`LSP_SERVERS`; an unknown name is
       rejected (the socket is closed with :data:`UNKNOWN_SERVER_CLOSE_CODE`)
       before any process is spawned.
    2. Accept the socket, spawn the server with ``cwd`` pinned to the workspace,
       and pump JSON-RPC in both directions (patching ``initialize`` with the
       workspace ``rootUri``).
    3. When either side ends (client disconnects or server exits), the process
       is terminated so no orphan language server is left behind.

    Error signaling (R6): a missing ``Server_Binary`` closes with
    :data:`SERVER_NOT_INSTALLED_CLOSE_CODE`; any other spawn failure or an
    abnormal subprocess exit while the socket is open closes with
    :data:`ABNORMAL_SERVER_TERMINATION_CLOSE_CODE`. A client-initiated
    disconnect is normal and sends no application close code.
    """
    argv = resolve_server_command(server_name)
    if argv is None:
        await ws.close(code=UNKNOWN_SERVER_CLOSE_CODE)  # R7.3, before accept, no spawn
        return

    root = Path(workspace_root).resolve()
    await ws.accept()

    # Spawn after ``accept`` so the client receives a clean close frame carrying
    # the Application_Close_Code it can read. A missing Server_Binary surfaces as
    # ``FileNotFoundError`` (R6.2); any other spawn failure — e.g.
    # ``PermissionError`` — is an abnormal termination (R6.7). Because
    # ``FileNotFoundError`` is a subclass of ``OSError``, it is caught first.
    try:
        process = await spawn(argv, root)  # R6.1, cwd pinned to root (R7.4)
    except FileNotFoundError:
        await ws.close(code=SERVER_NOT_INSTALLED_CLOSE_CODE)  # R6.2 (no unhandled error)
        return
    except OSError:
        await ws.close(code=ABNORMAL_SERVER_TERMINATION_CLOSE_CODE)  # R6.7
        return

    close_code: int | None = None
    try:
        stdin = process.stdin
        stdout = process.stdout
        if stdin is None or stdout is None:
            # No stdio to pump — the process can't serve LSP, so treat it as an
            # abnormal termination rather than a silent close.
            close_code = ABNORMAL_SERVER_TERMINATION_CLOSE_CODE
            return
        # Three tasks: the client→server pump, the server→client pump, and a
        # watcher on ``process.wait()``. If the server side ends the session
        # (its stdout pump finishes on EOF, or the process exits) while the
        # client pump is still live, that is an abnormal termination (R6.3).
        client_task = asyncio.create_task(_pump_ws_to_process(ws, stdin, root))
        server_task = asyncio.create_task(_pump_process_to_ws(stdout, ws))
        exit_task = asyncio.create_task(process.wait())
        done, pending = await asyncio.wait(
            {client_task, server_task, exit_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        # "client_task not in done" ensures a client-initiated close is never
        # mislabeled abnormal, even when the server stream ends in the same
        # scheduling batch (keeps the existing disconnect tests green).
        if client_task not in done and (server_task in done or exit_task in done):
            close_code = ABNORMAL_SERVER_TERMINATION_CLOSE_CODE  # R6.3
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
    finally:
        # Kill the server on socket close (§3.1 step 4, R6.4) and reap it.
        _terminate(process)
        with contextlib.suppress(Exception):
            await asyncio.wait_for(process.wait(), timeout=5.0)
        # Send the application close code (if any) after the subprocess is torn
        # down, so the client always learns why the session ended.
        if close_code is not None:
            with contextlib.suppress(Exception):
                await ws.close(code=close_code)
