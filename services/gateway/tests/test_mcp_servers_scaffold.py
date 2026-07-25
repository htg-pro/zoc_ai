"""Unit + example tests for the reusable stdio MCP server scaffold.

Covers the pure ``handle_request`` dispatch (initialize, notifications, roots,
tools/list, tools/call including a tool-level ``isError`` envelope and unknown
tools) plus the framing round trip and the blocking serve loop over fake byte
buffers. Part 4, R18 (framing) and R2.6 (roots return Workspace_Root).
"""

from __future__ import annotations

from pathlib import Path

from mcp_servers._mcp import (
    Server,
    decode_line,
    encode_message,
    error_result,
    handle_request,
    text_result,
)

_ROOT = Path(__file__).resolve().parent


class _Reader:
    """Serves a fixed list of framed byte lines, then EOF (b"")."""

    def __init__(self, lines: list[bytes]) -> None:
        self._lines = list(lines)

    def readline(self) -> bytes:
        return self._lines.pop(0) if self._lines else b""


class _Writer:
    """Captures every byte chunk written by the serve loop."""

    def __init__(self) -> None:
        self.chunks: list[bytes] = []

    def write(self, data: bytes) -> int:
        self.chunks.append(data)
        return len(data)

    def flush(self) -> None:
        return None


def _ping_server() -> Server:
    server = Server(name="scaffold-test", version="9.9.9")
    server.register(
        "echo",
        "Echo the message argument back as text.",
        {"type": "object", "properties": {"message": {"type": "string"}}},
        lambda args: text_result(str(args.get("message", ""))),
    )
    server.register(
        "boom",
        "Always fail at the tool level.",
        {"type": "object", "properties": {}},
        lambda _args: error_result("intentional tool failure"),
    )
    return server


def test_framing_round_trip() -> None:
    message = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"x": [1, 2]}}
    encoded = encode_message(message)
    assert encoded.endswith(b"\n")
    assert encoded.count(b"\n") == 1
    assert decode_line(encoded) == message


def test_decode_line_rejects_non_objects_and_garbage() -> None:
    assert decode_line(b'{"a":1}\n') == {"a": 1}
    assert decode_line('{"a":1}') == {"a": 1}
    assert decode_line(b"[1,2]\n") is None
    assert decode_line(b"5\n") is None
    assert decode_line(b"garbage\n") is None
    assert decode_line(b"\xff\xfe\n") is None


def test_initialize_reports_protocol_capabilities_and_server_info() -> None:
    response = handle_request(
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}, {}, _ROOT
    )
    assert response is not None
    result = response["result"]
    assert isinstance(result, dict)
    assert result["protocolVersion"]
    assert "capabilities" in result
    assert set(result["serverInfo"]) == {"name", "version"}


def test_notifications_initialized_has_no_response() -> None:
    assert (
        handle_request({"jsonrpc": "2.0", "method": "notifications/initialized"}, {}, _ROOT)
        is None
    )


def test_roots_list_returns_workspace_root() -> None:
    response = handle_request({"jsonrpc": "2.0", "id": 7, "method": "roots/list"}, {}, _ROOT)
    assert response is not None
    roots = response["result"]["roots"]
    assert isinstance(roots, list)
    assert roots[0]["uri"] == _ROOT.resolve().as_uri()
    assert roots[0]["name"] == _ROOT.resolve().name


def test_tools_list_reports_registered_tools() -> None:
    server = _ping_server()
    response = handle_request(
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, server.tools, _ROOT
    )
    assert response is not None
    listed = response["result"]["tools"]
    names = {tool["name"] for tool in listed}
    assert names == {"echo", "boom"}
    for tool in listed:
        assert set(tool) == {"name", "description", "inputSchema"}


def test_tools_call_wraps_normal_handler_result() -> None:
    server = _ping_server()
    response = handle_request(
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "echo", "arguments": {"message": "hello"}},
        },
        server.tools,
        _ROOT,
    )
    assert response is not None
    result = response["result"]
    assert result["isError"] is False
    assert result["content"][0]["text"] == "hello"


def test_tools_call_carries_tool_level_is_error_envelope() -> None:
    server = _ping_server()
    response = handle_request(
        {
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {"name": "boom", "arguments": {}},
        },
        server.tools,
        _ROOT,
    )
    assert response is not None
    result = response["result"]
    assert result["isError"] is True
    assert "intentional tool failure" in result["content"][0]["text"]
    # A tool-level failure is NOT a JSON-RPC error.
    assert "error" not in response


def test_tools_call_unknown_tool_is_json_rpc_error() -> None:
    server = _ping_server()
    response = handle_request(
        {
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": {"name": "does-not-exist", "arguments": {}},
        },
        server.tools,
        _ROOT,
    )
    assert response is not None
    assert "result" not in response
    assert response["error"]["code"] == -32601


def test_unknown_notification_yields_no_response() -> None:
    assert handle_request({"jsonrpc": "2.0", "method": "unknown/thing"}, {}, _ROOT) is None


def test_serve_loop_answers_requests_and_skips_malformed_lines() -> None:
    server = _ping_server()
    reader = _Reader(
        [
            encode_message({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}),
            b"this is not json\n",  # malformed → discarded, session stays open
            encode_message({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            encode_message(
                {
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "tools/call",
                    "params": {"name": "echo", "arguments": {"message": "hi"}},
                }
            ),
        ]
    )
    writer = _Writer()
    server.serve(reader, writer, _ROOT)

    responses = [decode_line(chunk) for chunk in writer.chunks]
    # initialize answered, notification produced no output, tools/call answered.
    assert len(responses) == 2
    assert responses[0] is not None
    assert responses[0]["id"] == 1
    assert responses[1] is not None
    assert responses[1]["result"]["content"][0]["text"] == "hi"
