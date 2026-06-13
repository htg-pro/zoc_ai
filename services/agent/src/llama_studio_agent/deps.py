"""FastAPI dependency helpers."""

from __future__ import annotations

from uuid import UUID

from fastapi import Depends, HTTPException, Request, status
from shared_schema.models import Session

from .agent import AgentOrchestrator
from .state import AppState


def get_state(request: Request) -> AppState:
    state = getattr(request.app.state, "app_state", None)
    if state is None:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "app state missing")
    return state


def get_session(session_id: UUID, state: AppState = Depends(get_state)) -> Session:
    s = state.repo.get_session(session_id)
    if s is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "session not found")
    return s


def make_orchestrator(state: AppState, session: Session) -> AgentOrchestrator:
    provider, model = state.providers.resolve(
        session.provider or state.settings.default_provider,
        session.model or state.settings.default_model,
    )
    indexer = state.indexer_for(session.id, session.workspace_root)
    return AgentOrchestrator(
        provider=provider,
        model=model.model_id,
        registry=state.tools,
        repo=state.repo,
        bus=state.bus,
        indexer=indexer,
        permissions=state.permissions,
        approvals=state.approvals,
        recall_service=state.recall,
    )
