"""Messages: list + append to a session transcript."""

from __future__ import annotations

from fastapi import APIRouter, Depends, status
from shared_schema.models import Message, PostMessageRequest, Session

from ..deps import get_session, get_state
from ..state import AppState

router = APIRouter(prefix="/sessions/{session_id}/messages", tags=["messages"])


@router.get("", response_model=list[Message])
def list_messages(
    session: Session = Depends(get_session), state: AppState = Depends(get_state)
) -> list[Message]:
    return state.repo.list_messages(session.id)


@router.post("", response_model=Message, status_code=status.HTTP_201_CREATED)
def post_message(
    payload: PostMessageRequest,
    session: Session = Depends(get_session),
    state: AppState = Depends(get_state),
) -> Message:
    msg = Message(role=payload.role, content=payload.content)
    return state.repo.add_message(session.id, msg)
