"""Terminal sessions: spawn, list, stop, stream output."""

from __future__ import annotations

import asyncio
import json
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from shared_schema.models import TerminalSession

from ..deps import get_state
from ..state import AppState

router = APIRouter(prefix="/terminal", tags=["terminal"])


class SpawnRequest(BaseModel):
    cmd: str
    args: list[str] = []
    cwd: str | None = None
    cols: int = 120
    rows: int = 32


class InputRequest(BaseModel):
    data: str


class ResizeRequest(BaseModel):
    cols: int
    rows: int


@router.get("", response_model=list[TerminalSession])
def list_terminals(state: AppState = Depends(get_state)) -> list[TerminalSession]:
    return state.terminals.list()


@router.post("", response_model=TerminalSession, status_code=status.HTTP_201_CREATED)
async def spawn_terminal(
    payload: SpawnRequest, state: AppState = Depends(get_state)
) -> TerminalSession:
    return await state.terminals.spawn(
        cmd=payload.cmd,
        args=payload.args,
        cwd=payload.cwd,
        cols=payload.cols,
        rows=payload.rows,
    )


@router.post("/{terminal_id}/input")
async def terminal_input(
    terminal_id: UUID,
    payload: InputRequest,
    state: AppState = Depends(get_state),
) -> dict:
    if not state.terminals.get(terminal_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "terminal not found")
    ok = await state.terminals.write(terminal_id, payload.data)
    return {"ok": ok}


@router.post("/{terminal_id}/resize")
async def terminal_resize(
    terminal_id: UUID,
    payload: ResizeRequest,
    state: AppState = Depends(get_state),
) -> dict:
    if not state.terminals.get(terminal_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "terminal not found")
    ok = state.terminals.resize(terminal_id, payload.cols, payload.rows)
    return {"ok": ok}


@router.post("/{terminal_id}/stop", response_model=TerminalSession)
async def stop_terminal(
    terminal_id: UUID, state: AppState = Depends(get_state)
) -> TerminalSession:
    existing = state.terminals.get(terminal_id)
    if not existing:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "terminal not found")
    await state.terminals.stop(terminal_id)
    return state.terminals.get(terminal_id) or existing


@router.get("/{terminal_id}/stream")
async def stream_terminal(
    terminal_id: UUID, state: AppState = Depends(get_state)
) -> StreamingResponse:
    if not state.terminals.get(terminal_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "terminal not found")

    async def gen():
        try:
            async for ev in state.terminals.subscribe(terminal_id):
                yield f"data: {json.dumps(ev, default=str)}\n\n"
        except asyncio.CancelledError:
            return

    return StreamingResponse(gen(), media_type="text/event-stream")
