"""Reusable stdio MCP server scaffold (Part 4, §4.2, R18).

A bundled MCP server is a standalone program that speaks newline-delimited
JSON-RPC over stdio: every message is exactly one compact ``json.dumps``
serialization followed by a single ``"\\n"`` terminator, and every input line is
exactly one JSON object (R18.1, R18.2). This module provides:

* :class:`Server` — a small registry of :class:`Tool` handlers plus a blocking
  :meth:`Server.serve` loop over a byte stdin/stdout pair.
* :func:`handle_request` — the pure request-dispatch function that drives the
  loop, exposed directly so tests exercise the protocol without real stdio.
* :func:`text_result` / :func:`error_result` — the two tool-result envelope
  builders. A tool handler returns either a normal result or an ``isError``
  envelope; that two-level model keeps a tool-level failure distinct from a
  transport/JSON-RPC error.

The scaffold answers ``initialize`` (protocolVersion/capabilities/serverInfo),
``notifications/initialized`` (a notification, so no response), ``roots/list``
(Workspace_Root, per R2.6), ``tools/list``, and ``tools/call`` (dispatched by
tool name; an unknown tool yields a JSON-RPC method-not-found error).
"""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Protocol

__all__ = [
    "PROTOCOL_VERSION",
    "ByteWriter",
    "LineReader",
    "Server",
    "Tool",
    "ToolHandler",
    "decode_line",
    "encode_message",
    "error_result",
    "handle_request",
    "text_result",
]

PROTOCOL_VERSION: Final = "2024-11-05"
_DEFAULT_SERVER_INFO: Final[dict[str, str]] = {
    "name": "zocai-bundled-mcp-server",
    "version": "1.0.0",
}
_METHOD_NOT_FOUND: Final = -32601

# A tool handler maps a JSON arguments object to a tool-result envelope.
ToolHandler = Callable[[dict[str, object]], dict[str, object]]


@dataclass(frozen=True)
class Tool:
    """One registered MCP tool: identity, input schema, and its handler."""

    name: str
    description: str
    input_schema: Mapping[str, object]
    handler: ToolHandler


class LineReader(Protocol):
    """The byte-reading surface :meth:`Server.serve` needs (``readline``).

    Structurally satisfied by ``sys.stdin.buffer``.
    """

    def readline(self) -> bytes: ...


class ByteWriter(Protocol):
    """The byte-writing surface :meth:`Server.serve` needs.

    Structurally satisfied by ``sys.stdout.buffer``.
    """

    def write(self, data: bytes) -> int: ...

    def flush(self) -> None: ...


def text_result(text: str) -> dict[str, object]:
    """Build a normal tool result carrying one text content block."""
    return {"content": [{"type": "text", "text": text}], "isError": False}


def error_result(message: str) -> dict[str, object]:
    """Build a tool-level failure envelope (``isError`` true; the two-level model)."""
    return {"content": [{"type": "text", "text": message}], "isError": True}


def encode_message(message: Mapping[str, object]) -> bytes:
    """Serialize ``message`` as one compact JSON line terminated by ``"\\n"`` (R18.1)."""
    payload = json.dumps(dict(message), separators=(",", ":"))
    return (payload + "\n").encode("utf-8")


def decode_line(line: bytes | str) -> dict[str, object] | None:
    """Decode one framed line into a single JSON object, else ``None`` (R18.2, R18.4).

    A non-UTF-8 byte string, malformed JSON, or a non-object (array/scalar) all
    yield ``None`` so the caller can discard the line and keep the session open.
    """
    if isinstance(line, bytes):
        try:
            text = line.decode("utf-8")
        except UnicodeDecodeError:
            return None
    else:
        text = line
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(parsed, dict):
        return None
    return parsed


def _ok(msg_id: object, result: Mapping[str, object]) -> dict[str, object]:
    return {"jsonrpc": "2.0", "id": msg_id, "result": dict(result)}


def _error(msg_id: object, code: int, message: str) -> dict[str, object]:
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}


def _roots_payload(workspace_root: Path) -> dict[str, object]:
    root = Path(workspace_root).resolve()
    return {"roots": [{"uri": root.as_uri(), "name": root.name}]}


def handle_request(
    message: Mapping[str, object],
    tools: Mapping[str, Tool],
    workspace_root: Path,
    *,
    server_info: Mapping[str, str] | None = None,
) -> dict[str, object] | None:
    """Dispatch one JSON-RPC request to its response, or ``None`` for a notification.

    Answers ``initialize`` (protocolVersion/capabilities/serverInfo),
    ``notifications/initialized`` (no response), ``roots/list`` (Workspace_Root,
    R2.6), ``tools/list``, and ``tools/call``. A ``tools/call`` for an unknown
    tool name — or any other unknown request method — yields a JSON-RPC
    method-not-found error, while an unknown *notification* yields ``None``.
    """
    method = message.get("method")
    msg_id = message.get("id")
    is_notification = "id" not in message

    if method == "initialize":
        info = dict(server_info) if server_info is not None else dict(_DEFAULT_SERVER_INFO)
        return _ok(
            msg_id,
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": info,
            },
        )
    if method == "notifications/initialized":
        return None
    if method == "roots/list":
        return _ok(msg_id, _roots_payload(workspace_root))
    if method == "tools/list":
        listed = [
            {
                "name": tool.name,
                "description": tool.description,
                "inputSchema": dict(tool.input_schema),
            }
            for tool in tools.values()
        ]
        return _ok(msg_id, {"tools": listed})
    if method == "tools/call":
        raw_params = message.get("params")
        params: Mapping[str, object] = raw_params if isinstance(raw_params, Mapping) else {}
        name = params.get("name")
        raw_arguments = params.get("arguments")
        arguments: dict[str, object] = (
            dict(raw_arguments) if isinstance(raw_arguments, Mapping) else {}
        )
        tool = tools.get(name) if isinstance(name, str) else None
        if tool is None:
            return _error(msg_id, _METHOD_NOT_FOUND, f"unknown tool: {name!r}")
        return _ok(msg_id, tool.handler(arguments))

    if is_notification:
        return None
    return _error(msg_id, _METHOD_NOT_FOUND, f"method not found: {method!r}")


class Server:
    """A minimal stdio MCP server: a tool registry plus a blocking serve loop."""

    def __init__(self, *, name: str, version: str = "1.0.0") -> None:
        self.name = name
        self.version = version
        self._tools: dict[str, Tool] = {}

    @property
    def tools(self) -> Mapping[str, Tool]:
        """The registered tools, keyed by bare tool name."""
        return self._tools

    def register(
        self,
        name: str,
        description: str,
        input_schema: Mapping[str, object],
        handler: ToolHandler,
    ) -> None:
        """Register (or replace) a tool by its bare ``name``."""
        self._tools[name] = Tool(
            name=name,
            description=description,
            input_schema=dict(input_schema),
            handler=handler,
        )

    def serve(
        self,
        stdin_buffer: LineReader,
        stdout_buffer: ByteWriter,
        workspace_root: Path,
    ) -> None:
        """Block reading framed JSON-RPC lines until EOF, answering each request.

        A malformed line is discarded and the loop continues (R18.4); an empty
        read (EOF) ends the loop — the Server_Crash boundary (R18.5).
        """
        info = {"name": self.name, "version": self.version}
        while True:
            line = stdin_buffer.readline()
            if not line:
                return
            message = decode_line(line)
            if message is None:
                continue
            response = handle_request(message, self._tools, workspace_root, server_info=info)
            if response is not None:
                stdout_buffer.write(encode_message(response))
                stdout_buffer.flush()
