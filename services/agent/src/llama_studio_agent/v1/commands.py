"""Slash commands: list + invoke."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from shared_schema.models import (
    RunSlashCommandRequest,
    Session,
    SlashCommandDescriptor,
)

from ..deps import get_session, get_state, make_orchestrator
from ..state import AppState

router = APIRouter(prefix="/commands", tags=["commands"])


@router.get("", response_model=list[SlashCommandDescriptor])
def list_commands(state: AppState = Depends(get_state)) -> list[SlashCommandDescriptor]:
    return state.commands.list()


@router.post("/{session_id}/run")
async def run_command(
    payload: RunSlashCommandRequest,
    session: Session = Depends(get_session),
    state: AppState = Depends(get_state),
) -> dict:
    orch = make_orchestrator(state, session)
    result = await state.commands.run(
        name=payload.name,
        args=payload.args,
        orchestrator=orch,
        session_id=session.id,
        workspace_root=session.workspace_root,
    )
    return {
        "final_text": result.final_text,
        "iterations": result.iterations,
        "repaired": result.repaired,
        "tool_calls": [tc.model_dump(mode="json") for tc in result.tool_calls],
    }
