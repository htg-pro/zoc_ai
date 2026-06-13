"""Agent run + SSE event stream."""

from __future__ import annotations

import asyncio
import contextlib
import json
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from shared_schema.models import (
    MessageRole,
    ModelCapability,
    ModelDescriptor,
    PermissionScope,
    ProviderKind,
    RunAgentRequest,
    Session,
    ToolCallStatus,
)

from ..agent.orchestrator import AgentOrchestrator, OrchestratorConfig
from ..deps import get_session, get_state, make_orchestrator
from ..providers.base import ProviderError
from ..providers.openai import OpenAIProvider
from ..reconcile import ORPHANED_APPROVAL_MESSAGE, cancel_orphaned_approval
from ..state import AppState

router = APIRouter(prefix="/sessions/{session_id}/agent", tags=["agent"])


class ApprovalDecision(BaseModel):
    """Frontend's decision for a suspended (needs_approval) tool call."""

    allowed: bool


# Hard ceiling on a single /agent/run request. The orchestrator caps its
# own iteration count, but a single LLM call could still hang indefinitely
# (network blackhole, provider stall). 10 minutes is generous for a
# multi-tool task with a slow local model and bounded enough that a real
# hang surfaces as a 504 instead of a request that lives forever.
AGENT_RUN_TIMEOUT_S = 600.0

# Ask mode is read-only Q&A: the agent may inspect the workspace but never
# write files or run commands. Restricting the tool set (rather than relying
# on permission prompts) makes the contract explicit and keeps Ask cheap and
# side-effect-free — no checkpoint, no diff, no review step.
ASK_MODE_TOOLS: tuple[str, ...] = (
    "read_file",
    "list_dir",
    "search",
    "grep_search",
    "glob_files",
    "get_project_summary",
    "get_open_workspace",
    "get_active_file",
    "get_git_status",
    "get_git_diff",
    "ast_query",
    "index_query",
)


def _byo_orchestrator(
    state: AppState, session: Session, *, model: str, base_url: str, api_key: str
) -> AgentOrchestrator:
    """Build an orchestrator backed by an ad-hoc OpenAI-compatible provider
    for a bring-your-own cloud model (OpenAI / Google AI Studio / Groq / xAI /
    custom). The key/base URL come from the request and are never persisted to
    the sidecar env."""

    provider = OpenAIProvider(
        api_key=api_key,
        base_url=base_url.rstrip("/"),
        catalog=[
            ModelDescriptor(
                provider=ProviderKind.openai,
                model_id=model,
                display_name=model,
                capability=ModelCapability(context_window=128_000, supports_tools=True),
            )
        ],
    )
    indexer = state.indexer_for(session.id, session.workspace_root)
    return AgentOrchestrator(
        provider=provider,
        model=model,
        registry=state.tools,
        repo=state.repo,
        bus=state.bus,
        indexer=indexer,
        permissions=state.permissions,
        approvals=state.approvals,
        recall_service=state.recall,
    )


