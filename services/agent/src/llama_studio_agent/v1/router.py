"""Top-level `/v1` router, composed from sub-routers."""

from __future__ import annotations

from fastapi import APIRouter

from .agent_run import router as agent_router
from .commands import router as commands_router
from .indexer import router as indexer_router
from .memory import router as memory_router
from .messages import router as messages_router
from .providers import router as providers_router
from .replit_workflow import router as replit_workflow_router
from .review import router as review_router
from .sessions import router as sessions_router
from .settings import router as settings_router
from .terminal import router as terminal_router
from .tools import router as tools_router

router = APIRouter(tags=["v1"])


@router.get("/ping")
def ping() -> dict[str, str]:
    return {"pong": "v1"}


router.include_router(sessions_router)
router.include_router(messages_router)
router.include_router(agent_router)
router.include_router(commands_router)
router.include_router(tools_router)
router.include_router(providers_router)
router.include_router(indexer_router)
router.include_router(terminal_router)
router.include_router(review_router)
router.include_router(replit_workflow_router)
router.include_router(settings_router)
router.include_router(memory_router)
