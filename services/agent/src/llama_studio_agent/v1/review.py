"""Code review + test generation modes."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from shared_schema.models import CodeReviewReport, Session, TestGenerationResult

from ..deps import get_session, get_state, make_orchestrator
from ..modes.code_review import run_code_review
from ..modes.test_gen import run_test_generation, run_test_only
from ..state import AppState

router = APIRouter(prefix="/sessions/{session_id}", tags=["modes"])


class ReviewRequest(BaseModel):
    diff: str | None = None
    excerpts: list[tuple[str, str]] | None = None


class TestGenRequest(BaseModel):
    target: str
    max_attempts: int = 2


class TestRunRequest(BaseModel):
    test_file: str
    target: str = ""


@router.post("/review", response_model=CodeReviewReport)
async def code_review(
    payload: ReviewRequest,
    session: Session = Depends(get_session),
    state: AppState = Depends(get_state),
) -> CodeReviewReport:
    provider, model = state.providers.resolve(
        session.provider or state.settings.default_provider,
        session.model or state.settings.default_model,
    )
    return await run_code_review(
        provider, model=model.model_id, diff=payload.diff, excerpts=payload.excerpts
    )


@router.post("/testgen", response_model=TestGenerationResult)
async def test_gen(
    payload: TestGenRequest,
    session: Session = Depends(get_session),
    state: AppState = Depends(get_state),
) -> TestGenerationResult:
    orch = make_orchestrator(state, session)
    provider, model = state.providers.resolve(
        session.provider or state.settings.default_provider,
        session.model or state.settings.default_model,
    )
    return await run_test_generation(
        provider=provider,
        model=model.model_id,
        orchestrator=orch,
        session_id=session.id,
        workspace_root=session.workspace_root,
        target=payload.target,
        max_attempts=payload.max_attempts,
    )


@router.post("/testrun", response_model=TestGenerationResult)
async def test_run(
    payload: TestRunRequest,
    session: Session = Depends(get_session),
    state: AppState = Depends(get_state),
) -> TestGenerationResult:
    return await run_test_only(
        workspace_root=session.workspace_root,
        test_file=payload.test_file,
        target=payload.target,
    )
