"""FastAPI application factory for the Zoc AI gateway sidecar.

This module exposes the Layer 2 control and telemetry surface (Requirement 6):

- ``POST /v1/agent/run`` — control channel. Accepts an :class:`AgentRunRequest`
  (user input/prompt + selected mode), routes it through the
  :class:`ModeRouter`, registers a run, and returns its ``runId``
  (design.md "Communication Channels").
- ``POST /v1/agent/decision`` — control channel. Carries an approval or
  budget-continuation decision for an in-flight run.
- ``GET /v1/agent/events`` — telemetry channel. The single ordered SSE bus
  (``text/event-stream``) the frontend subscribes to (R6.1).

The contract-validation **emit gate** and FSM-ordered emission (R6.2, R6.4,
R6.5) are implemented here (task 7.2): every event a producer pushes for a run
goes through the run's :class:`~zocai_gateway.emit_gate.EmitGate`, which
validates it against the Event_Contract, discards non-conforming payloads while
keeping the stream open, and enqueues conforming events onto the run's FIFO
queue in production order. The SSE generator then drains that queue in order.
Mode-scoped channel discipline (R6.6, R6.7) is layered on by task 7.3, and the
FSM/Orchestrator producer is wired end to end by task 14.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import queue
import signal
import subprocess
import threading
import uuid
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager, suppress
from datetime import UTC, datetime
from pathlib import Path
from time import monotonic
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field
from shared_schema.agent_events import AgentEvent, DoneEvent
from shared_schema.models import (
    ContextCandidate,
    CreateSessionRequest,
    IndexQueryResult,
    IndexStatus,
    ModelBenchmarkHistory,
    ModelBenchmarkRun,
    RunModelBenchmarkRequest,
    Session,
    TerminalSession,
    TerminalSessionStatus,
    UpdateSessionRequest,
)
from sse_starlette.sse import EventSourceResponse
from zocai_evolution import EvolutionEngine

from zocai_gateway.auth import (
    STATE_SETTINGS_KEY,
    extract_credential,
    is_request_admitted,
    require_admission,
)
from zocai_gateway.benchmark import BenchmarkStore, ModelBenchmarker
from zocai_gateway.context.index_store import IndexPersistence
from zocai_gateway.context_mentions import search_workspace_files
from zocai_gateway.emit_gate import DiaryMirror, EmitGate
from zocai_gateway.event_bus import (
    FS_CHANGED_TOPIC,
    GatewayEventBus,
    WorkspaceFilesChanged,
)
from zocai_gateway.fsm import FSM
from zocai_gateway.memory import reconstruction
from zocai_gateway.memory.diary_worker import DiaryWorker
from zocai_gateway.memory.hermes_evolution import HermesEvolution
from zocai_gateway.memory.matrix import MemoryMatrix
from zocai_gateway.memory.state_wrapper import StateWrapperStore
from zocai_gateway.mode_router import AgentRunRequest, ExecutionPath, Mode, ModeRouter
from zocai_gateway.routes.completions import (
    CompletionCache,
    CompletionRequest,
    stream_completion_events,
)
from zocai_gateway.routes.lsp import proxy_lsp
from zocai_gateway.run_pipeline import (
    AgentBrain,
    ApplyStrategy,
    default_workspace_rag_matcher,
    execute_run,
)
from zocai_gateway.settings import GatewaySettings
from zocai_gateway.workspace_index import WorkspaceIndexer

__all__ = [
    "AgentRunRequest",
    "DecisionAck",
    "DecisionKind",
    "DecisionRequest",
    "DecisionVerdict",
    "RunAccepted",
    "RunRegistry",
    "SessionRegistry",
    "app",
    "create_app",
]


logger = logging.getLogger(__name__)

#: Kinds of decision the control channel accepts (design "Communication
#: Channels"): explicit approvals (R3.7-style gates) and budget-continuation
#: prompts (R4.x).
DecisionKind = Literal["approval", "budget-continuation", "review"]

#: The verdict a Developer returns for a pending decision. Approvals use
#: ``approve``/``reject``; budget-continuation prompts use ``continue``/``stop``.
DecisionVerdict = Literal["approve", "reject", "continue", "stop", "apply", "discard"]


class RunAccepted(BaseModel):
    """Response for an accepted :class:`AgentRunRequest`.

    ``runId`` identifies the run on the telemetry channel; the frontend passes
    it back to ``GET /v1/agent/events`` to subscribe to this run's stream.
    """

    model_config = ConfigDict(populate_by_name=True)

    run_id: str = Field(alias="runId")
    mode: Mode
    accepted: bool = True


class DecisionRequest(BaseModel):
    """An approval or budget-continuation decision for an in-flight run."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    run_id: str = Field(alias="runId")
    kind: DecisionKind
    decision: DecisionVerdict
    accepted_paths: list[str] = Field(default_factory=list, alias="acceptedPaths")


class DecisionAck(BaseModel):
    """Acknowledgement that a decision was recorded against a run."""

    model_config = ConfigDict(populate_by_name=True)

    run_id: str = Field(alias="runId")
    kind: DecisionKind
    decision: DecisionVerdict
    accepted: bool = True


class SpawnTerminalRequest(BaseModel):
    """Request body for creating a sidecar-backed terminal."""

    model_config = ConfigDict(extra="ignore")

    cmd: str
    args: list[str] = Field(default_factory=list)
    cwd: str | None = None
    cols: int = Field(default=120, ge=1, le=500)
    rows: int = Field(default=32, ge=1, le=200)


