"""Inline edit (Cmd-K) route — rewrite a code selection per an instruction."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from shared_schema.models import (
    InlineEditResult,
    ModelCapability,
    ModelDescriptor,
    ProviderKind,
    Session,
)

from ..deps import get_session, get_state
from ..modes.inline_edit import run_inline_edit
from ..providers.base import LLMProvider
from ..providers.openai import OpenAIProvider
from ..state import AppState

router = APIRouter(prefix="/sessions/{session_id}", tags=["modes"])


class InlineEditRequest(BaseModel):
    selection: str
    instruction: str
    language: str | None = None
    prefix: str = ""
    suffix: str = ""
    # Optional model + bring-your-own cloud creds (same shape as the run
    # endpoint). When api_key + base_url + model are all present we route to an
    # ad-hoc OpenAI-compatible provider; otherwise we resolve the session's.
    model: str | None = None
    provider: str | None = None
    api_key: str | None = None
    base_url: str | None = None


def _resolve_provider(
    payload: InlineEditRequest, session: Session, state: AppState
) -> tuple[LLMProvider, str]:
    if payload.api_key and payload.base_url and payload.model:
        provider = OpenAIProvider(
            api_key=payload.api_key,
            base_url=payload.base_url.rstrip("/"),
            catalog=[
                ModelDescriptor(
                    provider=ProviderKind.openai,
                    model_id=payload.model,
                    display_name=payload.model,
                    capability=ModelCapability(context_window=128_000, supports_tools=True),
                )
            ],
        )
        return provider, payload.model
    provider, model = state.providers.resolve(
        session.provider or state.settings.default_provider,
        payload.model or session.model or state.settings.default_model,
    )
    return provider, model.model_id


@router.post("/inline-edit", response_model=InlineEditResult)
async def inline_edit(
    payload: InlineEditRequest,
    session: Session = Depends(get_session),
    state: AppState = Depends(get_state),
) -> InlineEditResult:
    provider, model_id = _resolve_provider(payload, session, state)
    return await run_inline_edit(
        provider,
        model=model_id,
        selection=payload.selection,
        instruction=payload.instruction,
        language=payload.language,
        prefix=payload.prefix,
        suffix=payload.suffix,
    )