@router.post("/run")
async def run_agent(
    payload: RunAgentRequest,
    session: Session = Depends(get_session),
    state: AppState = Depends(get_state),
) -> dict:
    if payload.session_id is not None and payload.session_id != session.id:
        raise HTTPException(status_code=400, detail="sessionId does not match the route session.")
    prompt = (payload.message or payload.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="message is required.")

    workspace_root = (payload.workspace_path or session.workspace_root or "").strip()
    if not workspace_root:
        raise HTTPException(status_code=400, detail="No workspace selected.")
    workspace_path = Path(workspace_root).expanduser().resolve()
    if not workspace_path.exists() or not workspace_path.is_dir():
        raise HTTPException(status_code=400, detail=f"No workspace selected: {workspace_root}")

    effective_session = session
    if str(workspace_path) != session.workspace_root:
        state.repo.update_workspace_root(session.id, str(workspace_path))
        effective_session = session.model_copy(update={"workspace_root": str(workspace_path)})
    if payload.model:
        effective_session = effective_session.model_copy(update={"model": payload.model})

    # Bring-your-own cloud provider: route directly to the supplied
    # OpenAI-compatible endpoint with the request's key, bypassing the
    # registry (whose keys are env-only).
    byo = bool(payload.api_key and payload.base_url and payload.model)

    if not byo:
        try:
            provider, _model = state.providers.resolve(
                effective_session.provider or state.settings.default_provider,
                effective_session.model or state.settings.default_model,
            )
        except ProviderError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if getattr(provider, "kind", "") == "llamacpp":
            health = getattr(provider, "health", None)
            if callable(health) and not await health():
                raise HTTPException(
                    status_code=503,
                    detail=(
                        "llama-server is not running. Start llama.cpp from Settings -> Models "
                        "or load a local .gguf model before sending."
                    ),
                )

    # Reading the currently selected workspace is expected agent behavior.
    # Mutating files or running commands still goes through the approval flow.
    state.permissions.grant(
        effective_session.id,
        PermissionScope.read_fs,
        note="Workspace read access for agent context.",
    )

    workspace_context = {
        "workspace_path": str(workspace_path),
        "active_file": payload.active_file,
        "open_files": [f.model_dump(mode="json") for f in payload.open_files],
        "selected_text": payload.selected_text,
        "editor_content": payload.editor_content,
        "mode": payload.mode,
        "model": payload.model,
    }

    orch = (
        _byo_orchestrator(
            state,
            effective_session,
            model=payload.model,  # type: ignore[arg-type]
            base_url=payload.base_url,  # type: ignore[arg-type]
            api_key=payload.api_key,  # type: ignore[arg-type]
        )
        if byo
        else make_orchestrator(state, effective_session)
    )
    # Mark this session as having a live run for its whole duration. If the
    # client disconnects mid-flight, this request coroutine is cancelled and
    # the registry drops the liveness in its `finally`, letting the resolve
    # path treat any still-suspended approval as orphaned.
    with state.runs.track(session.id):
        try:
            result = await asyncio.wait_for(
                orch.run(
                    session_id=effective_session.id,
                    workspace_root=str(workspace_path),
                    prompt=prompt,
                    workspace_context=workspace_context,
                    config=OrchestratorConfig(
                        max_iterations=payload.max_iterations,
                        max_repair_attempts=payload.max_repair_attempts,
                        allowed_tools=ASK_MODE_TOOLS if payload.mode == "ask" else None,
                    ),
                ),
                timeout=AGENT_RUN_TIMEOUT_S,
            )
        except TimeoutError as exc:
            raise HTTPException(
                status_code=504,
                detail=(
                    f"agent run exceeded the {int(AGENT_RUN_TIMEOUT_S)}s ceiling — "
                    "the underlying provider may be stalled."
                ),
            ) from exc
    return {
        "final_text": result.final_text,
        "iterations": result.iterations,
        "repaired": result.repaired,
        "plan": result.plan.model_dump(mode="json") if result.plan else None,
        "tool_calls": [tc.model_dump(mode="json") for tc in result.tool_calls],
        "memory_stats": (
            {
                "context_window": result.memory_stats.context_window,
                "tokens_used": result.memory_stats.tokens_used,
                "tokens_available": result.memory_stats.tokens_available,
                "messages_in_context": result.memory_stats.messages_in_context,
                "total_messages": result.memory_stats.total_messages,
                "dropped_messages": result.memory_stats.dropped_messages,
            }
            if result.memory_stats is not None
            else None
        ),
    }