class TerminalInputRequest(BaseModel):
    """Bytes typed by the user into a terminal."""

    data: str


class TerminalResizeRequest(BaseModel):
    """Terminal viewport size from xterm.js."""

    cols: int = Field(default=120, ge=1, le=500)
    rows: int = Field(default=32, ge=1, le=200)


class IndexQueryRequest(BaseModel):
    """Hybrid lexical/semantic query against a session workspace index."""

    model_config = ConfigDict(extra="ignore")

    query: str = Field(min_length=1, max_length=2_000)
    top_k: int = Field(default=8, ge=1, le=50)


class WorkspaceFilesChangedRequest(BaseModel):
    """Filesystem paths forwarded from the desktop ``fs://changed`` event."""

    model_config = ConfigDict(extra="ignore")

    paths: list[str] = Field(min_length=1, max_length=1_000)


class _Run:
    """In-memory state for a single registered run.

    ``queue`` is the per-run event channel the SSE generator drains. A ``None``
    item is the close sentinel that ends the stream. Producers never push onto
    ``queue`` directly: they go through :attr:`emit_gate`, which validates each
    payload against the Event_Contract and only enqueues conforming events, in
    FSM production order (R6.2, R6.4, R6.5). ``enqueue`` is the gate's sink and
    appends to the FIFO queue, so emission order equals production order.
    """

    __slots__ = (
        "_closed",
        "_decision_condition",
        "_decision_cursors",
        "_lock",
        "_loop",
        "_seq",
        "decisions",
        "emit_gate",
        "path",
        "queue",
        "run_id",
    )

    def __init__(
        self, run_id: str, path: ExecutionPath, diary: DiaryMirror | None = None
    ) -> None:
        self.run_id = run_id
        self.path = path
        self.queue: asyncio.Queue[dict[str, object] | None] = asyncio.Queue()
        self.decisions: list[DecisionRequest] = []
        self.emit_gate = EmitGate(sink=self._enqueue, diary=diary)
        self._decision_condition = threading.Condition()
        self._decision_cursors: dict[DecisionKind, int] = {
            "approval": 0,
            "budget-continuation": 0,
            "review": 0,
        }
        try:
            self._loop: asyncio.AbstractEventLoop | None = asyncio.get_running_loop()
        except RuntimeError:
            self._loop = None
        self._lock = threading.Lock()
        self._closed = False
        self._seq = 0

    def _enqueue(self, event: Mapping[str, object]) -> None:
        """FIFO sink for the run's emit gate (R6.5).

        Pipeline work can run in a worker thread, while the SSE queue belongs
        to the FastAPI event loop. Enqueue through the captured loop when one is
        available so producers never mutate ``asyncio.Queue`` from the wrong
        thread. The queue is unbounded, so ``put_nowait`` never blocks.
        """
        with self._lock:
            if self._closed:
                return
        self._put(dict(event))

    def enqueue_text(self, chunk: str) -> None:
        """Ask-Mode text sink: enqueue a raw markdown token chunk (R6.6).

        Ask Mode restricts the bus to raw text token chunks, so these frames
        bypass the structured contract gate and are enqueued directly as
        ``token`` frames the SSE generator relays in order.
        """
        with self._lock:
            if self._closed:
                return
            seq = self._seq
            self._seq += 1
        self._put(
            {
                "type": "token",
                "seq": seq,
                "runId": self.run_id,
                "ts": datetime.now(UTC).isoformat(),
                "text": chunk,
                "done": False,
            }
        )

    def enqueue_error(self, message: str) -> None:
        """Enqueue a best-effort SSE error frame for infrastructure failures."""
        with self._lock:
            if self._closed:
                return
            seq = self._seq
            self._seq += 1
        self._put(
            {
                "type": "error",
                "seq": seq,
                "runId": self.run_id,
                "ts": datetime.now(UTC).isoformat(),
                "message": message,
            }
        )

    def emit_fsm_event(self, event: AgentEvent) -> None:
        """FSM emit sink that gates each stage event and closes at DONE (R3.4).

        The FSM emits a contract event on entering each stage; this sink is the
        bridge between that emission and the run's SSE bus. It serializes the
        event to its canonical wire form and pushes it through the run's emit
        gate, so the FSM's events are contract-validated and FIFO-ordered like
        every other producer (R6.2, R6.5).

        When the event is the terminal ``done`` completion event the FSM emits
        on entering DONE, the run is closed **right after** the event is gated:
        the close sentinel is enqueued behind the ``done`` event, so the SSE
        generator drains the completion event and then terminates
        ``GET /v1/agent/events`` for this run (R3.4).
        """
        self.emit_gate.emit(event.model_dump(by_alias=True))
        if isinstance(event, DoneEvent):
            self.close()

    def bind_fsm(self, fsm: FSM) -> FSM:
        """Route ``fsm``'s stage events through this run's gate-and-close sink.

        Wires :attr:`FSM.emit` to :meth:`emit_fsm_event` so that reaching DONE
        drives this run's emit gate and then its close sentinel (R3.4). Returns
        the same ``fsm`` for convenience.
        """
        fsm.emit = self.emit_fsm_event
        return fsm

    def record_decision(self, req: DecisionRequest) -> None:
        """Record a control-channel decision and wake any waiting producer."""
        with self._decision_condition:
            self.decisions.append(req)
            self._decision_condition.notify_all()

    def wait_for_review_decision(
        self, timeout: float | None = None
    ) -> DecisionRequest | None:
        """Block until the next unconsumed review decision lands."""
        return self._wait_for_decision("review", timeout)

    def wait_for_approval_decision(
        self, timeout: float | None = None
    ) -> DecisionRequest | None:
        """Block until the next unconsumed undeclared-write decision lands."""
        return self._wait_for_decision("approval", timeout)

    def _wait_for_decision(
        self, kind: DecisionKind, timeout: float | None
    ) -> DecisionRequest | None:
        deadline = None if timeout is None else monotonic() + timeout
        with self._decision_condition:
            while True:
                start = self._decision_cursors[kind]
                for index in range(start, len(self.decisions)):
                    req = self.decisions[index]
                    if req.kind == kind:
                        self._decision_cursors[kind] = index + 1
                        return req
                self._decision_cursors[kind] = len(self.decisions)
                with self._lock:
                    if self._closed:
                        return None
                if deadline is None:
                    self._decision_condition.wait(timeout=1.0)
                    continue
                remaining = deadline - monotonic()
                if remaining <= 0:
                    return None
                self._decision_condition.wait(timeout=min(remaining, 1.0))

    def close(self) -> None:
        """Signal end-of-stream by enqueuing the close sentinel."""
        with self._lock:
            if self._closed:
                return
            self._closed = True
            if self.path.mode is Mode.ASK:
                seq = self._seq
                self._seq += 1
            else:
                seq = None
        if seq is not None:
            self._put(
                {
                    "type": "token",
                    "seq": seq,
                    "runId": self.run_id,
                    "ts": datetime.now(UTC).isoformat(),
                    "text": "",
                    "done": True,
                }
            )
        self._put(None)
        with self._decision_condition:
            self._decision_condition.notify_all()

    def _put(self, item: dict[str, object] | None) -> None:
        """Put ``item`` onto the SSE queue from either loop or worker thread."""
        loop = self._loop
        if loop is not None and loop.is_running():
            try:
                loop.call_soon_threadsafe(self.queue.put_nowait, item)
                return
            except RuntimeError:
                pass
        self.queue.put_nowait(item)


