"""Context search for the `@` mention picker — files, folders, and symbols."""

from __future__ import annotations

import contextlib

from fastapi import APIRouter, Depends, Query
from shared_schema.models import ContextCandidate, Session

from ..agent.context_search import search_files
from ..deps import get_session, get_state
from ..state import AppState

router = APIRouter(prefix="/sessions/{session_id}", tags=["context"])


@router.get("/context/search", response_model=list[ContextCandidate])
async def context_search(
    q: str = Query(default=""),
    limit: int = Query(default=25, ge=1, le=100),
    session: Session = Depends(get_session),
    state: AppState = Depends(get_state),
) -> list[ContextCandidate]:
    root = session.workspace_root or ""
    candidates: list[ContextCandidate] = [
        ContextCandidate(
            kind=item["kind"],  # type: ignore[arg-type]
            label=str(item["label"]),
            path=str(item["path"]),
            detail=str(item["detail"]) if item.get("detail") else None,
        )
        for item in (search_files(root, q, limit=limit) if root else [])
    ]

    # Best-effort code symbols from the index (semantic). Skipped silently when
    # the indexer isn't ready or returns nothing.
    if q.strip():
        with contextlib.suppress(Exception):
            indexer = state.indexer_for(session.id, session.workspace_root)
            hits = await indexer.query(q, top_k=min(8, limit))
            for hit in hits:
                chunk = hit.chunk
                snippet = (chunk.text or "").strip().splitlines()
                label = snippet[0][:80] if snippet else chunk.file.rsplit("/", 1)[-1]
                candidates.append(
                    ContextCandidate(
                        kind="symbol",
                        label=label or chunk.file,
                        path=chunk.file,
                        detail=f"{chunk.file}:{chunk.start_line + 1}",
                        line=chunk.start_line + 1,
                    )
                )

    return candidates[:limit]
