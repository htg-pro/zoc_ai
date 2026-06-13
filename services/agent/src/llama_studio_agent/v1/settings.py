"""Runtime-mutable settings API.

Right now this only exposes the embedding selection used by the workspace
indexer, but the route is named generically so future runtime-mutable
settings (theme defaults, default model, etc.) can live alongside.

PATCH semantics
---------------
* Only fields in `config.RUNTIME_MUTABLE_FIELDS` are accepted; the rest
  remain env-only.
* On any change to the embedding configuration we:
    1. Persist the new overrides to `<data_dir>/settings.json` so they
       survive process restart.
    2. Drop the per-session indexer cache. Next access rebuilds the
       `IndexerService` with `resolve_embedder()`, and `IndexerService`
       already wipes the vector store when the embedding signature
       changes — so the next query / reindex sees a clean slate.
    3. Schedule a background reindex for every active session so the user
       doesn't have to manually click "Reindex" after switching models.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Coroutine
from typing import Any

from fastapi import APIRouter, Depends
from shared_schema.models import (
    EmbeddingProvider,
    EmbeddingSettings,
    SettingsSnapshot,
    UpdateSettingsRequest,
)

from ..config import RUNTIME_MUTABLE_FIELDS, save_runtime_overrides
from ..deps import get_state
from ..state import AppState

router = APIRouter(prefix="/settings", tags=["settings"])
_log = logging.getLogger(__name__)

# Retain references to fire-and-forget reindex tasks so the event loop does not
# garbage-collect them mid-run (RUF006).
_BACKGROUND_TASKS: set[asyncio.Task[None]] = set()


def _spawn_background(coro: Coroutine[Any, Any, None]) -> None:
    task: asyncio.Task[None] = asyncio.create_task(coro)
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)


def _snapshot(state: AppState) -> SettingsSnapshot:
    raw = (state.settings.embedding_provider or "").strip().lower() or "auto"
    try:
        provider = EmbeddingProvider(raw)
    except ValueError:
        provider = EmbeddingProvider.auto
    return SettingsSnapshot(
        embedding=EmbeddingSettings(
            provider=provider,
            model=state.settings.embedding_model,
        )
    )


@router.get("", response_model=SettingsSnapshot)
def get_settings_(state: AppState = Depends(get_state)) -> SettingsSnapshot:
    return _snapshot(state)


@router.patch("", response_model=SettingsSnapshot)
async def update_settings(
    payload: UpdateSettingsRequest,
    state: AppState = Depends(get_state),
) -> SettingsSnapshot:
    changed = False
    if payload.embedding is not None:
        new_provider: str | None
        if payload.embedding.provider == EmbeddingProvider.auto:
            new_provider = None
        else:
            new_provider = payload.embedding.provider.value
        new_model = (payload.embedding.model or "").strip() or None
        if (
            new_provider != state.settings.embedding_provider
            or new_model != state.settings.embedding_model
        ):
            state.settings.embedding_provider = new_provider
            state.settings.embedding_model = new_model
            changed = True

    if changed:
        overrides = {
            k: getattr(state.settings, k)
            for k in RUNTIME_MUTABLE_FIELDS
            if getattr(state.settings, k) is not None
        }
        try:
            save_runtime_overrides(state.settings.data_dir, overrides)
        except OSError as exc:
            _log.warning("settings: failed to persist overrides (%s)", exc)
        await _refresh_indexers(state)

    return _snapshot(state)


async def _refresh_indexers(state: AppState) -> None:
    """Reset cached indexers so the next access picks up the new embedder,
    and kick off a background reindex for any session that was already
    using one. Errors are logged and swallowed — a failed background
    reindex must not break the settings PATCH response."""

    with state._index_lock:
        cached = list(state._indexers.items())
        state._indexers.clear()

    for session_id, prev in cached:
        try:
            indexer = state.indexer_for(session_id, prev.workspace_root)
        except Exception:
            _log.exception("settings: failed to rebuild indexer for %s", session_id)
            continue
        _spawn_background(_safe_reindex(indexer, session_id))


async def _safe_reindex(indexer, session_id) -> None:  # type: ignore[no-untyped-def]
    try:
        await indexer.reindex()
        # The rebuilt indexer starts without a watcher; resume it if the user
        # had file-watching enabled so the preference survives the embedder swap.
        if indexer.watch_preference:
            await indexer.start_watcher()
    except Exception:
        _log.exception("settings: background reindex failed for %s", session_id)