class RunRegistry:
    """Tracks active runs so the control and telemetry channels share state.

    The control channel (``/run``) creates runs and the telemetry channel
    (``/events``) looks them up by ``runId``. Kept deliberately minimal: a
    process-local map. Durable/session-scoped storage is out of scope here.

    An optional ``diary`` mirror is threaded into every run's emit gate so each
    conforming event is mirrored to the Tier 1 Session_Diary non-blockingly
    (R9.3). When ``None`` (the default), runs emit without mirroring.
    """

    def __init__(self, diary: DiaryMirror | None = None) -> None:
        self._runs: dict[str, _Run] = {}
        self._diary = diary

    def create(self, path: ExecutionPath, run_id: str | None = None) -> _Run:
        run_id = run_id or uuid.uuid4().hex
        if run_id in self._runs:
            raise ValueError(f"run already exists: {run_id}")
        run = _Run(run_id=run_id, path=path, diary=self._diary)
        self._runs[run_id] = run
        return run

    def get(self, run_id: str) -> _Run | None:
        return self._runs.get(run_id)

    def remove(self, run_id: str) -> None:
        """Forget a run after its SSE stream has closed."""
        self._runs.pop(run_id, None)

    def count(self) -> int:
        """Number of currently registered runs."""
        return len(self._runs)


class SessionRegistry:
    """Small in-memory session store for the editor-support session API."""

    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}

    def list(self) -> list[Session]:
        return sorted(
            self._sessions.values(),
            key=lambda session: session.updated_at,
            reverse=True,
        )

    def get(self, session_id: str) -> Session | None:
        return self._sessions.get(session_id)

    def create(self, req: CreateSessionRequest) -> Session:
        session = Session(
            title=req.title,
            workspace_root=req.workspace_root,
            provider=req.provider,
            model=req.model,
        )
        self._sessions[str(session.id)] = session
        return session

    def update(self, session_id: str, req: UpdateSessionRequest) -> Session | None:
        session = self._sessions.get(session_id)
        if session is None:
            return None
        update: dict[str, object] = {
            "updated_at": datetime.now(UTC).replace(tzinfo=None)
        }
        if req.title is not None:
            update["title"] = req.title
        if req.provider is not None:
            update["provider"] = req.provider
        if req.model is not None:
            update["model"] = req.model
        next_session = session.model_copy(update=update)
        self._sessions[session_id] = next_session
        return next_session

    def delete(self, session_id: str) -> bool:
        return self._sessions.pop(session_id, None) is not None


