"""Sessions CRUD + permission grants."""

from __future__ import annotations

import contextlib
from pathlib import Path

from fastapi import APIRouter, Depends, status
from shared_schema.models import (
    CreateSessionRequest,
    PermissionGrant,
    PermissionScope,
    Session,
    SessionStatus,
    ToolGrant,
)

from ..deps import get_session, get_state
from ..state import AppState

router = APIRouter(prefix="/sessions", tags=["sessions"])


@router.get("", response_model=list[Session])
def list_sessions(state: AppState = Depends(get_state)) -> list[Session]:
    return state.repo.list_sessions()


@router.post("", response_model=Session, status_code=status.HTTP_201_CREATED)
def create_session(
    payload: CreateSessionRequest, state: AppState = Depends(get_state)
) -> Session:
    session = Session(
        title=payload.title,
        workspace_root=payload.workspace_root,
        provider=payload.provider,
        model=payload.model,
    )
    created = state.repo.create_session(session)
    state.permissions.grant(
        created.id,
        PermissionScope.read_fs,
        note="Workspace read access for agent context.",
    )
    return created


@router.get("/{session_id}", response_model=Session)
def get_session_endpoint(session: Session = Depends(get_session)) -> Session:
    return session


@router.delete("/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_session_endpoint(
    session: Session = Depends(get_session), state: AppState = Depends(get_state)
) -> None:
    state.repo.delete_session(session.id)
    with state._index_lock:
        state._indexers.pop(session.id, None)
    index_path = Path(state.settings.data_dir) / "indexes" / f"{session.id}.sqlite3"
    with contextlib.suppress(OSError):
        index_path.unlink(missing_ok=True)


@router.post("/{session_id}/close", response_model=Session)
def close_session(
    session: Session = Depends(get_session), state: AppState = Depends(get_state)
) -> Session:
    state.repo.update_status(session.id, SessionStatus.closed)
    return state.repo.get_session(session.id)  # type: ignore[return-value]


@router.get("/{session_id}/permissions", response_model=list[PermissionGrant])
def list_permissions(
    session: Session = Depends(get_session), state: AppState = Depends(get_state)
) -> list[PermissionGrant]:
    return state.repo.get_permissions(session.id)


@router.post("/{session_id}/permissions", response_model=list[PermissionGrant])
def set_permissions(
    grants: list[PermissionGrant],
    session: Session = Depends(get_session),
    state: AppState = Depends(get_state),
) -> list[PermissionGrant]:
    for g in grants:
        state.repo.set_permission(session.id, g)
        if g.granted:
            state.permissions.grant(session.id, g.scope, note=g.note)
        else:
            state.permissions.revoke(session.id, g.scope)
    return state.repo.get_permissions(session.id)


@router.get("/{session_id}/tool-grants", response_model=list[ToolGrant])
def list_tool_grants(
    session: Session = Depends(get_session), state: AppState = Depends(get_state)
) -> list[ToolGrant]:
    return state.repo.get_tool_grants(session.id)


@router.post("/{session_id}/tool-grants", response_model=list[ToolGrant])
def set_tool_grants(
    grants: list[ToolGrant],
    session: Session = Depends(get_session),
    state: AppState = Depends(get_state),
) -> list[ToolGrant]:
    for g in grants:
        if g.granted:
            state.permissions.grant_tool(session.id, g.tool, once=g.once, note=g.note)
        else:
            state.permissions.revoke_tool(session.id, g.tool)
    return state.repo.get_tool_grants(session.id)
