"""Context status endpoint with model recommendations."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from shared_schema.models import ContextStatus, Session

from ..deps import get_session, get_state
from ..state import AppState
from ..v1.memory import memory_stats

router = APIRouter(prefix="/sessions/{session_id}", tags=["context"])


@router.get("/context-status", response_model=ContextStatus)
def context_status(
    session: Session = Depends(get_session),
    state: AppState = Depends(get_state),
) -> ContextStatus:
    """Return extended context status with model recommendations.

    Includes:
    - Current token usage and budget
    - Model being used
    - Recommended model (if context is getting tight)
    - Whether the conversation can continue
    - Whether compaction is available
    """
    # Get base memory stats
    stats = memory_stats(session=session, state=state)
    
    # Calculate usage percentage
    usage_percent = (
        (stats.tokens_used / stats.context_window * 100)
        if stats.context_window > 0
        else 0.0
    )
    
    # Determine if we can continue
    # Can't continue if we're at >95% capacity and no summary exists
    can_continue = usage_percent < 95 or stats.has_summary
    
    # Determine if compaction is available
    # Compaction is available if we have dropped messages that haven't been summarized
    compaction_available = stats.dropped_messages > 0 and not stats.has_summary
    
    # Model recommendation logic
    recommended_model = None
    current_model = session.model or state.settings.default_model
    
    if usage_percent > 80:
        # Try to find a model with larger context window
        provider_kind = session.provider or state.settings.default_provider
        try:
            provider, _ = state.providers.resolve(provider_kind, current_model)
            available_models = provider.models()
            
            # Find models with larger context windows
            current_window = stats.context_window
            larger_models = [
                m for m in available_models
                if m.capability.context_window > current_window
            ]
            
            # Sort by context window size and recommend the smallest that fits
            if larger_models:
                larger_models.sort(key=lambda m: m.capability.context_window)
                recommended_model = larger_models[0].model_id
        except Exception:
            # Provider resolution failed, no recommendation
            pass
    
    return ContextStatus(
        context_window=stats.context_window,
        tokens_used=stats.tokens_used,
        tokens_available=stats.tokens_available,
        messages_in_context=stats.messages_in_context,
        total_messages=stats.total_messages,
        dropped_messages=stats.dropped_messages,
        has_summary=stats.has_summary,
        model=current_model,
        recommended_model=recommended_model,
        can_continue=can_continue,
        compaction_available=compaction_available,
        usage_percent=round(usage_percent, 2),
    )
