"""Tests for the MCP ServerSession over a fake process (Part 4, R2, R4, R9)."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st
from zocai_gateway.context.mcp_host import framing
from zocai_gateway.context.mcp_host.session import ServerSession, SessionError

_env_key = st.text(st.characters(min_codepoint=65, max_codepoint=90), min_size=1, max_size=5)
_env_val = st.text(st.characters(min_codepoint=97, max_codepoint=122), max_size=6)


class _RecordingWriter:
    def __init__(self) -> None:
        self.messages: list[dict[str, object]] = []

    def write(self, data: bytes) -> None:
        message = framing.decode_line(data)
        if message is not None:
            self.messages.append(message)

    async def drain(self) -> None:
        return None


class _LineReader:
    def __init__(self, lines: list[bytes]) -> None:
        self._lines = list(lines)

    async def readline(self) -> bytes:
        return self._lines.pop(0) if self._lines else b""


class _ScriptedProcess:
    def __init__(self, outbound: list[bytes]) -> None:
        self.stdin = _RecordingWriter()
        self.stdout = _LineReader(outbound)
        self.terminated = False

    def terminate(self) -> None:
        self.terminated = True

    async def wait(self) -> int:
        return 0


def _enc(message: dict[str, object]) -> bytes:
    return framing.encode_message(message)


def _init_response(request_id: int = 1) -> dict[str, object]:
    return {"jsonrpc": "2.0", "id": request_id, "result": {"capabilities": {}, "serverInfo": {}}}


# Feature: mcp-host-and-servers, Property 5: Argv integrity on spawn
@settings(max_examples=200)
@given(
    command=st.text(min_size=1, max_size=8),
    args=st.lists(st.text(min_size=1, max_size=8), max_size=4),
)
def test_argv_integrity(command: str, args: list[str]) -> None:
    """Validates: Requirements 2.1, 9.1."""
    recorded: list[list[str]] = []
    process = _ScriptedProcess([])

    async def spawn(argv, cwd, env):  # type: ignore[no-untyped-def]
        recorded.append(list(argv))
        return process

    session = ServerSession("s", [command, *args], workspace_root=".", spawn=spawn)
    asyncio.run(session.start())
    assert recorded == [[command, *args]]
    assert all(isinstance(a, str) for a in recorded[0])  # a list, never a shell string


# Feature: mcp-host-and-servers, Property 6: Environment overlay preservation
@settings(max_examples=200)
@given(
    inherited=st.dictionaries(_env_key, _env_val, max_size=5),
    config=st.dictionaries(_env_key, _env_val, max_size=5),
)
def test_env_overlay(inherited: dict[str, str], config: dict[str, str]) -> None:
    """Validates: Requirements 2.2."""
    recorded: list[dict[str, str]] = []
    process = _ScriptedProcess([])

    async def spawn(argv, cwd, env):  # type: ignore[no-untyped-def]
        recorded.append(dict(env))
        return process

    session = ServerSession("s", ["cmd"], env=config, spawn=spawn, environ=inherited)
    asyncio.run(session.start())
    expected = dict(inherited)
    expected.update(config)
    assert recorded[0] == expected


# Feature: mcp-host-and-servers, Property 7: Initialize-handshake ordering
@settings(max_examples=200)
@given(
    n_notifications=st.integers(min_value=0, max_value=3),
    n_roots=st.integers(min_value=0, max_value=3),
)
def test_initialize_ordering(n_notifications: int, n_roots: int) -> None:
    """Validates: Requirements 2.5."""
    outbound: list[bytes] = []
    for _ in range(n_notifications):
        outbound.append(_enc({"jsonrpc": "2.0", "method": "notifications/progress", "params": {}}))
    for i in range(n_roots):
        outbound.append(_enc({"jsonrpc": "2.0", "id": 1000 + i, "method": "roots/list"}))
    outbound.append(_enc(_init_response()))
    process = _ScriptedProcess(outbound)

    async def spawn(argv, cwd, env):  # type: ignore[no-untyped-def]
        return process

    session = ServerSession("s", ["cmd"], spawn=spawn)

    async def run() -> None:
        await session.start()
        await session.initialize(5.0)

    asyncio.run(run())
    methods = [m.get("method") for m in process.stdin.messages]
    assert methods[0] == "initialize"
    assert "notifications/initialized" in methods
    assert methods.index("initialize") < methods.index("notifications/initialized")
    assert "tools/list" not in methods  # not sent during initialize()
    roots_answers = [
        m
        for m in process.stdin.messages
        if isinstance(m.get("result"), dict) and "roots" in m["result"]  # type: ignore[operator]
    ]
    assert len(roots_answers) == n_roots


def test_roots_result_is_workspace_root() -> None:
    root = Path(".").resolve()
    session = ServerSession("s", ["cmd"], workspace_root=root)
    assert session.roots_result() == [{"uri": root.as_uri(), "name": root.name}]


def test_list_tools_parses_and_call_tool_sends_request() -> None:
    outbound = [
        _enc(_init_response(1)),
        _enc(
            {
                "jsonrpc": "2.0",
                "id": 2,
                "result": {
                    "tools": [
                        {"name": "alpha", "inputSchema": {"type": "object"}, "description": "A"},
                        {"name": "beta"},
                        {"not_a_tool": True},  # skipped: no name
                    ]
                },
            }
        ),
        _enc({"jsonrpc": "2.0", "id": 3, "result": {"content": [{"type": "text", "text": "ok"}]}}),
    ]
    process = _ScriptedProcess(outbound)

    async def spawn(argv, cwd, env):  # type: ignore[no-untyped-def]
        return process

    session = ServerSession("s", ["cmd"], spawn=spawn)

    async def run() -> tuple[list[str], dict[str, object]]:
        await session.start()
        await session.initialize(5.0)
        tools = await session.list_tools(5.0)
        response = await session.call_tool("alpha", {"q": "x"}, 5.0)
        return [t.name for t in tools], response

    names, response = asyncio.run(run())
    assert names == ["alpha", "beta"]
    assert isinstance(response.get("result"), dict)
    call = next(m for m in process.stdin.messages if m.get("method") == "tools/call")
    assert call["params"] == {"name": "alpha", "arguments": {"q": "x"}}


def test_aclose_is_idempotent() -> None:
    process = _ScriptedProcess([])

    async def spawn(argv, cwd, env):  # type: ignore[no-untyped-def]
        return process

    session = ServerSession("s", ["cmd"], spawn=spawn)

    async def run() -> None:
        await session.start()
        await session.aclose()
        await session.aclose()  # idempotent: reaping a finished process is a no-op

    asyncio.run(run())
    assert process.terminated is True


def test_call_tool_deadline_uses_timeout_category() -> None:
    class InitializeThenHang:
        def __init__(self) -> None:
            self.first = True
            self.never = asyncio.Event()

        async def readline(self) -> bytes:
            if self.first:
                self.first = False
                return _enc(_init_response())
            await self.never.wait()
            return b""

    process = _ScriptedProcess([])
    process.stdout = InitializeThenHang()

    async def spawn(argv, cwd, env):  # type: ignore[no-untyped-def]
        return process

    async def run() -> None:
        session = ServerSession("s", ["cmd"], spawn=spawn)
        await session.start()
        await session.initialize(1.0)
        with pytest.raises(SessionError) as raised:
            await session.call_tool("slow", {}, 0.001)
        assert raised.value.category == "timeout"
        await session.aclose()

    asyncio.run(run())


def test_concurrent_tool_calls_are_serialized_per_session() -> None:
    class QueueReader:
        def __init__(self) -> None:
            self.queue: asyncio.Queue[bytes] = asyncio.Queue()

        async def readline(self) -> bytes:
            return await self.queue.get()

    class RespondingWriter:
        def __init__(self, reader: QueueReader) -> None:
            self.reader = reader
            self.sent: list[str] = []
            self.tasks: set[asyncio.Task[None]] = set()

        def write(self, data: bytes) -> None:
            message = framing.decode_line(data)
            assert message is not None
            params = message.get("params")
            name = params.get("name") if isinstance(params, dict) else None
            self.sent.append(str(name))

            async def respond() -> None:
                if name == "first":
                    await asyncio.sleep(0.01)
                await self.reader.queue.put(
                    _enc(
                        {
                            "jsonrpc": "2.0",
                            "id": message["id"],
                            "result": {"name": name},
                        }
                    )
                )

            task = asyncio.create_task(respond())
            self.tasks.add(task)
            task.add_done_callback(self.tasks.discard)

        async def drain(self) -> None:
            return None

    class RespondingProcess:
        def __init__(self) -> None:
            self.stdout = QueueReader()
            self.stdin = RespondingWriter(self.stdout)

        def terminate(self) -> None:
            return None

        async def wait(self) -> int:
            return 0

    process = RespondingProcess()

    async def spawn(argv, cwd, env):  # type: ignore[no-untyped-def]
        return process

    async def run() -> None:
        session = ServerSession("s", ["cmd"], spawn=spawn)
        await session.start()
        first, second = await asyncio.gather(
            session.call_tool("first", {}, 1.0),
            session.call_tool("second", {}, 1.0),
        )
        assert first["result"] == {"name": "first"}
        assert second["result"] == {"name": "second"}
        assert process.stdin.sent == ["first", "second"]
        await session.aclose()

    asyncio.run(run())
