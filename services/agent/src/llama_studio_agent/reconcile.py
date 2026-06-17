"""Recover suspended tool-call approvals after an agent restart.

The interactive approval pause holds a suspended tool call in an in-memory
:class:`~llama_studio_agent.approvals.ApprovalGate`. If the agent sidecar
restarts while a call is waiting for the user's decision, the in-flight run
and the gate's futures are gone, but the tool call is still persisted as
``needs_approval`` — leaving the UI stuck on a card that can never resolve.

On startup the process has no live runs and a fresh, empty gate, so any
persisted ``needs_approval`` call is definitively orphaned. We mark each one
``cancelled`` with a clear message and emit a :class:`ToolCallEvent` so any
(re)connecting client replays the resolution instead of waiting forever.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING
from uuid import UUID

import structlog
from shared_schema.models import ToolCall, ToolCallEvent, ToolCallStatus

if TYPE_CHECKING:
    from .events import EventBus
    from .persistence import SessionRepository
    from .state import AppState

_log = structlog.get_logger(__name__)

ORPHANED_APPROVAL_MESSAGE = (
    "approval lost: the agent restarted while this tool call was waiting for"
    " your decision. Re-run the request to try again."
)


async def _emit(
    repo: SessionRepository, bus: EventBus, session_id: UUID, event: ToolCallEvent
) -> None:
    """Persist and publish an event with a fresh per-session seq.

    Mirrors ``AgentOrchestrator._emit`` so reconciliation events flow through
    the same log + SSE path the orchestrator uses.
    """

    seq = bus.next_seq(session_id)
    data = event.model_dump()
    data["seq"] = seq
    rebuilt = event.__class__.model_validate(data)
    repo.append_event(session_id, seq, rebuilt.type, data)
    await bus.publish(rebuilt)


async def cancel_orphaned_approval(
    repo: SessionRepository, bus: EventBus, session_id: UUID, call: ToolCall
) -> None:
    """Mark a single orphaned ``needs_approval`` call as cancelled and emit it."""

    call.status = ToolCallStatus.cancelled
    call.error = ORPHANED_APPROVAL_MESSAGE
    call.finished_at = datetime.now(UTC)
    repo.upsert_tool_call(session_id, call)
    await _emit(
        repo,
        bus,
        session_id,
        ToolCallEvent(session_id=session_id, seq=0, tool_call=call),
    )


async def reconcile_orphaned_approvals(state: AppState) -> int:
    """Cancel every persisted approval that has no live waiter.

    Returns the number of calls reconciled. Safe to call on startup: with no
    runs in flight, anything still ``needs_approval`` is orphaned. A call that
    *does* have a live waiter in the gate (should not happen at startup) is
    left alone so an active run can still resolve it.
    """

    reconciled = 0
    for session_id, call in state.repo.list_tool_calls_by_status(
        ToolCallStatus.needs_approval
    ):
        if call.id in state.approvals.pending(session_id):
            continue
        await cancel_orphaned_approval(state.repo, state.bus, session_id, call)
        reconciled += 1
    if reconciled:
        _log.info("agent.reconciled_orphaned_approvals", count=reconciled)
    return reconciled


async def reconcile_active_watchers(state: AppState) -> int:
    """Re-arm file watchers for every session that had watching enabled.

    The "watch for changes" preference is persisted in each session's index
    store meta (``watch_enabled``), but the live watcher is an in-memory
    asyncio task that dies when the agent process restarts. On startup we walk
    every session, rebuild its indexer, and start the watcher again for any
    whose persisted preference is on — so the saved choice truly takes effect
    without the user re-saving Indexer settings.

    Sessions whose ``workspace_root`` no longer exists (e.g. the folder was
    deleted) are skipped, and their persisted ``watch_enabled`` preference is
    cleared so we don't keep re-arming a watcher against a missing directory on
    every restart.

    Returns the number of watchers started. Errors are logged and swallowed
    per session so one bad workspace can't block the rest of startup.
    """

    started = 0
    for session in state.repo.list_sessions():
        try:
            indexer = state.indexer_for(session.id, session.workspace_root)
            if not indexer.watch_preference:
                continue
            if not Path(indexer.workspace_root).is_dir():
                # The workspace is gone. Clear the saved preference so future
                # restarts don't keep trying to watch a directory that no
                # longer exists, and skip starting a watcher for it.
                await indexer.stop_watcher()
                _log.info(
                    "agent.skip_watcher_missing_workspace",
                    session_id=str(session.id),
                    workspace_root=indexer.workspace_root,
                )
                continue
            await indexer.start_watcher()
            started += 1
        except Exception:
            _log.exception("agent.resume_watcher_failed", session_id=str(session.id))
    if started:
        _log.info("agent.resumed_watchers", count=started)
    return started
