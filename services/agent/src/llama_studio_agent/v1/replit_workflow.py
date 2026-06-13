"""Replit-style plan/task workflow routes."""


from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from shared_schema.models import (
    CreateReplitPlanRequest,
    CreateReplitTaskRequest,
    ReplitCheckpoint,
    ReplitPlan,
    ReplitTask,
    ReplitTaskLog,
    ReviseReplitPlanRequest,
    TaskCreatedEvent,
)

from ..agent.replit_workflow import ReplitWorkflowService
from ..deps import get_session, get_state
from ..state import AppState

router = APIRouter(prefix="/sessions/{session_id}/replit", tags=["replit-workflow"])


def service(state: AppState) -> ReplitWorkflowService:
    existing = getattr(state, "replit_workflow", None)
    if isinstance(existing, ReplitWorkflowService):
        return existing
    created = ReplitWorkflowService(state)
    state.replit_workflow = created
    return created


def conflict(exc: ValueError) -> HTTPException:
    return HTTPException(status_code=409, detail=str(exc))


async def emit_task_created(state: AppState, session_id: UUID, task: ReplitTask) -> None:
    seq = state.bus.next_seq(session_id)
    event = TaskCreatedEvent(session_id=session_id, seq=seq, task=task)
    state.repo.append_event(session_id, seq, event.type, event.model_dump(mode="json"))
    await state.bus.publish(event)


@router.post("/plans")
async def create_plan(
    payload: CreateReplitPlanRequest,
    session=Depends(get_session),
    state: AppState = Depends(get_state),
) -> ReplitPlan:
    plan = service(state).create_plan(session_id=session.id, prompt=payload.prompt)
    for task in plan.tasks:
        await emit_task_created(state, session.id, task)
    return plan


@router.get("/plans")
def list_plans(
    session=Depends(get_session),
    state: AppState = Depends(get_state),
) -> list[ReplitPlan]:
    return state.repo.list_replit_plans(session.id)


@router.post("/plans/{plan_id}/revise")
async def revise_plan(
    plan_id: UUID,
    payload: ReviseReplitPlanRequest,
    session=Depends(get_session),
    state: AppState = Depends(get_state),
) -> ReplitPlan:
    try:
        plan = service(state).revise_plan(session_id=session.id, plan_id=plan_id, prompt=payload.prompt)
        for task in plan.tasks:
            await emit_task_created(state, session.id, task)
        return plan
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise conflict(exc) from exc


@router.post("/plans/{plan_id}/approve")
def approve_plan(
    plan_id: UUID,
    session=Depends(get_session),
    state: AppState = Depends(get_state),
) -> ReplitPlan:
    try:
        return service(state).approve_plan(session_id=session.id, plan_id=plan_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise conflict(exc) from exc


@router.get("/tasks")
def list_tasks(
    session=Depends(get_session),
    state: AppState = Depends(get_state),
) -> list[ReplitTask]:
    return state.repo.list_replit_tasks(session.id)


@router.post("/tasks")
async def create_task(
    payload: CreateReplitTaskRequest,
    session=Depends(get_session),
    state: AppState = Depends(get_state),
) -> ReplitTask:
    task = ReplitTask(
        session_id=session.id,
        title=payload.title,
        summary=payload.summary,
        priority=payload.priority,
        files_likely_changed=payload.files_likely_changed,
        done_looks_like=payload.done_looks_like,
        test_plan=payload.test_plan,
    )
    created = service(state).create_task(session_id=session.id, task=task)
    await emit_task_created(state, session.id, created)
    return created


@router.get("/tasks/{task_id}")
def get_task(
    task_id: UUID,
    session=Depends(get_session),
    state: AppState = Depends(get_state),
) -> ReplitTask:
    task = state.repo.get_replit_task(session.id, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    return task


@router.post("/tasks/{task_id}/queue")
def queue_task(
    task_id: UUID,
    session=Depends(get_session),
    state: AppState = Depends(get_state),
) -> ReplitTask:
    try:
        return service(state).queue_task(session_id=session.id, task_id=task_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise conflict(exc) from exc


@router.post("/tasks/{task_id}/start")
async def start_task(
    task_id: UUID,
    session=Depends(get_session),
    state: AppState = Depends(get_state),
) -> ReplitTask:
    try:
        return await service(state).start_task(session_id=session.id, task_id=task_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise conflict(exc) from exc


@router.post("/tasks/{task_id}/ready")
def ready_task(
    task_id: UUID,
    session=Depends(get_session),
    state: AppState = Depends(get_state),
) -> ReplitTask:
    try:
        return service(state).mark_ready(session_id=session.id, task_id=task_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise conflict(exc) from exc


@router.post("/tasks/{task_id}/apply")
def apply_task(
    task_id: UUID,
    session=Depends(get_session),
    state: AppState = Depends(get_state),
) -> ReplitTask:
    try:
        return service(state).apply_task(session_id=session.id, task_id=task_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise conflict(exc) from exc


@router.post("/tasks/{task_id}/dismiss")
def dismiss_task(
    task_id: UUID,
    session=Depends(get_session),
    state: AppState = Depends(get_state),
) -> ReplitTask:
    try:
        return service(state).dismiss_task(session_id=session.id, task_id=task_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise conflict(exc) from exc


@router.post("/tasks/{task_id}/cancel")
def cancel_task(
    task_id: UUID,
    session=Depends(get_session),
    state: AppState = Depends(get_state),
) -> ReplitTask:
    try:
        return service(state).cancel_task(session_id=session.id, task_id=task_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise conflict(exc) from exc


@router.get("/tasks/{task_id}/logs")
def task_logs(
    task_id: UUID,
    session=Depends(get_session),
    state: AppState = Depends(get_state),
) -> list[ReplitTaskLog]:
    if state.repo.get_replit_task(session.id, task_id) is None:
        raise HTTPException(status_code=404, detail="task not found")
    return state.repo.list_replit_task_logs(task_id)


@router.get("/tasks/{task_id}/diff")
def task_diff(
    task_id: UUID,
    session=Depends(get_session),
    state: AppState = Depends(get_state),
) -> dict[str, str]:
    task = state.repo.get_replit_task(session.id, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    return {"diff": task.diff or ""}


@router.get("/tasks/{task_id}/test-results")
def task_test_results(
    task_id: UUID,
    session=Depends(get_session),
    state: AppState = Depends(get_state),
) -> dict[str, str]:
    task = state.repo.get_replit_task(session.id, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    return {"output": task.test_output or ""}


@router.get("/checkpoints")
def checkpoints(
    session=Depends(get_session),
    state: AppState = Depends(get_state),
) -> list[ReplitCheckpoint]:
    return state.repo.list_replit_checkpoints(session.id)


@router.post("/checkpoints/{checkpoint_id}/rollback")
def rollback_checkpoint(
    checkpoint_id: UUID,
    session=Depends(get_session),
    state: AppState = Depends(get_state),
) -> ReplitCheckpoint:
    try:
        return service(state).rollback_checkpoint(session_id=session.id, checkpoint_id=checkpoint_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