@router.get("/events")
async def stream_events(
    session: Session = Depends(get_session),
    state: AppState = Depends(get_state),
    since_seq: int = Query(default=0, ge=0),
    request: Request = None,
) -> StreamingResponse:
    """SSE stream of agent events. Replays any persisted events with
    `seq > since_seq` before subscribing to live updates.

    Supports SSE reconnection via the `Last-Event-ID` header: if present,
    it overrides the `since_seq` query parameter so the client can resume
    from where it left off after a network disconnect.

    Sends a heartbeat comment every 25 s during idle periods so proxies
    and the browser don't reap the connection while a long-running tool
    call (or an idle agent) keeps the channel quiet.
    """

    # Prefer Last-Event-ID header over query param (standard SSE reconnect pattern)
    if request:
        last_event_id = request.headers.get("Last-Event-ID")
        if last_event_id:
            # Ignore a malformed header and fall back to the query param.
            with contextlib.suppress(ValueError):
                since_seq = int(last_event_id)

    HEARTBEAT_INTERVAL = 25.0

    async def gen():
        # Replay history first, emitting id: field for each event
        for ev in state.repo.list_events(session.id, since_seq=since_seq):
            yield f"id: {ev['seq']}\nevent: {ev['type']}\ndata: {json.dumps(ev['payload'], default=str)}\n\n"
        # Subscribe to live events. We race the bus iterator against a
        # short asyncio.sleep so we can emit a comment-only heartbeat
        # whenever the bus stays silent for HEARTBEAT_INTERVAL seconds.
        try:
            iterator = state.bus.iter_events(session.id, timeout=60.0).__aiter__()
            while True:
                next_task = asyncio.create_task(iterator.__anext__())
                heartbeat_task = asyncio.create_task(asyncio.sleep(HEARTBEAT_INTERVAL))
                done, _pending = await asyncio.wait(
                    {next_task, heartbeat_task},
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if next_task in done:
                    heartbeat_task.cancel()
                    try:
                        event = next_task.result()
                    except StopAsyncIteration:
                        return
                    payload = event.model_dump(mode="json")
                    # Emit id: field for reconnection support
                    yield f"id: {event.seq}\nevent: {event.type}\ndata: {json.dumps(payload, default=str)}\n\n"
                else:
                    next_task.cancel()
                    yield ": keepalive\n\n"
        except asyncio.CancelledError:
            return

    return StreamingResponse(gen(), media_type="text/event-stream")


@router.post("/approvals/{call_id}")
async def resolve_approval(
    call_id: UUID,
    payload: ApprovalDecision,
    session: Session = Depends(get_session),
    state: AppState = Depends(get_state),
) -> dict:
    """Resume a suspended tool call with the user's approval decision.

    The grant itself (allow once / allow this tool / allow scope) is written
    via the `/permissions` and `/tool-grants` endpoints; this endpoint wakes
    the orchestrator so it can re-check and proceed (or abort on denial).
    """

    # Only a call still persisted as `needs_approval` can legitimately be
    # resolved. Pre-checking the persisted status avoids buffering a decision
    # (and leaving stale gate state) for a call whose run is already gone —
    # e.g. one cancelled by approval reconciliation after an agent restart —
    # or for an id that never existed.
    call = state.repo.get_tool_call(session.id, call_id)
    if call is None:
        return {"resolved": False, "recovered": False, "reason": "unknown_call"}
    if call.status != ToolCallStatus.needs_approval:
        return {"resolved": False, "recovered": False, "reason": "run_lost"}

    # A live waiter in the gate is the unambiguous case: wake it directly.
    if call_id in state.approvals.pending(session.id):
        state.approvals.resolve(session.id, call_id, payload.allowed)
        return {"resolved": True, "recovered": True, "reason": "resolved"}

    # No live waiter. If a run is still active for this session, the waiter
    # just hasn't registered yet (a fast frontend resolving before the
    # orchestrator reached the gate) — buffer the decision for it to pick up.
    if state.runs.is_active(session.id):
        state.approvals.resolve(session.id, call_id, payload.allowed)
        return {"resolved": False, "recovered": True, "reason": "buffered"}

    # No live waiter and no active run: the run was cancelled mid-flight
    # (e.g. the client disconnected) without a restart, orphaning this call.
    # Startup reconciliation won't catch it until the next restart, so do it
    # now — mark it cancelled cleanly so the UI isn't stuck forever.
    await cancel_orphaned_approval(state.repo, state.bus, session.id, call)
    return {"resolved": False, "recovered": False, "reason": "run_lost"}


def _last_user_prompt(state: AppState, session_id: UUID) -> str | None:
    """The most recent user prompt in the session transcript, if any."""

    for msg in reversed(state.repo.list_messages(session_id)):
        if msg.role == MessageRole.user and msg.content.strip():
            return msg.content
    return None


@router.post("/approvals/{call_id}/retry")
async def retry_approval(
    call_id: UUID,
    session: Session = Depends(get_session),
    state: AppState = Depends(get_state),
) -> dict:
    """Re-run a tool call that was cancelled when the agent restarted.

    Task #40 cancels any approval left waiting when the sidecar restarts,
    marking it ``cancelled`` with :data:`ORPHANED_APPROVAL_MESSAGE`. This
    endpoint lets the user resume that work with one click instead of
    retyping: it re-issues the originating prompt so the agent re-plans and
    re-attempts the tool. Any grant the user has since made is picked up
    because permissions are re-checked from scratch on the new run.

    The prompt is *not* re-recorded in the transcript (``record_prompt=False``)
    so retrying doesn't duplicate the user's message. Events flow on the same
    per-session bus as ``/run``, so a subscribed client sees the new run live.
    """

    call = state.repo.get_tool_call(session.id, call_id)
    if call is None:
        return {"retried": False, "reason": "unknown_call"}
    # Only a call cancelled by restart reconciliation is retryable here. Any
    # other terminal status (a normal denial, a genuine failure, success) is
    # not something this affordance should silently re-run.
    if (
        call.status != ToolCallStatus.cancelled
        or call.error != ORPHANED_APPROVAL_MESSAGE
    ):
        return {"retried": False, "reason": "not_retryable"}

    prompt = _last_user_prompt(state, session.id)
    if prompt is None:
        return {"retried": False, "reason": "no_prompt"}

    orch = make_orchestrator(state, session)
    with state.runs.track(session.id):
        result = await orch.run(
            session_id=session.id,
            workspace_root=session.workspace_root,
            prompt=prompt,
            record_prompt=False,
        )
    return {
        "retried": True,
        "reason": "rerun",
        "final_text": result.final_text,
        "iterations": result.iterations,
        "repaired": result.repaired,
        "plan": result.plan.model_dump(mode="json") if result.plan else None,
        "tool_calls": [tc.model_dump(mode="json") for tc in result.tool_calls],
    }
