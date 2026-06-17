"""FastAPI application factory."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .config import Settings, get_settings
from .reconcile import reconcile_active_watchers, reconcile_orphaned_approvals
from .state import AppState, build_app_state
from .v1.router import router as v1_router

_log = structlog.get_logger(__name__)


def create_app(settings: Settings | None = None, *, state: AppState | None = None) -> FastAPI:
    cfg = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # A fresh process has no runs in flight, so any tool call still
        # persisted as `needs_approval` was orphaned by a restart while it
        # was waiting for the user's decision. Cancel them cleanly so the UI
        # isn't stuck on a card that can never resolve.
        await reconcile_orphaned_approvals(app.state.app_state)
        # The "watch for changes" preference is persisted per session, but the
        # live watcher is an in-memory task that doesn't survive a restart.
        # Re-arm watchers for any session that had watching enabled so the
        # saved preference takes effect without the user re-saving settings.
        await reconcile_active_watchers(app.state.app_state)
        yield

    app = FastAPI(
        title="Zoc AI Agent",
        version=__version__,
        docs_url="/docs" if cfg.debug else None,
        redoc_url=None,
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=cfg.allowed_origins,
        allow_methods=["*"],
        allow_headers=["*"],
        allow_credentials=False,
    )

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "version": __version__}

    app.state.app_state = state or build_app_state(cfg)
    app.include_router(v1_router, prefix="/v1")

    _log.info("agent.ready", version=__version__, debug=cfg.debug)
    return app
