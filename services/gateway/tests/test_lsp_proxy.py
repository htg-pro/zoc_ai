"""Unit tests for the WebSocket ↔ stdio LSP proxy (§3.1).

The proxy is exercised with an in-memory fake WebSocket and a fake subprocess,
so no real language-server binary is needed. Async coroutines are driven from
sync tests via ``asyncio.run`` (the gateway suite avoids ``pytest.mark.asyncio``).
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from hypothesis import given, settings
from hypothesis import strategies as st
from zocai_gateway.auth import is_request_admitted
from zocai_gateway.routes.lsp import (
    ABNORMAL_SERVER_TERMINATION_CLOSE_CODE,
    LSP_SERVERS,
    SERVER_NOT_INSTALLED_CLOSE_CODE,
    UNKNOWN_SERVER_CLOSE_CODE,
    _pump_process_to_ws,
    _pump_ws_to_process,
    frame_message,
    inject_root_uri,
    proxy_lsp,
    read_framed_message,
    resolve_server_command,
)
from zocai_gateway.settings import LOOPBACK_HOSTS, GatewaySettings


class _Disconnect(Exception):
    """Raised by the fake socket's ``receive_text`` once its script is drained."""


class _FakeWebSocket:
    """In-memory WebSocket: scripts inbound text, records outbound + lifecycle."""

    def __init__(self, incoming: list[str] | None = None) -> None:
        self._incoming = list(incoming or [])
        self.sent: list[str] = []
        self.accepted = False
        self.closed_code: int | None = None

    async def accept(self) -> None:
        self.accepted = True

    async def receive_text(self) -> str:
        if self._incoming:
            return self._incoming.pop(0)
        raise _Disconnect

    async def send_text(self, data: str) -> None:
        self.sent.append(data)

    async def close(self, code: int = 1000) -> None:
        self.closed_code = code


class _FakeWriter:
    """Collects everything written to a process's stdin."""

    def __init__(self) -> None:
        self.buffer = bytearray()

    def write(self, data: bytes) -> None:
        self.buffer.extend(data)

    async def drain(self) -> None:
        return None


class _FakeReader:
    """Serves a fixed byte buffer via readline/readexactly, then EOF."""

    def __init__(self, data: bytes) -> None:
        self._data = data
        self._pos = 0

    async def readline(self) -> bytes:
        newline = self._data.find(b"\n", self._pos)
        if newline == -1:
            chunk = self._data[self._pos :]
            self._pos = len(self._data)
            return bytes(chunk)
        chunk = self._data[self._pos : newline + 1]
        self._pos = newline + 1
        return bytes(chunk)

    async def readexactly(self, n: int) -> bytes:
        chunk = self._data[self._pos : self._pos + n]
        self._pos += len(chunk)
        if len(chunk) < n:
            raise asyncio.IncompleteReadError(bytes(chunk), n)
        return bytes(chunk)


class _FakeProcess:
    """A fake asyncio subprocess with byte-collecting stdin and scripted stdout."""

    def __init__(self, stdout_bytes: bytes = b"") -> None:
        self.stdin = _FakeWriter()
        self.stdout = _FakeReader(stdout_bytes)
        self.terminated = False

    def terminate(self) -> None:
        self.terminated = True

    async def wait(self) -> int:
        return 0


def _make_spawn(process: _FakeProcess) -> tuple[object, list[tuple[tuple[str, ...], Path]]]:
    calls: list[tuple[tuple[str, ...], Path]] = []

    async def spawn(argv, cwd):
        calls.append((tuple(argv), cwd))
        return process

    return spawn, calls


# -- allowlist --------------------------------------------------------------


def test_resolve_server_command_known() -> None:
    assert resolve_server_command("pyright") == ("pyright-langserver", "--stdio")
    assert resolve_server_command("typescript-language-server") == (
        "typescript-language-server",
        "--stdio",
    )
    assert resolve_server_command("rust-analyzer") == ("rust-analyzer",)


