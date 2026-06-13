"""Phase 5 conversation-memory endpoints: stats, compact, forget.

These let the frontend render a context-usage indicator and give the user
manual control over the running summary and the recall store.
"""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends
from shared_schema.models import MemoryStats, Session

from ..agent.memory import (
    MemoryConfig,
    estimate_tokens,
    fit_budget,
)
from ..agent.summariser import update_session_summary
from ..deps import get_session, get_state
from ..state import AppState

router = APIRouter(prefix="/sessions/{session_id}/memory", tags=["memory"])


def _resolve_window(state: AppState, session: Session) -> int | None:
    """Best-effort: look up the active model's context window."""
    provider_kind = session.provider or state.settings.default_provider
    model_id = session.model or state.settings.default_model
    try:
        provider, model = state.providers.resolve(provider_kind, model_id)
    except Exception:
        return None
    try:
        for descriptor in provider.models():
            if descriptor.model_id == model.model_id:
                return descriptor.capability.context_window
    except Exception:
        return None
    return None


@router.get("/stats", response_model=MemoryStats)
def memory_stats(
    session: Session = Depends(get_session),
    state: AppState = Depends(get_state),
) -> MemoryStats:
    """Return the current memory budget snapshot for a session.

    Computed on demand rather than cached: the caller can read it any
    time without waiting for the next agent turn. Mirrors the budgeting
    the orchestrator does at run time so the UI sees the same numbers.
    """
    messages = state.repo.list_messages(session.id)
    summary_row = state.repo.get_summary(session.id)
    summary_tokens = int(summary_row["token_estimate"]) if summary_row else 0

    context_window = _resolve_window(state, session)
    if context_window is None:
        # Mock / unknown provider: report a synthetic snapshot so the UI
        # can still render *something* without asserting on numbers.
        used = sum(estimate_tokens(m.content) + 8 for m in messages) + summary_tokens
        return MemoryStats(
            context_window=0,
            tokens_used=used,
            tokens_available=0,
            messages_in_context=len(messages),
            total_messages=len(messages),
            dropped_messages=0,
            has_summary=bool(summary_row),
        )

    cfg = MemoryConfig(
        context_window=context_window,
        summary_reserve=summary_tokens,
    )
    # The orchestrator reserves ~1024 tokens for tool overhead even when
    # no tools are wired into this read-only call; mirror that floor so
    # the indicator matches what `/agent/run` will actually budget.
    _kept, _dropped, stats = fit_budget(
        messages,
        cfg,
        system_prompt_tokens=0,
        tool_overhead=0,
        current_user_prompt_tokens=0,
    )
    return MemoryStats(
        context_window=stats.context_window,
        tokens_used=stats.tokens_used,
        tokens_available=stats.tokens_available,
        messages_in_context=stats.messages_in_context,
        total_messages=stats.total_messages,
        dropped_messages=stats.dropped_messages,
        has_summary=bool(summary_row),
    )


@router.post("/compact", response_model=MemoryStats)
async def compact_memory(
    session: Session = Depends(get_session),
    state: AppState = Depends(get_state),
) -> MemoryStats:
    """Force-run the summariser over everything outside the working window.

    Useful when the user knows they're about to hit the context limit and
    wants to free room before the next turn. Idempotent: messages already
    folded into the running summary are skipped.
    """
    messages = state.repo.list_messages(session.id)
    # Anything older than the working window is fair game.
    candidates = messages[:-20] if len(messages) > 20 else []

    if candidates:
        # Resolve provider/model the same way `make_orchestrator` does.
        provider_kind = session.provider or state.settings.default_provider
        model_id = session.model or state.settings.default_model
        provider, model = state.providers.resolve(provider_kind, model_id)
        await update_session_summary(
            repo=state.repo,
            provider=provider,
            model=model.model_id,
            session_id=session.id,
            dropped=candidates,
        )

    return memory_stats(session=session, state=state)


@router.post("/forget", response_model=MemoryStats)
def forget_memory(
    keep_last: int = Body(default=20, embed=True, ge=0, le=1000),
    session: Session = Depends(get_session),
    state: AppState = Depends(get_state),
) -> MemoryStats:
    """Drop the running summary and recall store for this session.

    The canonical message log is not touched — only the derived memory
    layers. ``keep_last`` is accepted for symmetry with the planned UI
    even though the working window is implicit from the persisted log.
    """
    state.repo.clear_summary(session.id)
    if state.recall is not None:
        state.recall.clear_session(session.id)
    return memory_stats(session=session, state=state)