class TerminalProcess:
    """A sidecar-owned terminal process with an SSE output queue."""

    def __init__(self, req: SpawnTerminalRequest) -> None:
        cmd = req.cmd.strip()
        if not cmd:
            raise ValueError("terminal command is empty")
        self.session = TerminalSession(cmd=cmd, args=req.args, cwd=req.cwd)
        self._events: queue.Queue[dict[str, object] | None] = queue.Queue()
        self._lock = threading.Lock()
        self._fd: int | None = None
        self._pid: int | None = None
        self._proc: subprocess.Popen[bytes] | None = None
        self._closed = False
        self._spawn(req)

    def write(self, data: str) -> None:
        raw = data.encode(errors="replace")
        with self._lock:
            if self._closed:
                return
            fd = self._fd
            proc = self._proc
        if fd is not None:
            try:
                os.write(fd, raw)
            except OSError:
                self._finish(None)
            return
        if proc is not None and proc.stdin is not None:
            try:
                proc.stdin.write(raw)
                proc.stdin.flush()
            except OSError:
                self._finish(proc.poll())

    def resize(self, cols: int, rows: int) -> None:
        fd = self._fd
        if fd is None or os.name != "posix":
            return
        try:
            import fcntl
            import struct
            import termios

            size = struct.pack("HHHH", rows, cols, 0, 0)
            fcntl.ioctl(fd, termios.TIOCSWINSZ, size)
        except OSError:
            return

    def stop(self) -> TerminalSession:
        with self._lock:
            pid = self._pid
            proc = self._proc
        if pid is not None:
            with suppress(OSError):
                os.kill(pid, signal.SIGTERM)
        if proc is not None and proc.poll() is None:
            proc.terminate()
        return self.session

    async def events(self) -> AsyncIterator[dict[str, str]]:
        while True:
            item = await asyncio.to_thread(self._events.get)
            if item is None:
                break
            yield {
                "event": str(item.get("type", "message")),
                "data": json.dumps(item),
            }

    def _spawn(self, req: SpawnTerminalRequest) -> None:
        if os.name == "posix":
            self._spawn_pty(req)
        else:
            self._spawn_subprocess(req)

    def _spawn_pty(self, req: SpawnTerminalRequest) -> None:
        import pty

        pid, fd = pty.fork()
        if pid == 0:  # child
            if req.cwd:
                os.chdir(req.cwd)
            argv = [req.cmd, *req.args]
            os.execvpe(req.cmd, argv, os.environ.copy())
        self._pid = pid
        self._fd = fd
        self.resize(req.cols, req.rows)
        threading.Thread(target=self._read_pty, daemon=True).start()

    def _spawn_subprocess(self, req: SpawnTerminalRequest) -> None:
        self._proc = subprocess.Popen(
            [req.cmd, *req.args],
            cwd=req.cwd or None,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=0,
        )
        threading.Thread(target=self._read_subprocess, daemon=True).start()

    def _read_pty(self) -> None:
        assert self._fd is not None
        exit_code: int | None = None
        try:
            while True:
                try:
                    chunk = os.read(self._fd, 4096)
                except OSError:
                    break
                if not chunk:
                    break
                self._events.put(
                    {"type": "data", "chunk": chunk.decode(errors="replace")}
                )
        finally:
            pid = self._pid
            if pid is not None:
                try:
                    _pid, status_code = os.waitpid(pid, 0)
                    if os.WIFEXITED(status_code):
                        exit_code = os.WEXITSTATUS(status_code)
                    elif os.WIFSIGNALED(status_code):
                        exit_code = 128 + os.WTERMSIG(status_code)
                except ChildProcessError:
                    exit_code = None
            self._finish(exit_code)

    def _read_subprocess(self) -> None:
        proc = self._proc
        if proc is None or proc.stdout is None:
            self._finish(None)
            return
        try:
            while True:
                chunk = proc.stdout.read(4096)
                if not chunk:
                    break
                self._events.put(
                    {"type": "data", "chunk": chunk.decode(errors="replace")}
                )
        finally:
            self._finish(proc.wait())

    def _finish(self, exit_code: int | None) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            if self._fd is not None:
                with suppress(OSError):
                    os.close(self._fd)
        self.session = self.session.model_copy(
            update={
                "status": TerminalSessionStatus.exited,
                "exit_code": exit_code,
            }
        )
        self._events.put({"type": "exit", "code": exit_code})
        self._events.put(None)


class TerminalRegistry:
    """Tracks sidecar terminal processes by session id."""

    def __init__(self) -> None:
        self._terminals: dict[str, TerminalProcess] = {}

    def create(self, req: SpawnTerminalRequest) -> TerminalProcess:
        terminal = TerminalProcess(req)
        self._terminals[str(terminal.session.id)] = terminal
        return terminal

    def get(self, terminal_id: str) -> TerminalProcess | None:
        return self._terminals.get(terminal_id)

    def remove(self, terminal_id: str) -> None:
        self._terminals.pop(terminal_id, None)


async def _event_stream(
    run: _Run | None,
    *,
    registry: RunRegistry | None = None,
    queue_timeout_seconds: float = 300.0,
) -> AsyncIterator[dict[str, str]]:
    """Yield SSE frames for ``run`` until its close sentinel arrives.

    When ``run`` is ``None`` (no/unknown ``runId``) the stream still opens with
    a single ``ping`` frame and then closes, so consumers always see a
    well-formed ``text/event-stream`` (R6.1). For a known run this generator
    relays the run's FIFO queue in order: producers feed that queue exclusively
    through the run's emit gate, so the bus carries only contract-conforming
    events in FSM production order (R6.4, R6.5).
    """
    if run is None:
        yield {"event": "ping", "data": ""}
        return

    try:
        while True:
            try:
                item = await asyncio.wait_for(
                    run.queue.get(), timeout=queue_timeout_seconds
                )
            except TimeoutError:
                message = "SSE stream timed out waiting for gateway events"
                yield {
                    "event": "error",
                    "data": json.dumps(
                        {
                            "type": "error",
                            "seq": -1,
                            "runId": run.run_id,
                            "ts": datetime.now(UTC).isoformat(),
                            "message": message,
                        }
                    ),
                }
                run.close()
                break
            if item is None:  # close sentinel
                break
            event_type = item.get("type")
            yield {
                "event": str(event_type) if event_type is not None else "message",
                "data": json.dumps(item),
            }
    finally:
        if registry is not None:
            registry.remove(run.run_id)


