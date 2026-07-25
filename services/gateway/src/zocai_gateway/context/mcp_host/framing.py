"""Newline-delimited JSON-RPC framing for MCP stdio transport (Part 4, R18).

Unlike the LSP ``Content-Length`` framing in :mod:`zocai_gateway.routes.lsp`,
MCP stdio uses exactly one compact JSON serialization followed by one ``"\\n"``
per message. ``json.dumps`` escapes any embedded newline inside a string as
``"\\n"``, so a framed line contains exactly one message and one terminator
(R18.1).

The reader is defined over the same narrow :class:`AsyncByteReader` seam shape
used by the LSP proxy, so sessions are unit-tested with an in-memory fake — no
real subprocess required.
"""

from __future__ import annotations

import json
from typing import Final, Protocol

__all__ = [
    "EOF",
    "AsyncByteReader",
    "Eof",
    "JsonRpcMessage",
    "decode_line",
    "encode_message",
    "read_message",
]

JsonRpcMessage = dict[str, object]


class Eof:
    """Sentinel type for end-of-stream (a server that closed its stdout)."""

    _instance: Eof | None = None

    def __new__(cls) -> Eof:
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __repr__(self) -> str:  # pragma: no cover - trivial
        return "EOF"


EOF: Final[Eof] = Eof()


class AsyncByteReader(Protocol):
    """The byte-reading surface the framing reader needs (``readline``).

    Structurally satisfied by :class:`asyncio.StreamReader`.
    """

    async def readline(self) -> bytes: ...


def encode_message(message: JsonRpcMessage) -> bytes:
    """Serialize ``message`` as one compact JSON line terminated by ``"\\n"``.

    Uses ``separators=(",", ":")`` for a single compact serialization. Any
    newline embedded in a string value is escaped by ``json.dumps`` (as
    ``"\\n"``), so the encoded ``bytes`` contain exactly one literal newline —
    the terminator (R18.1).
    """
    payload = json.dumps(message, separators=(",", ":"), ensure_ascii=False)
    return (payload + "\n").encode("utf-8")


def decode_line(line: bytes | str) -> JsonRpcMessage | None:
    """Decode one framed line into a single JSON object, else ``None``.

    Strips a single trailing newline and ``json.loads`` the remainder; returns
    the message only when it decodes to exactly one JSON *object*. A malformed
    line, a non-UTF-8 byte string, or a non-object (array/scalar) yields
    ``None`` (R18.2, R18.4).
    """
    try:
        text = line.decode("utf-8") if isinstance(line, bytes) else line
    except UnicodeDecodeError:
        return None
    if text.endswith("\n"):
        text = text[:-1]
    if text.endswith("\r"):
        text = text[:-1]
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(parsed, dict):
        return None
    return parsed


async def read_message(reader: AsyncByteReader) -> JsonRpcMessage | Eof:
    """Read one JSON-RPC message, skipping malformed lines, until EOF.

    Returns :data:`EOF` when the stream ends (``readline`` yields ``b""``),
    which drives the Server_Crash path (R18.5). A line rejected by
    :func:`decode_line` is discarded and reading continues, keeping the session
    open (R18.4).
    """
    while True:
        line = await reader.readline()
        if line == b"":
            return EOF
        message = decode_line(line)
        if message is not None:
            return message