def test_resolve_server_command_unknown() -> None:
    assert resolve_server_command("evil-server") is None
    assert resolve_server_command("") is None


def test_allowlist_covers_the_three_prompt_servers() -> None:
    assert set(LSP_SERVERS) == {
        "typescript-language-server",
        "pyright",
        "rust-analyzer",
    }


# -- framing ----------------------------------------------------------------


def test_frame_message_has_content_length_header() -> None:
    framed = frame_message('{"a":1}')
    assert framed == b"Content-Length: 7\r\n\r\n" + b'{"a":1}'


def test_frame_and_read_round_trip() -> None:
    payload = '{"jsonrpc":"2.0","id":1,"result":null}'
    reader = _FakeReader(frame_message(payload))
    assert asyncio.run(read_framed_message(reader)) == payload


def test_read_framed_message_eof_returns_none() -> None:
    assert asyncio.run(read_framed_message(_FakeReader(b""))) is None


def test_read_framed_message_tolerates_extra_headers() -> None:
    payload = '{"ok":true}'
    body = payload.encode("utf-8")
    raw = (
        b"Content-Length: "
        + str(len(body)).encode("ascii")
        + b"\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n"
        + body
    )
    assert asyncio.run(read_framed_message(_FakeReader(raw))) == payload


def test_read_framed_message_without_content_length_returns_none() -> None:
    assert asyncio.run(read_framed_message(_FakeReader(b"X-Foo: bar\r\n\r\n"))) is None


# -- rootUri injection ------------------------------------------------------


