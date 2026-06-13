"""Indexer routes."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from shared_schema.models import (
    IndexConfig,
    IndexQueryResult,
    IndexStatus,
    Session,
    UpdateIndexConfigRequest,
)

from ..deps import get_session, get_state
from ..state import AppState

router = APIRouter(prefix="/sessions/{session_id}/index", tags=["index"])


class QueryRequest(BaseModel):
    query: str
    top_k: int = Field(default=8, ge=1, le=64)


def _config_for(state: AppState, session: Session) -> IndexConfig:
    indexer = state.indexer_for(session.id, session.workspace_root)
    return IndexConfig(
        workspace_root=session.workspace_root,
        exclude_globs=indexer.exclude_globs,
        watch=indexer.status().watching or indexer.watch_preference,
    )


@router.get("/status", response_model=IndexStatus)
def status_(
    session: Session = Depends(get_session), state: AppState = Depends(get_state)
) -> IndexStatus:
    return state.indexer_for(session.id, session.workspace_root).status()


@router.post("/reindex", response_model=IndexStatus)
async def reindex(
    session: Session = Depends(get_session), state: AppState = Depends(get_state)
) -> IndexStatus:
    indexer = state.indexer_for(session.id, session.workspace_root)
    return await indexer.reindex()


@router.post("/query", response_model=list[IndexQueryResult])
async def query(
    payload: QueryRequest,
    session: Session = Depends(get_session),
    state: AppState = Depends(get_state),
) -> list[IndexQueryResult]:
    indexer = state.indexer_for(session.id, session.workspace_root)
    return await indexer.query(payload.query, top_k=payload.top_k)


@router.post("/watch", response_model=IndexStatus)
async def start_watch(
    session: Session = Depends(get_session), state: AppState = Depends(get_state)
) -> IndexStatus:
    indexer = state.indexer_for(session.id, session.workspace_root)
    await indexer.start_watcher()
    return indexer.status()


@router.delete("/watch", response_model=IndexStatus)
async def stop_watch(
    session: Session = Depends(get_session), state: AppState = Depends(get_state)
) -> IndexStatus:
    indexer = state.indexer_for(session.id, session.workspace_root)
    await indexer.stop_watcher()
    return indexer.status()


@router.get("/config", response_model=IndexConfig)
def get_config(
    session: Session = Depends(get_session), state: AppState = Depends(get_state)
) -> IndexConfig:
    return _config_for(state, session)


@router.put("/config", response_model=IndexConfig)
async def update_config(
    payload: UpdateIndexConfigRequest,
    session: Session = Depends(get_session),
    state: AppState = Depends(get_state),
) -> IndexConfig:
    """Persist the workspace root / exclusions / watch toggle and apply them.

    Changing the root or the exclusions re-scopes the index and triggers a
    fresh reindex; the watch toggle starts/stops the existing file watcher.
    """

    new_root = (payload.workspace_root or session.workspace_root).strip() or session.workspace_root
    root_changed = str(Path(new_root).resolve()) != str(Path(session.workspace_root).resolve())

    if root_changed:
        resolved = Path(new_root).expanduser()
        if not resolved.exists():
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                f"Workspace root does not exist: {new_root}",
            )
        if not resolved.is_dir():
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                f"Workspace root is not a directory: {new_root}",
            )

    indexer = state.indexer_for(session.id, session.workspace_root)
    needs_reindex = False

    if root_changed:
        # Tear down the watcher bound to the old root before re-scoping.
        await indexer.stop_watcher()
        state.repo.update_workspace_root(session.id, new_root)
        indexer = state.indexer_for(session.id, new_root)
        needs_reindex = True

    if payload.exclude_globs is not None:
        indexer.set_exclude_globs(payload.exclude_globs)
        needs_reindex = True

    if needs_reindex:
        await indexer.reindex()

    if payload.watch is not None:
        if payload.watch:
            await indexer.start_watcher()
        else:
            await indexer.stop_watcher()

    return IndexConfig(
        workspace_root=new_root,
        exclude_globs=indexer.exclude_globs,
        watch=indexer.status().watching or indexer.watch_preference,
    )
