"""Edge-case unit tests for `RecallService.recall` (Phase 4 semantic recall).

Covers the boundary behaviours called out in the spec:
  - Requirement 4.3: an empty or whitespace-only query returns zero hits.
  - Requirement 4.4: returned hits are ordered by descending score and
    capped at the configured ``top_k`` (default 3).
  - Requirement 4.5: a ``top_k <= 0`` configuration returns zero hits.

These live in a separate file from the property tests (12.2/12.3) so the
two suites don't collide. We use a throwaway SQLite path and the default
dependency-free ``HashEmbedder`` so the tests stay deterministic and offline.
"""

from __future__ import annotations

from pathlib import Path
from uuid import uuid4

import pytest
from llama_studio_agent.agent.recall import (
    MessageVectorStore,
    RecallConfig,
    RecallService,
)
from shared_schema.models import Message, MessageRole


def _make_service(tmp_path: Path) -> RecallService:
    """A recall service backed by a tmp SQLite file and the default
    offline HashEmbedder."""
    store = MessageVectorStore(tmp_path / "recall.sqlite")
    return RecallService(store=store)


def _messages(*contents: str) -> list[Message]:
    """User messages with the given contents, distinct ids."""
    return [Message(role=MessageRole.user, content=c) for c in contents]


# ── Requirement 4.3: empty / whitespace query ───────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("query", ["", "   ", "\n\t  \r"])
async def test_empty_or_whitespace_query_returns_no_hits(tmp_path, query):
    svc = _make_service(tmp_path)
    session_id = uuid4()
    # Populate the store so a non-empty query *would* have something to match.
    written = await svc.index_messages(
        session_id, _messages("alpha beta gamma", "delta epsilon")
    )
    assert written == 2

    hits = await svc.recall(session_id, query)

    assert hits == []


# ── Requirement 4.5: non-positive top_k ─────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("top_k", [0, -1, -42])
async def test_non_positive_top_k_returns_no_hits(tmp_path, top_k):
    svc = _make_service(tmp_path)
    session_id = uuid4()
    await svc.index_messages(
        session_id, _messages("alpha beta", "alpha gamma", "alpha delta")
    )

    # min_score floored very low so the only thing that can zero out the
    # result is the top_k short-circuit itself.
    cfg = RecallConfig(top_k=top_k, min_score=-1.0)
    hits = await svc.recall(session_id, "alpha", cfg=cfg)

    assert hits == []


# ── Requirement 4.4: descending order + top_k cap ───────────────────────


@pytest.mark.asyncio
async def test_hits_ordered_by_descending_score(tmp_path):
    svc = _make_service(tmp_path)
    session_id = uuid4()
    await svc.index_messages(
        session_id,
        _messages(
            "alpha alpha alpha",
            "alpha beta",
            "beta gamma delta",
            "epsilon zeta",
            "eta theta iota",
        ),
    )

    # Floor disabled so every stored message survives, exposing the full
    # ordering rather than a min_score-filtered subset.
    cfg = RecallConfig(top_k=10, min_score=-1.0)
    hits = await svc.recall(session_id, "alpha beta", cfg=cfg)

    assert len(hits) >= 2
    scores = [h.score for h in hits]
    assert scores == sorted(scores, reverse=True)


@pytest.mark.asyncio
async def test_results_capped_at_configured_top_k(tmp_path):
    svc = _make_service(tmp_path)
    session_id = uuid4()
    await svc.index_messages(
        session_id,
        _messages(
            "alpha one",
            "alpha two",
            "alpha three",
            "alpha four",
            "alpha five",
        ),
    )

    cfg = RecallConfig(top_k=2, min_score=-1.0)
    hits = await svc.recall(session_id, "alpha", cfg=cfg)

    assert len(hits) == 2
    scores = [h.score for h in hits]
    assert scores == sorted(scores, reverse=True)


@pytest.mark.asyncio
async def test_default_top_k_caps_at_three(tmp_path):
    svc = _make_service(tmp_path)
    session_id = uuid4()
    await svc.index_messages(
        session_id,
        _messages(
            "alpha one",
            "alpha two",
            "alpha three",
            "alpha four",
            "alpha five",
            "alpha six",
        ),
    )

    # Default config has top_k=3; floor disabled so all six survive and the
    # cap (not the score filter) is what limits the result to three.
    cfg = RecallConfig(min_score=-1.0)
    hits = await svc.recall(session_id, "alpha", cfg=cfg)

    assert cfg.top_k == 3
    assert len(hits) == 3
    scores = [h.score for h in hits]
    assert scores == sorted(scores, reverse=True)
