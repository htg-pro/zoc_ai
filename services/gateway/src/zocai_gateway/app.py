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
from collections import deque
from collections.abc import AsyncIterator, Mapping
from concurrent.futures import TimeoutError as FuturesTimeoutError
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

from zocai_gateway import hardware_probe, model_runtime
from zocai_gateway.auth import (
    STATE_SETTINGS_KEY,
    extract_credential,
    is_request_admitted,
    require_admission,
)
from zocai_gateway.benchmark import BenchmarkStore, ModelBenchmarker
from zocai_gateway.context.index_store import IndexPersistence
from zocai_gateway.context.mcp_host.host import MCPHost
from zocai_gateway.context.mcp_host.registry import McpToolRegistry
from zocai_gateway.context_mentions import search_workspace_files
from zocai_gateway.emit_gate import DiaryMirror, EmitGate
from zocai_gateway.event_bus import (
    FS_CHANGED_TOPIC,
    GatewayEventBus,
    WorkspaceFilesChanged,
)
from zocai_gateway.file_locks import FileLockRegistry
from zocai_gateway.fsm import FSM
from zocai_gateway.memory import reconstruction
from zocai_gateway.memory.diary_worker import DiaryWorker
from zocai_gateway.memory.hermes_evolution import HermesEvolution
from zocai_gateway.memory.matrix import MemoryMatrix
from zocai_gateway.memory.project_memory import ProjectMemoryStore
from zocai_gateway.memory.state_wrapper import StateWrapperStore
from zocai_gateway.mode_router import AgentRunRequest, ExecutionPath, Mode, ModeRouter
from zocai_gateway.permissions import build_permission_gate, config_from_mapping
from zocai_gateway.routes.completions import (
    CompletionCache,
    CompletionRequest,
    stream_completion_events,
)
from zocai_gateway.routes.inline import InlineEditRequest, stream_inline_edit_events
from zocai_gateway.routes.lsp import proxy_lsp
from zocai_gateway.routes.mcp import create_mcp_router
from zocai_gateway.run_pipeline import (
    AgentBrain,
    ApplyStrategy,
    default_workspace_rag_matcher,
    execute_run,
)
from zocai_gateway.security import (
    RateLimiter,
    log_security_event,
    validate_user_text,
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

#: Default bounded depth of a run's SSE queue (§9.2). Overridden per app by
#: :attr:`~zocai_gateway.settings.GatewaySettings.sse_queue_maxsize`.
DEFAULT_SSE_QUEUE_MAXSIZE = 512

#: Default number of recent events retained per run for replay (§9.2).
DEFAULT_EVENT_REPLAY_BUFFER = 1024

#: How long a producing worker thread waits for a full queue to drain before it
#: gives up on a frame. Long enough to be real backpressure, short enough that a
#: client which vanished without closing cannot wedge a run forever.
DEFAULT_PRODUCER_PUT_TIMEOUT_SECONDS = 30.0

#: How often the hardware monitor stream emits a snapshot (§16.2).
HARDWARE_STREAM_INTERVAL_SECONDS = 2.0


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

    The queue is **bounded** (``queue_maxsize``, §9.2). A slow or absent SSE
    consumer therefore cannot make the gateway buffer without limit: once the
    queue is full a producer *waits* for space, and because the pipeline runs in
    a worker thread that wait propagates backpressure straight into the agent
    loop. Every emitted frame is also copied into a fixed-size replay buffer so
    a client that drops its connection can resume from a sequence number
    instead of losing the run's history.
    """

    __slots__ = (
        "_cancelled",
        "_closed",
        "_decision_condition",
        "_decision_cursors",
        "_ever_subscribed",
        "_history",
        "_history_lock",
        "_lock",
        "_loop",
        "_put_timeout",
        "_queue_maxsize",
        "_seq",
        "_subscriber_lock",
        "_subscribers",
        "decisions",
        "emit_gate",
        "path",
        "queue",
        "run_id",
    )

    def __init__(
        self,
        run_id: str,
        path: ExecutionPath,
        diary: DiaryMirror | None = None,
        *,
        queue_maxsize: int = DEFAULT_SSE_QUEUE_MAXSIZE,
        replay_buffer_size: int = DEFAULT_EVENT_REPLAY_BUFFER,
        put_timeout_seconds: float = DEFAULT_PRODUCER_PUT_TIMEOUT_SECONDS,
    ) -> None:
        self.run_id = run_id
        self.path = path
        self.queue: asyncio.Queue[dict[str, object] | None] = asyncio.Queue(
            maxsize=max(1, queue_maxsize)
        )
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
        self._cancelled = threading.Event()
        self._seq = 0
        self._history: deque[dict[str, object]] = deque(maxlen=max(1, replay_buffer_size))
        self._history_lock = threading.Lock()
        self._put_timeout = put_timeout_seconds
        self._queue_maxsize = max(1, queue_maxsize)
        self._subscriber_lock = threading.Lock()
        self._subscribers: set[asyncio.Queue[dict[str, object] | None]] = set()
        self._ever_subscribed = False

    @property
    def is_closed(self) -> bool:
        """Whether the run has emitted its close sentinel."""
        with self._lock:
            return self._closed

    @property
    def is_cancelled(self) -> bool:
        """Whether a client requested cooperative cancellation."""
        return self._cancelled.is_set()

    @property
    def subscriber_count(self) -> int:
        """Number of live SSE consumers currently attached to this run."""
        with self._subscriber_lock:
            return len(self._subscribers)

    def subscribe(self) -> asyncio.Queue[dict[str, object] | None]:
        """Attach an independent bounded queue for one SSE consumer.

        The first subscriber adopts ``queue`` so events emitted between run
        acceptance and EventSource connection remain available. Later
        subscribers receive their own queue and rebuild prior rows from the
        replay buffer before consuming live frames.
        """
        with self._subscriber_lock:
            if not self._ever_subscribed:
                subscriber = self.queue
                self._ever_subscribed = True
            else:
                subscriber = asyncio.Queue(maxsize=self._queue_maxsize)
            self._subscribers.add(subscriber)
        if self.is_closed and subscriber.empty():
            subscriber.put_nowait(None)
        return subscriber

    def unsubscribe(self, subscriber: asyncio.Queue[dict[str, object] | None]) -> None:
        """Detach one SSE consumer without affecting the run or its peers."""
        with self._subscriber_lock:
            self._subscribers.discard(subscriber)

    def cancel(self) -> None:
        """Request cooperative cancellation and close this run's event bus."""
        if self.is_closed:
            return
        self._cancelled.set()
        self.enqueue_error("run cancelled by user")
        self.close()

    def replay(self, since_seq: int | None = None) -> list[dict[str, object]]:
        """Buffered events with ``seq`` greater than ``since_seq`` (§9.2).

        Frames without a usable ``seq`` (there should be none, but the buffer is
        a debugging aid as much as a protocol feature) are kept when replaying
        from the beginning and dropped when resuming, since they cannot be
        ordered against the cursor.
        """
        with self._history_lock:
            frames = list(self._history)
        if since_seq is None:
            return frames
        out: list[dict[str, object]] = []
        for frame in frames:
            seq = frame.get("seq")
            if isinstance(seq, int) and seq > since_seq:
                out.append(frame)
        return out

    def _enqueue(self, event: Mapping[str, object]) -> None:
        """FIFO sink for the run's emit gate (R6.5).

        Pipeline work can run in a worker thread, while the SSE queue belongs
        to the FastAPI event loop. Enqueue through the captured loop when one is
        available so producers never mutate ``asyncio.Queue`` from the wrong
        thread. The queue is bounded: worker-thread producers wait for capacity,
        propagating backpressure into the run pipeline. Event-loop control paths
        use the non-blocking fallback in :meth:`_put_one` to avoid deadlocking
        the loop; reconnect replay covers any resulting gap.
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

    def wait_for_review_decision(self, timeout: float | None = None) -> DecisionRequest | None:
        """Block until the next unconsumed review decision lands."""
        return self._wait_for_decision("review", timeout)

    def wait_for_approval_decision(self, timeout: float | None = None) -> DecisionRequest | None:
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
        """Fan a frame out to every bounded SSE subscriber (§9.2).

        Before the first subscriber connects, ``queue`` remains the bounded
        backlog used by the original single-consumer design. Once streaming has
        begun, each EventSource has an independent queue: a LAN viewer can no
        longer steal frames from the desktop feed, and slow consumers exert
        bounded backpressure independently.
        """
        if item is not None:
            with self._history_lock:
                self._history.append(dict(item))

        with self._subscriber_lock:
            targets = tuple(self._subscribers) if self._ever_subscribed else (self.queue,)
        for target in targets:
            self._put_one(target, item)

    def _put_one(
        self,
        target: asyncio.Queue[dict[str, object] | None],
        item: dict[str, object] | None,
    ) -> None:
        """Deliver one frame to one subscriber with bounded backpressure."""
        loop = self._loop
        if loop is None or not loop.is_running():
            try:
                target.put_nowait(item)
            except asyncio.QueueFull:
                logger.warning("run %s dropped a frame: subscriber queue full", self.run_id)
            return

        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None

        if running is loop:
            # Blocking here would deadlock the event loop. Keep the newest frame;
            # the fixed replay buffer remains available for gap recovery.
            try:
                target.put_nowait(item)
            except asyncio.QueueFull:
                with suppress(asyncio.QueueEmpty):
                    target.get_nowait()
                with suppress(asyncio.QueueFull):
                    target.put_nowait(item)
            return

        future = asyncio.run_coroutine_threadsafe(target.put(item), loop)
        try:
            future.result(timeout=self._put_timeout)
        except FuturesTimeoutError:
            future.cancel()
            logger.warning(
                "run %s dropped a frame: consumer stalled for %.0fs",
                self.run_id,
                self._put_timeout,
            )
        except RuntimeError:
            # Loop closed mid-handoff (shutdown); nothing to deliver to.
            pass


class RunRegistry:
    """Tracks active runs so the control and telemetry channels share state.

    The control channel (``/run``) creates runs and the telemetry channel
    (``/events``) looks them up by ``runId``. Kept deliberately minimal: a
    process-local map. Durable/session-scoped storage is out of scope here.

    An optional ``diary`` mirror is threaded into every run's emit gate so each
    conforming event is mirrored to the Tier 1 Session_Diary non-blockingly
    (R9.3). When ``None`` (the default), runs emit without mirroring.
    """

    def __init__(
        self,
        diary: DiaryMirror | None = None,
        *,
        queue_maxsize: int = DEFAULT_SSE_QUEUE_MAXSIZE,
        replay_buffer_size: int = DEFAULT_EVENT_REPLAY_BUFFER,
        max_concurrent_runs: int = 3,
    ) -> None:
        self._runs: dict[str, _Run] = {}
        self._diary = diary
        self._queue_maxsize = queue_maxsize
        self._replay_buffer_size = replay_buffer_size
        self._max_concurrent_runs = max(1, max_concurrent_runs)

    @property
    def max_concurrent_runs(self) -> int:
        return self._max_concurrent_runs

    def active(self) -> list[_Run]:
        """Runs that have not yet closed their stream (§12.3)."""
        return [run for run in self._runs.values() if not run.is_closed]

    def active_count(self) -> int:
        return len(self.active())

    def at_capacity(self) -> bool:
        """Whether starting another run would exceed ``max_concurrent_runs``."""
        return self.active_count() >= self._max_concurrent_runs

    def create(self, path: ExecutionPath, run_id: str | None = None) -> _Run:
        run_id = run_id or uuid.uuid4().hex
        if run_id in self._runs:
            raise ValueError(f"run already exists: {run_id}")
        run = _Run(
            run_id=run_id,
            path=path,
            diary=self._diary,
            queue_maxsize=self._queue_maxsize,
            replay_buffer_size=self._replay_buffer_size,
        )
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
        update: dict[str, object] = {"updated_at": datetime.now(UTC).replace(tzinfo=None)}
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
                self._events.put({"type": "data", "chunk": chunk.decode(errors="replace")})
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
                self._events.put({"type": "data", "chunk": chunk.decode(errors="replace")})
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


def _error_frame(run_id: str, message: str, seq: int = -1) -> dict[str, str]:
    """One SSE ``error`` frame for an infrastructure (non-run) failure."""
    return {
        "event": "error",
        "data": json.dumps(
            {
                "type": "error",
                "seq": seq,
                "runId": run_id,
                "ts": datetime.now(UTC).isoformat(),
                "message": message,
            }
        ),
    }


async def _event_stream(
    run: _Run | None,
    *,
    registry: RunRegistry | None = None,
    queue_timeout_seconds: float = 300.0,
    heartbeat_seconds: float = 15.0,
    client_timeout_seconds: float = 60.0,
    since_seq: int | None = None,
) -> AsyncIterator[dict[str, str]]:
    """Yield SSE frames for ``run`` until its close sentinel arrives.

    When ``run`` is ``None`` (no/unknown ``runId``) the stream still opens with
    a single ``ping`` frame and then closes, so consumers always see a
    well-formed ``text/event-stream`` (R6.1). For a known run this generator
    relays the run's FIFO queue in order: producers feed that queue exclusively
    through the run's emit gate, so the bus carries only contract-conforming
    events in FSM production order (R6.4, R6.5).

    Idle handling (§9.2). A quiet stream is not a broken stream, so the
    generator emits a heartbeat every ``heartbeat_seconds``. Only once the
    stream has been idle for ``client_timeout_seconds`` does it emit a terminal
    error frame and stop. **The run is not cancelled** — it keeps producing into
    its bounded queue and replay buffer, and the client resumes with
    ``?since_seq=N``.

    ``since_seq`` replays the run's buffered history before live streaming, so a
    reconnect rebuilds its feed without a gap.
    """
    if run is None:
        yield {"event": "ping", "data": ""}
        return

    # Register before taking the replay snapshot. Frames racing with replay are
    # also queued, then discarded below through ``replayed_through``; no frame
    # can fall between snapshot and live subscription.
    subscriber = run.subscribe()
    highest_seq = since_seq
    replayed_through: int | None = None
    for frame in run.replay(since_seq):
        event_type = frame.get("type")
        seq = frame.get("seq")
        if isinstance(seq, int):
            highest_seq = seq if highest_seq is None else max(highest_seq, seq)
            replayed_through = seq if replayed_through is None else max(replayed_through, seq)
        yield {
            "event": str(event_type) if event_type is not None else "message",
            "data": json.dumps(frame),
        }

    # The per-frame wait is the heartbeat cadence, capped by the overall queue
    # timeout so an explicitly shortened queue timeout still applies.
    frame_wait = max(0.001, min(heartbeat_seconds, queue_timeout_seconds))
    idle_seconds = 0.0
    idle_ceiling = min(client_timeout_seconds, queue_timeout_seconds)

    try:
        while True:
            try:
                item = await asyncio.wait_for(subscriber.get(), timeout=frame_wait)
            except TimeoutError:
                idle_seconds += frame_wait
                if idle_seconds >= idle_ceiling:
                    # Give up on this *connection*, not on the run: the client
                    # can reconnect with ?since_seq=<highest seq it saw>.
                    yield _error_frame(
                        run.run_id,
                        "SSE stream idle for "
                        f"{idle_seconds:.0f}s; reconnect with ?since_seq="
                        f"{highest_seq if highest_seq is not None else -1} "
                        "to resume (the run is still active)",
                    )
                    break
                yield {"event": "ping", "data": ""}
                continue

            idle_seconds = 0.0
            if item is None:  # close sentinel
                break
            seq = item.get("seq")
            if isinstance(seq, int):
                # A frame can sit in the live queue *and* in the replay buffer
                # (the buffer is written on emit, the queue is drained later).
                # After a resume, skip anything the replay pass already sent so
                # the client never sees the same seq twice.
                if replayed_through is not None and seq <= replayed_through:
                    continue
                highest_seq = seq if highest_seq is None else max(highest_seq, seq)
            event_type = item.get("type")
            yield {
                "event": str(event_type) if event_type is not None else "message",
                "data": json.dumps(item),
            }
    finally:
        run.unsubscribe(subscriber)
        # Only forget a closed run after its final viewer drains the terminal
        # sentinel. One viewer disconnecting must not invalidate another's
        # replay/control lookup.
        if registry is not None and run.is_closed and run.subscriber_count == 0:
            registry.remove(run.run_id)


async def _hardware_stream(
    *,
    interval_seconds: float = HARDWARE_STREAM_INTERVAL_SECONDS,
    max_events: int | None = None,
) -> AsyncIterator[dict[str, str]]:
    """Yield a hardware snapshot every ``interval_seconds`` (§16.2).

    Each probe runs in a worker thread; a probe failure skips that tick rather
    than terminating the stream, so a transient sysfs error does not take the
    status-bar widget down.

    ``max_events`` bounds the stream. Production passes ``None`` (stream until
    the client disconnects); tests pass a small number so the generator
    terminates instead of running forever.
    """
    emitted = 0
    while max_events is None or emitted < max_events:
        try:
            metrics = model_runtime.live_inference_metrics()
            reading = await asyncio.to_thread(
                hardware_probe.snapshot,
                tokens_per_second=metrics.tokens_per_second,
                inference_active=metrics.inference_active,
            )
        except Exception:  # pragma: no cover - defensive probe boundary
            logger.debug("hardware snapshot failed", exc_info=True)
        else:
            emitted += 1
            yield {"event": "hardware", "data": json.dumps(reading.as_payload())}
        if max_events is not None and emitted >= max_events:
            return
        await asyncio.sleep(interval_seconds)


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
    lazy_index: bool = False,
    start_mcp: bool = False,
    mcp_user_config_path: Path | str | None = None,
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
        lazy_index: When ``True`` no workspace index is built at startup
            (``--lazy-index``): files are indexed the first time the agent
            accesses them, and the run-scoped RAG matcher loads only the index
            shards a query needs (§9.1). Large monorepos start instantly at the
            cost of a slower first retrieval.
        start_mcp: Start enabled stdio MCP definitions during application
            lifespan. The production launcher enables this; tests default off.
        mcp_user_config_path: Optional user-scoped ``mcp.json`` document merged
            below the workspace definition and above bundled defaults.
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
        persistence=IndexPersistence(), lazy=lazy_index
    )
    event_bus = GatewayEventBus()
    # §12.3: one registry shared by every run in this process, so concurrent
    # runs serialise their writes per file instead of clobbering each other.
    file_locks = FileLockRegistry()
    # §15.1: one limiter shared by every run start, keyed by workspace.
    run_rate_limiter = RateLimiter()
    unsubscribe_indexer = event_bus.subscribe(
        FS_CHANGED_TOPIC, active_workspace_indexer.handle_fs_changed
    )
    run_tasks: set[asyncio.Task[None]] = set()

    # Part 4 (§4.1): the generic MCP host. ``configure()`` seeds server states
    # from MCP_Config without spawning; enabled stdio servers are started only
    # when ``start_mcp`` is set (the desktop runtime), so tests never spawn.
    mcp_workspace_config = (
        resolved_root / ".zoc" / "mcp.json" if resolved_root is not None else None
    )
    mcp_host = MCPHost(
        workspace_root=str(resolved_root) if resolved_root is not None else ".",
        user_config_path=mcp_user_config_path,
        workspace_config_path=mcp_workspace_config,
        registry=McpToolRegistry(),
    )
    mcp_host.configure()

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        """Own all background worker and run-task lifecycles."""
        try:
            if diary_worker is not None:
                diary_worker.start()
            if hermes is not None:
                hermes.start()
            if start_mcp:
                await mcp_host.load()
            yield
        finally:
            for task in tuple(run_tasks):
                task.cancel()
            unsubscribe_indexer()
            try:
                if run_tasks:
                    await asyncio.gather(*run_tasks, return_exceptions=True)
                await active_workspace_indexer.close()
                await mcp_host.aclose()
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

    registry = RunRegistry(
        diary=diary,
        queue_maxsize=resolved_settings.sse_queue_maxsize,
        replay_buffer_size=resolved_settings.event_replay_buffer_size,
        max_concurrent_runs=resolved_settings.max_concurrent_runs,
    )
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

    # Part 4: publish the MCP host and mount its admitted control routes on the
    # existing listener (no new interface, R10.5).
    app.state.mcp_host = mcp_host
    app.include_router(create_mcp_router(mcp_host))

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
            # §12.3: the run switcher reads these to render its count badge and
            # to disable "new run" once the cap is reached.
            "running": registry.active_count(),
            "max_concurrent_runs": registry.max_concurrent_runs,
            "run_ids": [run.run_id for run in registry.active()],
            "locked_files": list(file_locks.held_paths()),
        }

    @app.get("/v1/hardware", dependencies=[Depends(require_admission)])
    async def hardware() -> dict[str, object]:
        """Detected hardware plus a local-model recommendation (§13.1).

        Drives the onboarding wizard's hardware step. Probing touches sysfs and
        may shell out to ``nvidia-smi``, so it runs in a thread to keep the event
        loop free.
        """
        profile = await asyncio.to_thread(hardware_probe.probe)
        recommendation = hardware_probe.recommend_model(profile)
        metrics = model_runtime.live_inference_metrics()
        live = await asyncio.to_thread(
            hardware_probe.snapshot,
            tokens_per_second=metrics.tokens_per_second,
            inference_active=metrics.inference_active,
        )
        return {
            "gpu_memory_gb": profile.gpu_memory_gb if profile else None,
            "system_memory_gb": profile.system_memory_gb if profile else None,
            "detected": profile is not None,
            "recommendation": {
                "model": recommendation.model,
                "quantization": recommendation.quantization,
                "approx_size_gb": recommendation.approx_size_gb,
                "gpu_layers": recommendation.gpu_layers,
                "reason": recommendation.reason,
            },
            "snapshot": live.as_payload(),
        }

    @app.get("/v1/hardware/stream", dependencies=[Depends(require_admission)])
    async def hardware_stream() -> EventSourceResponse:
        """Stream a hardware snapshot every 2 s for the status-bar widget (§16.2)."""
        return EventSourceResponse(_hardware_stream())

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
                    await websocket.send_json(event.model_dump(mode="json", by_alias=True))
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
        return EventSourceResponse(stream_completion_events(req, cache=completion_cache))

    @app.post("/v1/agent/inline-edit", dependencies=[Depends(require_admission)])
    async def inline_edit(req: InlineEditRequest) -> EventSourceResponse:
        """Stream a Cmd+K inline edit as SSE (§8.2); admission-gated, fails quiet."""
        return EventSourceResponse(stream_inline_edit_events(req))

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
            await active_workspace_indexer.open_workspace(str(session.id), session.workspace_root)
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
        run_root_for_limits = (
            str(resolved_root.resolve())
            if resolved_root is not None
            else (req.workspace_root or run_root)
        )
        # §15.1: validate everything the renderer sends before it reaches a
        # model or the filesystem. Over-length and control-character payloads are
        # rejected here rather than deeper in the pipeline.
        validated = validate_user_text(req.prompt, field="prompt")
        if not validated.ok:
            log_security_event("invalid_input", validated.reason, workspace=run_root_for_limits)
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=validated.reason,
            )
        if validated.text != req.prompt:
            req = req.model_copy(update={"prompt": validated.text})

        # §15.1: cap run starts per workspace so a runaway client (or a
        # compromised renderer) cannot spend the user's tokens in a loop.
        limit = run_rate_limiter.check(run_root_for_limits)
        if not limit.allowed:
            log_security_event(
                "rate_limited",
                f"run start rate limit exceeded ({run_rate_limiter.limit}/min)",
                workspace=run_root_for_limits,
            )
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=(
                    f"rate limit exceeded: max {run_rate_limiter.limit} runs per "
                    f"minute per workspace; retry in "
                    f"{limit.retry_after_seconds:.0f}s"
                ),
                headers={"Retry-After": str(max(1, int(limit.retry_after_seconds)))},
            )

        # §12.3: several runs may execute at once, but not without limit — each
        # holds a model context, a worker thread and an isolated workspace.
        if registry.at_capacity():
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=(
                    f"{registry.active_count()} runs already active "
                    f"(limit {registry.max_concurrent_runs}); "
                    "stop one before starting another"
                ),
            )
        try:
            run = registry.create(path, run_id=req.run_id)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=str(exc),
            ) from exc
        # A desktop sidecar is launched with an authoritative workspace root.
        # Never let a compromised renderer redirect tools to another directory;
        # request roots remain available only for root-less test/web instances.
        run_workspace_root = (
            str(resolved_root.resolve())
            if resolved_root is not None
            else (req.workspace_root or run_root)
        )
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
            default_workspace_rag_matcher(run_workspace_root, lazy=lazy_index) if live_run else None
        )
        run_apply_strategy = ApplyStrategy.REACT if live_run else ApplyStrategy.SINGLE_PASS
        if drive:

            async def drive_run() -> None:
                mcp_loop = asyncio.get_running_loop()
                permission_config = config_from_mapping(req.permission)
                run_permission = build_permission_gate(permission_config, run_workspace_root)
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
                            mcp_host=mcp_host,
                            mcp_loop=mcp_loop,
                            check_permission=run_permission,
                            network_allowlist=permission_config.network_allowlist,
                            is_cancelled=lambda: run.is_cancelled,
                            plan_only=req.mode is Mode.PLAN,
                            file_locks=file_locks,
                            project_memory=ProjectMemoryStore(run_workspace_root),
                            hermes=hermes,
                        ),
                        timeout=resolved_settings.run_timeout_seconds,
                    )
                except TimeoutError:
                    message = (
                        f"agent run exceeded {resolved_settings.run_timeout_seconds:g}s timeout"
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

    @app.post(
        "/v1/agent/runs/{run_id}/cancel",
        dependencies=[Depends(require_admission)],
    )
    async def cancel_agent_run(run_id: str) -> dict[str, object]:
        """Cooperatively stop one run without disturbing concurrent peers."""
        run = registry.get(run_id)
        if run is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"unknown run: {run_id}",
            )
        run.cancel()
        return {"runId": run_id, "cancelled": True}

    @app.get("/v1/agent/events", dependencies=[Depends(require_admission)])
    async def agent_events(
        run_id: str | None = Query(default=None, alias="runId"),
        since_seq: int | None = Query(default=None, alias="since_seq", ge=-1),
    ) -> EventSourceResponse:
        """Subscribe to the single ordered SSE telemetry bus (R6.1).

        ``since_seq`` resumes a dropped connection: the run's buffered events
        after that sequence number are replayed before live streaming continues,
        so a reconnect rebuilds its feed without a gap (§9.2).
        """
        run = registry.get(run_id) if run_id is not None else None
        return EventSourceResponse(
            _event_stream(
                run,
                registry=registry,
                queue_timeout_seconds=resolved_settings.sse_queue_timeout_seconds,
                heartbeat_seconds=resolved_settings.sse_heartbeat_seconds,
                client_timeout_seconds=resolved_settings.sse_client_timeout_seconds,
                since_seq=since_seq,
            )
        )

    @app.get(
        "/v1/agent/runs/{run_id}/events/replay",
        dependencies=[Depends(require_admission)],
    )
    async def agent_events_replay(
        run_id: str,
        since_seq: int | None = Query(default=None, alias="since_seq", ge=-1),
    ) -> dict[str, object]:
        """Replay a run's buffered events without opening a live stream (§9.2).

        Backed by the run's fixed-size circular buffer
        (``event_replay_buffer_size`` frames, 1024 by default), so this is a
        cheap, bounded catch-up call. Returns 404 for an unknown run: a run that
        has fully closed *and* had its stream drained is forgotten, and the
        durable history for that case lives at ``/v1/agent/diary``.
        """
        run = registry.get(run_id)
        if run is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"unknown run: {run_id}",
            )
        events = run.replay(since_seq)
        last = events[-1].get("seq") if events else since_seq
        return {
            "runId": run_id,
            "sinceSeq": since_seq,
            "lastSeq": last,
            "closed": run.is_closed,
            "count": len(events),
            "events": events,
        }

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
