"""Tool catalogue + direct invoke (debug)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from shared_schema.models import Session, ToolDescriptor, ToolResult

from ..deps import get_session, get_state
from ..state import AppState
from ..tools.base import ToolContext

router = APIRouter(prefix="/tools", tags=["tools"])


class InvokeRequest(BaseModel):
    arguments: dict[str, Any] = {}


@router.get("", response_model=list[ToolDescriptor])
def list_tools(state: AppState = Depends(get_state)) -> list[ToolDescriptor]:
    return state.tools.descriptors()


@router.post("/{session_id}/{tool_name}/invoke", response_model=ToolResult)
async def invoke_tool(
    tool_name: str,
    payload: InvokeRequest,
    session: Session = Depends(get_session),
    state: AppState = Depends(get_state),
) -> ToolResult:
    try:
        tool = state.tools.get(tool_name)
    except KeyError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    ctx = ToolContext(
        session_id=session.id,
        workspace_root=session.workspace_root,
        permissions=state.permissions,
        indexer=state.indexer_for(session.id, session.workspace_root),
    )
    return await tool.execute(ctx, payload.arguments)
