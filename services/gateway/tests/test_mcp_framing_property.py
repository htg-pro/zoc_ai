"""Tests for MCP stdio newline JSON-RPC framing (Part 4, R18)."""

from __future__ import annotations

import asyncio

from hypothesis import given, settings
from hypothesis import strategies as st
from zocai_gateway.context.mcp_host import framing

# UTF-8-encodable text (no surrogates, no astral) so encode_message never fails.
_text = st.text(st.characters(min_codepoint=1, max_codepoint=0xD7FF), max_size=20)


def _json_values() -> st.SearchStrategy[object]:
    scalars = (
        st.none()
        | st.booleans()
        | st.integers(min_value=-(10**9), max_value=10**9)
        | st.floats(allow_nan=False, allow_infinity=False)
        | _text
    )
    return st.recursive(
        scalars,
        lambda children: st.lists(children, max_size=4)
        | st.dictionaries(_text, children, max_size=4),
        max_leaves=15,
    )


_json_object = st.dictionaries(_text, _json_values(), max_size=6)

_MALFORMED = [
    b"not json at all\n",
    b"[1, 2, 3]\n",  # array, not an object
    b"42\n",  # scalar, not an object
    b'"a bare string"\n',  # scalar, not an object
    b"true\n",
    b"{unbalanced\n",
    b"\n",  # empty line
]


class _ListReader:
    """Serves a fixed list of lines, then EOF (b"")."""

    def __init__(self, lines: list[bytes]) -> None:
        self._lines = list(lines)

    async def readline(self) -> bytes:
        return self._lines.pop(0) if self._lines else b""


# Feature: mcp-host-and-servers, Property 34: stdio framing round-trip equality
@settings(max_examples=200)
@given(message=_json_object)
def test_framing_round_trip(message: dict[str, object]) -> None:
    """Validates: Requirements 18.1, 18.2, 18.3."""
    encoded = framing.encode_message(message)
    # Exactly one JSON serialization + one newline terminator; no embedded raw newline.
    assert encoded.endswith(b"\n")
    assert encoded.count(b"\n") == 1
    # A complete framed line decodes to exactly one equal message.
    assert framing.decode_line(encoded) == message


# Feature: mcp-host-and-servers, Property 35: Malformed-line discard keeps the session open
@settings(max_examples=200)
@given(
    tokens=st.lists(
        st.one_of(
            _json_object.map(lambda m: ("ok", m)),
            st.sampled_from(_MALFORMED).map(lambda b: ("bad", b)),
        ),
        max_size=12,
    )
)
def test_malformed_lines_discarded(tokens: list[tuple[str, object]]) -> None:
    """Validates: Requirements 18.4."""
    lines: list[bytes] = []
    expected: list[dict[str, object]] = []
    for kind, value in tokens:
        if kind == "ok":
            message = dict(value)  # type: ignore[arg-type]
            lines.append(framing.encode_message(message))
            expected.append(message)
        else:
            lines.append(value)  # type: ignore[arg-type]

    reader = _ListReader(lines)

    async def drain() -> list[object]:
        out: list[object] = []
        while True:
            result = await framing.read_message(reader)
            if result is framing.EOF:
                return out
            out.append(result)

    assert asyncio.run(drain()) == expected


def test_decode_line_rejects_non_objects_and_garbage() -> None:
    assert framing.decode_line(b'{"a":1}\n') == {"a": 1}
    assert framing.decode_line('{"a":1}') == {"a": 1}  # no trailing newline
    assert framing.decode_line(b"[1,2]\n") is None
    assert framing.decode_line(b"5\n") is None
    assert framing.decode_line(b"garbage\n") is None
    assert framing.decode_line(b"\n") is None
    # A non-UTF-8 byte string is rejected, not raised.
    assert framing.decode_line(b"\xff\xfe\n") is None


def test_read_message_returns_eof_on_empty_stream() -> None:
    reader = _ListReader([])
    assert asyncio.run(framing.read_message(reader)) is framing.EOF
