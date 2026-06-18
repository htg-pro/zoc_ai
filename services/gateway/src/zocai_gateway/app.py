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
import threading
import uuid
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sse_starlette.sse import EventSourceResponse

from shared_schema.agent_events import AgentEvent, DoneEvent
from shared_schema.models import CreateSessionRequest, Session, UpdateSessionRequest

from zocai_evolution import EvolutionEngine

from zocai_gateway.auth import STATE_SETTINGS_KEY, require_admission
from zocai_gateway.emit_gate import DiaryMirror, EmitGate
from zocai_gateway.fsm import FSM
from zocai_gateway.memory import reconstruction
from zocai_gateway.memory.diary_worker import DiaryWorker
from zocai_gateway.memory.hermes_evolution import HermesEvolution
from zocai_gateway.memory.matrix import MemoryMatrix
from zocai_gateway.memory.state_wrapper import StateWrapperStore
from zocai_gateway.mode_router import AgentRunRequest, ExecutionPath, Mode, ModeRouter
from zocai_gateway.run_pipeline import AgentBrain, execute_run
from zocai_gateway.settings import GatewaySettings

__all__ = [
    "AgentRunRequest",
    "DecisionAck",
    "DecisionKind",
    "DecisionRequest",
    "DecisionVerdict",
    "RunAccepted",
    "RunRegistry",
    "SessionRegistry",
    "create_app",
    "app",
]


logger = logging.getLogger(__name__)

#: Kinds of decision the control channel accepts (design "Communication
#: Channels"): explicit approvals (R3.7-style gates) and budget-continuation
#: prompts (R4.x).
DecisionKind = Literal["approval", "budget-continuation"]

#: The verdict a Developer returns for a pending decision. Approvals use
#: ``approve``/``reject``; budget-continuation prompts use ``continue``/``stop``.
DecisionVerdict = Literal["approve", "reject", "continue", "stop"]


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


class DecisionAck(BaseModel):
    """Acknowledgement that a decision was recorded against a run."""

    model_config = ConfigDict(populate_by_name=True)

    run_id: str = Field(alias="runId")
    kind: DecisionKind
    decision: DecisionVerdict
    accepted: bool = True


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
        "run_id",
        "path",
        "queue",
        "decisions",
        "emit_gate",
        "_loop",
        "_lock",
        "_closed",
    )

    def __init__(
        self, run_id: str, path: ExecutionPath, diary: DiaryMirror | None = None
    ) -> None:
        self.run_id = run_id
        self.path = path
        self.queue: asyncio.Queue[dict[str, object] | None] = asyncio.Queue()
        self.decisions: list[DecisionRequest] = []
        self.emit_gate = EmitGate(sink=self._enqueue, diary=diary)
        try:
            self._loop: asyncio.AbstractEventLoop | None = asyncio.get_running_loop()
        except RuntimeError:
            self._loop = None
        self._lock = threading.Lock()
        self._closed = False

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
        self._put({"type": "token", "text": chunk})

    def enqueue_error(self, message: str) -> None:
        """Enqueue a best-effort SSE error frame for infrastructure failures."""
        with self._lock:
            if self._closed:
                return
        self._put(
            {
                "type": "error",
                "runId": self.run_id,
                "ts": datetime.now(timezone.utc).isoformat(),
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

    def close(self) -> None:
        """Signal end-of-stream by enqueuing the close sentinel."""
        with self._lock:
            if self._closed:
                return
            self._closed = True
        self._put(None)

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

    def create(self, path: ExecutionPath) -> _Run:
        run_id = uuid.uuid4().hex
        run = _Run(run_id=run_id, path=path, diary=self._diary)
        self._runs[run_id] = run
        return run

    def get(self, run_id: str) -> _Run | None:
        return self._runs.get(run_id)

    def remove(self, run_id: str) -> None:
        """Forget a run after its SSE stream has closed."""
        self._runs.pop(run_id, None)


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
            "updated_at": datetime.now(timezone.utc).replace(tzinfo=None)
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
            except asyncio.TimeoutError:
                message = "SSE stream timed out waiting for gateway events"
                yield {
                    "event": "error",
                    "data": json.dumps(
                        {
                            "type": "error",
                            "runId": run.run_id,
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
        brain: Optional model behavior driving runs; defaults to the
            deterministic stand-in in :mod:`zocai_gateway.run_pipeline`.
        evolution: Optional Layer 5 Evolution_Engine; one is created when
            omitted so verified runs record trajectories (R12).
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
            diary_worker.start()
            diary = diary_worker
        hermes = HermesEvolution(matrix)
        hermes.start()

    # Layer 5: a single Evolution_Engine records verified-run trajectories (R12).
    engine = evolution if evolution is not None else EvolutionEngine()

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        """Stop the background memory workers on shutdown (R9.3/R9.7 cleanup)."""
        try:
            yield
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

    registry = RunRegistry(diary=diary)
    sessions = SessionRegistry()
    app.state.run_registry = registry
    app.state.session_registry = sessions
    app.state.mode_router = router
    setattr(app.state, STATE_SETTINGS_KEY, resolved_settings)
    app.state.diary = diary
    app.state.diary_worker = diary_worker
    app.state.diary_path = diary_path
    app.state.hermes = hermes
    app.state.evolution = engine
    app.state.state_store = state_store

    run_root = str(resolved_root) if resolved_root is not None else "."
    diary_sink = diary.append if diary is not None else None

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

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
        """Create an editor-support session in the process-local store."""
        return sessions.create(req)

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
        run = registry.create(path)
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
                            workspace_root=run_root,
                            state_store=state_store,
                            evolution=engine,
                            diary_sink=diary_sink,
                            brain=brain,
                        ),
                        timeout=resolved_settings.run_timeout_seconds,
                    )
                except asyncio.TimeoutError:
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

            asyncio.create_task(drive_run())
        return RunAccepted(run_id=run.run_id, mode=req.mode)

    @app.post(
        "/v1/agent/decision",
        response_model=DecisionAck,
        response_model_by_alias=True,
        dependencies=[Depends(require_admission)],
    )
    async def agent_decision(req: DecisionRequest) -> DecisionAck:
        """Record an approval or budget-continuation decision for a run."""
        run = registry.get(req.run_id)
        if run is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"unknown run: {req.run_id}",
            )
        run.decisions.append(req)
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