def test_inject_root_uri_patches_initialize(tmp_path: Path) -> None:
    request = json.dumps(
        {"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {"processId": 1}}
    )
    patched = json.loads(inject_root_uri(request, tmp_path))

    assert patched["params"]["rootUri"] == tmp_path.as_uri()
    assert patched["params"]["rootPath"] == str(tmp_path)
    assert patched["params"]["workspaceFolders"] == [
        {"uri": tmp_path.as_uri(), "name": tmp_path.name}
    ]
    assert patched["params"]["processId"] == 1  # existing params preserved


def test_inject_root_uri_creates_params_when_missing(tmp_path: Path) -> None:
    patched = json.loads(inject_root_uri('{"method":"initialize"}', tmp_path))
    assert patched["params"]["rootUri"] == tmp_path.as_uri()


def test_inject_root_uri_ignores_non_initialize(tmp_path: Path) -> None:
    other = '{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{}}'
    assert inject_root_uri(other, tmp_path) == other


def test_inject_root_uri_passes_through_invalid_json(tmp_path: Path) -> None:
    assert inject_root_uri("not json", tmp_path) == "not json"


# -- pumps ------------------------------------------------------------------


def test_ws_to_process_frames_and_injects_root_uri(tmp_path: Path) -> None:
    ws = _FakeWebSocket(incoming=['{"method":"initialize","params":{}}'])
    stdin = _FakeWriter()

    asyncio.run(_pump_ws_to_process(ws, stdin, tmp_path))

    # The framed message on stdin round-trips back with the injected rootUri.
    forwarded = asyncio.run(read_framed_message(_FakeReader(bytes(stdin.buffer))))
    assert forwarded is not None
    assert json.loads(forwarded)["params"]["rootUri"] == tmp_path.as_uri()


def test_process_to_ws_forwards_each_framed_message() -> None:
    stdout = _FakeReader(frame_message('{"id":1}') + frame_message('{"id":2}'))
    ws = _FakeWebSocket()

    asyncio.run(_pump_process_to_ws(stdout, ws))

    assert ws.sent == ['{"id":1}', '{"id":2}']


# -- proxy orchestration ----------------------------------------------------


def test_proxy_rejects_unknown_server_without_spawning(tmp_path: Path) -> None:
    ws = _FakeWebSocket()
    process = _FakeProcess()
    spawn, calls = _make_spawn(process)

    asyncio.run(proxy_lsp(ws, "evil-server", workspace_root=tmp_path, spawn=spawn))

    assert ws.closed_code == UNKNOWN_SERVER_CLOSE_CODE
    assert ws.accepted is False
    assert calls == []  # no process was ever spawned


def test_proxy_spawns_allowlisted_server_pinned_to_workspace(tmp_path: Path) -> None:
    ws = _FakeWebSocket(incoming=['{"method":"initialize","params":{}}'])
    process = _FakeProcess(stdout_bytes=frame_message('{"id":0,"result":{}}'))
    spawn, calls = _make_spawn(process)

    asyncio.run(proxy_lsp(ws, "pyright", workspace_root=tmp_path, spawn=spawn))

    assert ws.accepted is True
    assert len(calls) == 1
    argv, cwd = calls[0]
    assert argv == ("pyright-langserver", "--stdio")
    assert cwd == tmp_path.resolve()


def test_proxy_terminates_process_on_close(tmp_path: Path) -> None:
    ws = _FakeWebSocket(incoming=['{"method":"initialize","params":{}}'])
    process = _FakeProcess(stdout_bytes=frame_message('{"id":0,"result":{}}'))
    spawn, _calls = _make_spawn(process)

    asyncio.run(proxy_lsp(ws, "rust-analyzer", workspace_root=tmp_path, spawn=spawn))

    assert process.terminated is True


# ===========================================================================
# monaco-lsp-integration hardening (tasks 9.2/9.3, 10.2-10.7)
#
# Extended in-memory fakes (task 10.1) + generator-driven property tests driven
# with ``asyncio.run`` (min 100 examples each). No real server binary is used.
# ===========================================================================

_ALLOWLISTED = sorted(LSP_SERVERS)


class _HoldOpenWebSocket:
    """A client that stays connected: ``receive_text`` blocks on an event so the
    client pump remains pending while the server dies. ``close`` releases it.
    """

    def __init__(self) -> None:
        self.sent: list[str] = []
        self.accepted = False
        self.closed_code: int | None = None
        self._release = asyncio.Event()

    async def accept(self) -> None:
        self.accepted = True

    async def receive_text(self) -> str:
        await self._release.wait()  # held until release/cancel
        raise _Disconnect

    async def send_text(self, data: str) -> None:
        self.sent.append(data)

    async def close(self, code: int = 1000) -> None:
        self.closed_code = code
        self._release.set()


class _BlockingReader:
    """A stdout that blocks until an exit event, then reports EOF."""

    def __init__(self, released: asyncio.Event) -> None:
        self._released = released

    async def readline(self) -> bytes:
        await self._released.wait()
        return b""  # EOF once the process has exited

    async def readexactly(self, n: int) -> bytes:
        await self._released.wait()
        raise asyncio.IncompleteReadError(b"", n)


class _DyingProcess:
    """A process whose stdout blocks until it exits; ``wait()`` completes on
    ``terminate()`` or an explicit ``simulate_exit(code)``.
    """

    def __init__(self) -> None:
        self._exited = asyncio.Event()
        self.stdin = _FakeWriter()
        self.stdout = _BlockingReader(self._exited)
        self.terminated = False
        self._code = 0

    def terminate(self) -> None:
        self.terminated = True
        self._exited.set()

    def simulate_exit(self, code: int = 1) -> None:
        self._code = code
        self._exited.set()

    async def wait(self) -> int:
        await self._exited.wait()
        return self._code


# -- Property 11: Spawn-failure classification ------------------------------


@settings(max_examples=100, deadline=None)
@given(server=st.sampled_from(_ALLOWLISTED), missing=st.booleans())
def test_property_11_spawn_failure_classification(server: str, missing: bool) -> None:
    """Feature: monaco-lsp-integration, Property 11: Spawn-failure classification

    Validates: Requirements 6.2, 6.7
    """
    exc: OSError = FileNotFoundError() if missing else PermissionError()
    expected = (
        SERVER_NOT_INSTALLED_CLOSE_CODE if missing else ABNORMAL_SERVER_TERMINATION_CLOSE_CODE
    )

    async def spawn(argv, cwd):
        raise exc

    async def run() -> _FakeWebSocket:
        ws = _FakeWebSocket()
        # Must not propagate an unhandled spawn error.
        await proxy_lsp(ws, server, workspace_root=Path("."), spawn=spawn)
        return ws

    ws = asyncio.run(run())
    assert ws.accepted is True  # accepted before the spawn attempt
    assert ws.closed_code == expected


# -- Property 12: Abnormal termination while connected ----------------------


@settings(max_examples=100, deadline=None)
@given(server=st.sampled_from(_ALLOWLISTED), mode=st.sampled_from(["eof", "exit"]))
def test_property_12_abnormal_termination_while_connected(server: str, mode: str) -> None:
    """Feature: monaco-lsp-integration, Property 12: Abnormal termination while connected

    Validates: Requirements 6.3
    """

    async def run():
        ws = _HoldOpenWebSocket()
        if mode == "eof":
            proc = _FakeProcess(stdout_bytes=b"")  # server closes stdout immediately
            spawn, _calls = _make_spawn(proc)
            await proxy_lsp(ws, server, workspace_root=Path("."), spawn=spawn)
        else:
            proc = _DyingProcess()
            spawn, _calls = _make_spawn(proc)
            task = asyncio.create_task(
                proxy_lsp(ws, server, workspace_root=Path("."), spawn=spawn)
            )
            proc.simulate_exit(1)  # subprocess exits while the client is held open
            await asyncio.wait_for(task, timeout=2.0)
        return ws, proc

    ws, proc = asyncio.run(run())
    assert ws.closed_code == ABNORMAL_SERVER_TERMINATION_CLOSE_CODE
    assert proc.terminated is True


# -- Property 13: The subprocess is always terminated -----------------------


@settings(max_examples=100, deadline=None)
@given(
    server=st.sampled_from(_ALLOWLISTED),
    path=st.sampled_from(["client_disconnect", "abnormal"]),
)
def test_property_13_subprocess_always_terminated(server: str, path: str) -> None:
    """Feature: monaco-lsp-integration, Property 13: The subprocess is always terminated

    Validates: Requirements 6.4
    """

    async def run():
        if path == "client_disconnect":
            ws: object = _FakeWebSocket(incoming=['{"method":"initialize","params":{}}'])
            proc = _FakeProcess(stdout_bytes=frame_message('{"id":0,"result":{}}'))
        else:
            ws = _HoldOpenWebSocket()
            proc = _FakeProcess(stdout_bytes=b"")
        spawn, _calls = _make_spawn(proc)
        await proxy_lsp(ws, server, workspace_root=Path("."), spawn=spawn)
        return proc

    proc = asyncio.run(run())
    assert proc.terminated is True


# -- Property 14: Admission and allowlist precede spawn ---------------------


@st.composite
def _admission_inputs(draw: st.DrawFn) -> tuple[GatewaySettings, str | None]:
    host = draw(
        st.one_of(
            st.sampled_from(sorted(LOOPBACK_HOSTS)),
            st.sampled_from(["0.0.0.0", "10.0.0.5", "::", "example.com"]),
        )
    )
    token = draw(st.one_of(st.none(), st.just(""), st.text(min_size=1, max_size=16)))
    settings_obj = GatewaySettings(host=host, port=0, auth_token=token)
    wrong = draw(st.text(max_size=16).filter(lambda s: s != (token or "")))
    presented = draw(st.one_of(st.none(), st.just(wrong), st.just(token if token else wrong)))
    return settings_obj, presented


@settings(max_examples=100, deadline=None)
@given(name=st.text(max_size=40).filter(lambda s: s not in LSP_SERVERS))
def test_property_14_allowlist_precedes_spawn(name: str) -> None:
    """Feature: monaco-lsp-integration, Property 14: Admission and allowlist precede spawn

    A non-allowlisted Server_Name closes with UNKNOWN_SERVER_CLOSE_CODE before
    any subprocess is spawned. Validates: Requirements 7.2, 7.3
    """

    async def run():
        ws = _FakeWebSocket()
        proc = _FakeProcess()
        spawn, calls = _make_spawn(proc)
        await proxy_lsp(ws, name, workspace_root=Path("."), spawn=spawn)
        return ws, calls

    ws, calls = asyncio.run(run())
    assert ws.closed_code == UNKNOWN_SERVER_CLOSE_CODE
    assert ws.accepted is False
    assert calls == []  # no process was ever spawned


@settings(max_examples=100, deadline=None)
@given(case=_admission_inputs(), server=st.sampled_from(_ALLOWLISTED))
def test_property_14_admission_precedes_spawn(
    case: tuple[GatewaySettings, str | None], server: str
) -> None:
    """Feature: monaco-lsp-integration, Property 14: Admission and allowlist precede spawn

    Mirrors the ``app.py`` ``lsp_proxy`` admission gate (which calls the real
    ``is_request_admitted`` before ``proxy_lsp``): a denied request closes 1008
    and spawns nothing; an admitted request reaches the spawn. The pure
    admission policy itself is exhaustively covered by
    ``test_property_request_admission.py``. Validates: Requirements 7.1
    """
    settings_obj, presented = case

    async def run():
        ws = _FakeWebSocket(incoming=[])  # disconnects immediately if reached
        proc = _FakeProcess(stdout_bytes=b"")
        spawn, calls = _make_spawn(proc)
        if not is_request_admitted(settings_obj, presented):
            await ws.close(code=1008)
        else:
            await proxy_lsp(ws, server, workspace_root=Path("."), spawn=spawn)
        return ws, calls

    ws, calls = asyncio.run(run())
    if is_request_admitted(settings_obj, presented):
        assert calls != []  # admitted → server spawned
    else:
        assert ws.closed_code == 1008  # denied → closed…
        assert calls == []  # …and nothing spawned


# -- Property 15: Workspace pinning and rootUri injection -------------------

_root_parts = st.lists(
    st.text(
        alphabet="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-",
        min_size=1,
        max_size=8,
    ),
    max_size=4,
)


def _abs_root(parts: list[str]) -> Path:
    return Path("/", *parts)


@settings(max_examples=100, deadline=None)
@given(parts=_root_parts, server=st.sampled_from(_ALLOWLISTED))
def test_property_15_cwd_pinned_to_workspace_root(parts: list[str], server: str) -> None:
    """Feature: monaco-lsp-integration, Property 15: Workspace pinning and rootUri injection

    A spawned server's cwd equals the resolved Workspace_Root. Validates: 7.4
    """
    root = _abs_root(parts)

    async def run():
        ws = _FakeWebSocket(incoming=[])
        proc = _FakeProcess(stdout_bytes=b"")
        spawn, calls = _make_spawn(proc)
        await proxy_lsp(ws, server, workspace_root=root, spawn=spawn)
        return calls

    calls = asyncio.run(run())
    assert len(calls) == 1
    _argv, cwd = calls[0]
    assert cwd == root.resolve()


@settings(max_examples=100, deadline=None)
@given(parts=_root_parts)
def test_property_15_rooturi_injection(parts: list[str]) -> None:
    """Feature: monaco-lsp-integration, Property 15: Workspace pinning and rootUri injection

    A forwarded ``initialize`` has rootUri/rootPath/workspaceFolders set to the
    Workspace_Root. Validates: 7.5
    """
    root = _abs_root(parts)
    request = json.dumps(
        {"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {"processId": 1}}
    )
    patched = json.loads(inject_root_uri(request, root))
    assert patched["params"]["rootUri"] == root.as_uri()
    assert patched["params"]["rootPath"] == str(root)
    assert patched["params"]["workspaceFolders"] == [
        {"uri": root.as_uri(), "name": root.name}
    ]
    assert patched["params"]["processId"] == 1  # existing params preserved