def create_app(
    diary: DiaryMirror | None = None,
    *,
    settings: GatewaySettings | None = None,
    workspace_root: Path | str | None = None,
    brain: AgentBrain | None = None,
    evolution: EvolutionEngine | None = None,
    benchmarker: ModelBenchmarker | None = None,
    workspace_indexer: WorkspaceIndexer | None = None,
    drive: bool = True,
) -> FastAPI:
    """Create and configure the gateway FastAPI application.

    Args:
        diary: Optional Tier 1 diary mirror wired into every run's emit gate so
            conforming events are mirrored to the Session_Diary non-blockingly
            (R9.3). When ``None`` and ``workspace_root`` is given, a real
            :class:`~zocai_gateway.memory.diary_worker.DiaryWorker` is started
            and used as the mirror.
        settings: The resolved :class:`GatewaySettings` describing the active
            bind host and credential. Published on ``app.state`` under
            :data:`~zocai_gateway.auth.STATE_SETTINGS_KEY` so the
            request-admission guard (R12.3/R12.4) can read the live policy.
            Defaults to ``GatewaySettings()`` (loopback, no credential) so an
            app constructed without explicit security wiring admits loopback
            requests (R12.4).
        workspace_root: When supplied, the ``.zocai/`` memory matrix is
            initialized under it (R9.1/R9.2), a Diary_Worker mirror and the
            Tier 3 Hermes-Evolution idle loop (R9.7) are started, and runs are
            driven against that workspace.
        brain: Optional model behavior driving runs; when omitted, the live
            runtime brain is used and MAP_FILES fails closed if no provider is
            configured.
        evolution: Optional Layer 5 Evolution_Engine; one is created when
            omitted so verified runs record trajectories (R12).
        benchmarker: Optional local-model benchmark service. Tests may inject
            an isolated store and deterministic model callbacks.
        workspace_indexer: Optional session-scoped workspace index service.
        drive: When ``True`` (default) an accepted run is driven end to end
            through the composed pipeline so its events stream over the bus.
    """
    router = ModeRouter()

    # R12: the active bind/auth policy. Defaults to loopback-no-credential so a
    # bare ``create_app()`` (e.g. tests) admits loopback requests (R12.4).
    resolved_settings = settings if settings is not None else GatewaySettings()

    # Layer 4 persistence (R9): with a workspace, initialize the .zocai/ matrix,
    # start the non-blocking Diary_Worker mirror (R9.3) and the Tier 3
    # Hermes-Evolution idle loop (R9.7), and bind the Tier 2 State_Wrapper store
    # the hot-swap serializes to (R11.1).
    diary_path: Path | None = None
    diary_worker: DiaryWorker | None = None
    hermes: HermesEvolution | None = None
    state_store: StateWrapperStore | None = None
    resolved_root = Path(workspace_root) if workspace_root is not None else None

    if resolved_root is not None:
        matrix = MemoryMatrix(resolved_root)
        matrix.initialize()
        diary_path = matrix.session_diary_path
        state_store = StateWrapperStore(matrix.state_wrapper_path)
        if diary is None:
            diary_worker = DiaryWorker(diary_path)
            diary = diary_worker
        hermes = HermesEvolution(matrix)

    # Layer 5: a single Evolution_Engine records verified-run trajectories (R12).
    engine = evolution if evolution is not None else EvolutionEngine()
    active_benchmarker = benchmarker or ModelBenchmarker(BenchmarkStore())
    active_workspace_indexer = workspace_indexer or WorkspaceIndexer(
        persistence=IndexPersistence()
    )
    event_bus = GatewayEventBus()
    unsubscribe_indexer = event_bus.subscribe(
        FS_CHANGED_TOPIC, active_workspace_indexer.handle_fs_changed
    )
    run_tasks: set[asyncio.Task[None]] = set()

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        """Own all background worker and run-task lifecycles."""
        try:
            if diary_worker is not None:
                diary_worker.start()
            if hermes is not None:
                hermes.start()
            yield
        finally:
            for task in tuple(run_tasks):
                task.cancel()
            unsubscribe_indexer()
            try:
                if run_tasks:
                    await asyncio.gather(*run_tasks, return_exceptions=True)
                await active_workspace_indexer.close()
            finally:
                if hermes is not None:
                    hermes.stop()
                if diary_worker is not None:
                    diary_worker.stop()

    app = FastAPI(
        title="Zoc AI Gateway",
        version="0.1.0",
        description="Streaming gateway sidecar for the Zoc AI Ecosystem (Layer 2).",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=(
            r"^(https?://(localhost|127\.0\.0\.1)(:\d+)?"
            r"|tauri://localhost|https?://tauri\.localhost)$"
        ),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    registry = RunRegistry(diary=diary)
    sessions = SessionRegistry()
    terminals = TerminalRegistry()
    app.state.run_registry = registry
    app.state.session_registry = sessions
    app.state.terminal_registry = terminals
    app.state.mode_router = router
    setattr(app.state, STATE_SETTINGS_KEY, resolved_settings)
    app.state.diary = diary
    app.state.diary_worker = diary_worker
    app.state.diary_path = diary_path
    app.state.hermes = hermes
    app.state.evolution = engine
    app.state.model_benchmarker = active_benchmarker
    app.state.workspace_indexer = active_workspace_indexer
    app.state.event_bus = event_bus
    app.state.state_store = state_store
    # §3.3: one process-wide completion cache (like the other app.state
    # registries); the completions route reads/writes it (R14).
    completion_cache = CompletionCache()
    app.state.completion_cache = completion_cache

    run_root = str(resolved_root) if resolved_root is not None else "."
    diary_sink = diary.append if diary is not None else None

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/v1/agent/runtime", dependencies=[Depends(require_admission)])
    async def agent_runtime() -> dict[str, object]:
        """Small diagnostics snapshot for the desktop UI and smoke tests."""
        return {
            "status": "ok",
            "active_runs": registry.count(),
            "workspace_root": run_root,
            "diary_enabled": diary_path is not None,
        }

    @app.websocket("/v1/workspace/index-progress")
    async def workspace_index_progress(websocket: WebSocket) -> None:
        """Publish live workspace indexing progress to status-bar clients."""
        presented = extract_credential(websocket.headers)
        if not is_request_admitted(resolved_settings, presented):
            await websocket.close(code=1008, reason="unauthorized")
            return
        await websocket.accept()
        progress_queue = active_workspace_indexer.broker.subscribe()
        try:
            while True:
                event_task = asyncio.create_task(progress_queue.get())
                receive_task = asyncio.create_task(websocket.receive())
                tasks = {event_task, receive_task}
                done: set[asyncio.Task[object]] = set()
                try:
                    completed, _pending = await asyncio.wait(
                        tasks,
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    done = set(completed)
                finally:
                    pending = tasks - done
                    for task in pending:
                        task.cancel()
                    await asyncio.gather(*pending, return_exceptions=True)
                if receive_task in done:
                    message = receive_task.result()
                    if message.get("type") == "websocket.disconnect":
                        break
                if event_task in done:
                    event = event_task.result()
                    await websocket.send_json(
                        event.model_dump(mode="json", by_alias=True)
                    )
        except (asyncio.CancelledError, WebSocketDisconnect, RuntimeError):
            pass
        finally:
            active_workspace_indexer.broker.unsubscribe(progress_queue)

    @app.websocket("/v1/lsp/{server_name}/ws")
    async def lsp_proxy(websocket: WebSocket, server_name: str) -> None:
        """Proxy a Monaco LSP client to an allowlisted stdio language server (§3.1).

        Loopback-only + allowlisted server names + workspace-pinned ``cwd`` keep
        the subprocess spawn safe; an unauthorized request or an unknown server
        name is rejected before the language server is launched.
        """
        presented = extract_credential(websocket.headers)
        if not is_request_admitted(resolved_settings, presented):
            await websocket.close(code=1008, reason="unauthorized")
            return
        await proxy_lsp(
            websocket,
            server_name,
            workspace_root=resolved_root if resolved_root is not None else Path.cwd(),
        )

    @app.post("/v1/completions", dependencies=[Depends(require_admission)])
    async def completions(req: CompletionRequest) -> EventSourceResponse:
        """Stream an inline AI completion as Server-Sent Events (§3.3).

        Reuses the Gateway's loopback bind and shared-token admission — the
        ``require_admission`` dependency rejects an unadmitted request before
        this body runs, so the model is unreachable on that path (R15). The
        ``CompletionRequest`` validation (R11.2) has already run before the
        handler. The stream fails quiet: any model outcome terminates with a
        single ``done`` event and no error frame (R16).
        """
        return EventSourceResponse(
            stream_completion_events(req, cache=completion_cache)
        )

    @app.get(
        "/v1/model-benchmarks",
        response_model=ModelBenchmarkHistory,
        response_model_by_alias=True,
        dependencies=[Depends(require_admission)],
    )
    async def model_benchmark_history(
        model_id: str = Query(alias="modelId", min_length=1, max_length=500),
    ) -> ModelBenchmarkHistory:
        """Return newest-first benchmark history for one local model."""
        try:
            return await asyncio.to_thread(active_benchmarker.store.history, model_id)
        except RuntimeError as exc:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=str(exc),
            ) from exc

    @app.post(
        "/v1/model-benchmarks",
        response_model=ModelBenchmarkRun,
        response_model_by_alias=True,
        dependencies=[Depends(require_admission)],
    )
    async def run_model_benchmark(
        req: RunModelBenchmarkRequest,
    ) -> ModelBenchmarkRun:
        """Run the fixed five-prompt suite against the active local model."""
        try:
            return await asyncio.to_thread(active_benchmarker.run, req)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=str(exc),
            ) from exc
        except RuntimeError as exc:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=str(exc),
            ) from exc

    @app.get(
        "/v1/sessions",
        response_model=list[Session],
        dependencies=[Depends(require_admission)],
    )
    async def list_sessions() -> list[Session]:
        """Return known editor-support sessions."""
        return sessions.list()

    @app.post(
        "/v1/sessions",
        response_model=Session,
        status_code=status.HTTP_201_CREATED,
        dependencies=[Depends(require_admission)],
    )
    async def create_session(req: CreateSessionRequest) -> Session:
        """Create a session and initialize its semantic index policy."""
        session = sessions.create(req)
        try:
            await active_workspace_indexer.open_workspace(
                str(session.id), session.workspace_root
            )
        except ValueError as exc:
            sessions.delete(str(session.id))
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=str(exc),
            ) from exc
        return session

    @app.get(
        "/v1/sessions/{session_id}",
        response_model=Session,
        dependencies=[Depends(require_admission)],
    )
    async def get_session(session_id: str) -> Session:
        """Return one editor-support session."""
        session = sessions.get(session_id)
        if session is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"unknown session: {session_id}",
            )
        return session

    @app.patch(
        "/v1/sessions/{session_id}",
        response_model=Session,
        dependencies=[Depends(require_admission)],
    )
    async def update_session(session_id: str, req: UpdateSessionRequest) -> Session:
        """Partially update an editor-support session, including rename."""
        session = sessions.update(session_id, req)
        if session is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"unknown session: {session_id}",
            )
        return session

    @app.delete(
        "/v1/sessions/{session_id}",
        status_code=status.HTTP_204_NO_CONTENT,
        dependencies=[Depends(require_admission)],
    )
    async def delete_session(session_id: str) -> None:
        """Delete one editor-support session."""
        if not sessions.delete(session_id):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"unknown session: {session_id}",
            )

    @app.get(
        "/v1/sessions/{session_id}/context/search",
        response_model=list[ContextCandidate],
        dependencies=[Depends(require_admission)],
    )
    async def search_context(
        session_id: str,
        q: str = Query(default="", max_length=200),
        limit: int = Query(default=25, ge=1, le=100),
    ) -> list[ContextCandidate]:
        """Search workspace files for the Composer `@` picker."""
        session = sessions.get(session_id)
        if session is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"unknown session: {session_id}",
            )
        workspace = Path(session.workspace_root or run_root)
        resolved_workspace = workspace.resolve()
        candidates: list[ContextCandidate] = []
        for path in search_workspace_files(resolved_workspace, q, limit):
            try:
                detail = path.resolve().relative_to(resolved_workspace).as_posix()
            except ValueError:
                detail = path.as_posix()
            candidates.append(
                ContextCandidate(
                    kind="file",
                    label=path.name,
                    path=detail,
                    detail=detail,
                    line=None,
                )
            )
        return candidates

    @app.get(
        "/v1/sessions/{session_id}/index/status",
        response_model=IndexStatus,
        dependencies=[Depends(require_admission)],
    )
    async def index_status(session_id: str) -> IndexStatus:
        session = sessions.get(session_id)
        if session is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"unknown session: {session_id}",
            )
        return active_workspace_indexer.status(session_id, session.workspace_root)

    @app.post(
        "/v1/sessions/{session_id}/index/reindex",
        response_model=IndexStatus,
        dependencies=[Depends(require_admission)],
    )
    async def rebuild_index(session_id: str) -> IndexStatus:
        session = sessions.get(session_id)
        if session is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"unknown session: {session_id}",
            )
        try:
            return await active_workspace_indexer.rebuild(
                session_id,
                session.workspace_root,
                force=True,
            )
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=str(exc),
            ) from exc

    @app.post(
        "/v1/sessions/{session_id}/index/query",
        response_model=list[IndexQueryResult],
        dependencies=[Depends(require_admission)],
    )
    async def query_index(
        session_id: str,
        req: IndexQueryRequest,
    ) -> list[IndexQueryResult]:
        session = sessions.get(session_id)
        if session is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"unknown session: {session_id}",
            )
        return await active_workspace_indexer.query_async(
            session_id,
            session.workspace_root,
            req.query,
            req.top_k,
        )

    @app.post(
        "/v1/sessions/{session_id}/index/fs-changed",
        status_code=status.HTTP_202_ACCEPTED,
        dependencies=[Depends(require_admission)],
    )
    async def workspace_files_changed(
        session_id: str,
        req: WorkspaceFilesChangedRequest,
    ) -> dict[str, int]:
        if sessions.get(session_id) is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"unknown session: {session_id}",
            )
        unique_paths = tuple(dict.fromkeys(req.paths))
        await event_bus.publish(
            FS_CHANGED_TOPIC,
            WorkspaceFilesChanged(session_id=session_id, paths=unique_paths),
        )
        return {"accepted": len(unique_paths)}

    @app.post(
        "/v1/terminal",
        response_model=TerminalSession,
        status_code=status.HTTP_201_CREATED,
        dependencies=[Depends(require_admission)],
    )
    async def spawn_terminal(req: SpawnTerminalRequest) -> TerminalSession:
        """Spawn a sidecar-owned terminal process for the bottom dock."""
        try:
            terminal = terminals.create(req)
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"failed to spawn terminal: {exc}",
            ) from exc
        return terminal.session

    @app.post(
        "/v1/terminal/{terminal_id}/input",
        status_code=status.HTTP_204_NO_CONTENT,
        dependencies=[Depends(require_admission)],
    )
    async def terminal_input(
        terminal_id: str,
        req: TerminalInputRequest,
    ) -> None:
        terminal = terminals.get(terminal_id)
        if terminal is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"unknown terminal: {terminal_id}",
            )
        terminal.write(req.data)

    @app.post(
        "/v1/terminal/{terminal_id}/resize",
        status_code=status.HTTP_204_NO_CONTENT,
        dependencies=[Depends(require_admission)],
    )
    async def terminal_resize(
        terminal_id: str,
        req: TerminalResizeRequest,
    ) -> None:
        terminal = terminals.get(terminal_id)
        if terminal is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"unknown terminal: {terminal_id}",
            )
        terminal.resize(req.cols, req.rows)

    @app.post(
        "/v1/terminal/{terminal_id}/stop",
        response_model=TerminalSession,
        dependencies=[Depends(require_admission)],
    )
    async def stop_terminal(terminal_id: str) -> TerminalSession:
        terminal = terminals.get(terminal_id)
        if terminal is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"unknown terminal: {terminal_id}",
            )
        return terminal.stop()

    @app.get(
        "/v1/terminal/{terminal_id}/stream",
        dependencies=[Depends(require_admission)],
    )
    async def terminal_stream(terminal_id: str) -> EventSourceResponse:
        terminal = terminals.get(terminal_id)
        if terminal is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"unknown terminal: {terminal_id}",
            )

        async def stream() -> AsyncIterator[dict[str, str]]:
            try:
                async for item in terminal.events():
                    yield item
            finally:
                if terminal.session.status is TerminalSessionStatus.exited:
                    terminals.remove(terminal_id)

        return EventSourceResponse(stream())

    @app.post(
        "/v1/agent/run",
        response_model=RunAccepted,
        response_model_by_alias=True,
        dependencies=[Depends(require_admission)],
    )
    async def agent_run(req: AgentRunRequest) -> RunAccepted:
        """Start a run: route by mode, register it, and drive it end to end.

        Registering yields the run's emit gate (with its diary mirror); driving
        composes the full backend pipeline (allocator → FSM/orchestrator →
        context bus → emit gate → diary, with hot-swap state preservation) so
        every event for the run is produced on one ordered path (R6.5, R9.3,
        R11.1, R1.9). Ask runs stream over the text-only channel (R6.6).
        """
        path = router.route(req)
        try:
            run = registry.create(path, run_id=req.run_id)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=str(exc),
            ) from exc
        run_workspace_root = req.workspace_root or run_root
        logger.info(
            "agent run accepted run_id=%s mode=%s provider=%s model=%s base_url=%s",
            run.run_id,
            req.mode,
            req.provider,
            req.model,
            req.base_url,
        )
        # Live runs (no injected brain) get the real Context Bus matcher and the
        # iterative ReAct apply loop. The ReAct executor self-gates on a
        # configured provider + a non-empty structured plan and otherwise falls
        # back to single-pass, so this is safe when no model is configured.
        # Injected brains (tests) keep the no-op matcher / single-pass default so
        # their deterministic runs are unchanged.
        live_run = brain is None
        run_rag_matcher = (
            default_workspace_rag_matcher(run_workspace_root) if live_run else None
        )
        run_apply_strategy = (
            ApplyStrategy.REACT if live_run else ApplyStrategy.SINGLE_PASS
        )
        if drive:
            async def drive_run() -> None:
                try:
                    await asyncio.wait_for(
                        asyncio.to_thread(
                            execute_run,
                            req,
                            run.run_id,
                            gate=run.emit_gate,
                            text_sink=run.enqueue_text,
                            close=run.close,
                            workspace_root=run_workspace_root,
                            state_store=state_store,
                            evolution=engine,
                            diary_sink=diary_sink,
                            brain=brain,
                            rag_matcher=run_rag_matcher,
                            wait_for_review_decision=run.wait_for_review_decision,
                            wait_for_approval_decision=run.wait_for_approval_decision,
                            workspace_indexer=active_workspace_indexer,
                            index_session_id=run.run_id,
                            apply_strategy=run_apply_strategy,
                        ),
                        timeout=resolved_settings.run_timeout_seconds,
                    )
                except TimeoutError:
                    message = (
                        "agent run exceeded "
                        f"{resolved_settings.run_timeout_seconds:g}s timeout"
                    )
                    logger.warning("run %s timed out", run.run_id)
                    run.enqueue_error(message)
                    run.close()
                except Exception as exc:  # pragma: no cover - defensive boundary
                    logger.exception("run %s failed", run.run_id)
                    run.enqueue_error(f"agent run failed: {type(exc).__name__}: {exc}")
                    run.close()

            task = asyncio.create_task(drive_run())
            run_tasks.add(task)
            task.add_done_callback(run_tasks.discard)
        return RunAccepted(run_id=run.run_id, mode=req.mode)

    @app.post(
        "/v1/agent/decision",
        response_model=DecisionAck,
        response_model_by_alias=True,
        dependencies=[Depends(require_admission)],
    )
    async def agent_decision(req: DecisionRequest) -> DecisionAck:
        """Record an approval, budget-continuation, or review decision."""
        run = registry.get(req.run_id)
        if run is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"unknown run: {req.run_id}",
            )
        if req.kind == "approval" and req.decision not in {"approve", "reject"}:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="approval decisions must be 'approve' or 'reject'",
            )
        if req.kind == "review":
            if req.decision not in {"apply", "discard"}:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="review decisions must be 'apply' or 'discard'",
                )
            if req.decision == "apply" and not req.accepted_paths:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="apply requires at least one accepted path",
                )
        run.record_decision(req)
        return DecisionAck(run_id=req.run_id, kind=req.kind, decision=req.decision)

    @app.get("/v1/agent/events", dependencies=[Depends(require_admission)])
    async def agent_events(
        run_id: str | None = Query(default=None, alias="runId"),
    ) -> EventSourceResponse:
        """Subscribe to the single ordered SSE telemetry bus (R6.1)."""
        run = registry.get(run_id) if run_id is not None else None
        return EventSourceResponse(
            _event_stream(
                run,
                registry=registry,
                queue_timeout_seconds=resolved_settings.sse_queue_timeout_seconds,
            )
        )

    @app.get("/v1/agent/diary", dependencies=[Depends(require_admission)])
    async def agent_diary(
        run_id: str | None = Query(default=None, alias="runId"),
    ) -> list[dict[str, object]]:
        """Return the trailing Session_Diary events for feed recovery (R10.2).

        Backed by ``.zocai/session_diary.jsonl``: on reconnect the frontend
        reads the active (or named) run's trailing entries from here to rebuild
        its feed before resuming live streaming. Returns an empty list when no
        workspace-backed diary is configured.
        """
        if diary_path is None:
            return []
        if diary_worker is not None:
            diary_worker.wait_until_idle(timeout=5.0)
        entries = reconstruction.read_diary_entries(diary_path)
        trailing = reconstruction.trailing_entries(entries, run_id)
        return [dict(entry.payload) for entry in trailing]

    return app


app = create_app()
