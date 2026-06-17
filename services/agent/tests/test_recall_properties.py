"""Property-based tests for the session-scoped recall contract.

Spec: chat-memory-session-system.

This module hosts the hypothesis-driven correctness properties for
``RecallService`` / ``MessageVectorStore`` (``agent/recall.py``). The async
recall API is driven through ``asyncio.run`` inside synchronous hypothesis
tests so that ``@given`` re-runs each example on its own fresh event loop and
store (this avoids the well-known clash between ``@given`` and async,
function-scoped pytest fixtures).

Properties implemented here:
  * Property 10 — Recall session isolation (Task 12.2).
  * Property 11 — Recall excludes the working window (Task 12.3).
"""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path
from uuid import UUID, uuid4

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from llama_studio_agent.agent.recall import (
    MessageVectorStore,
    RecallConfig,
    RecallService,
)
from shared_schema.models import Message, MessageRole

# Tokens the HashEmbedder actually recognises: words of 2-8 lowercase letters
# match its ``[A-Za-z_][A-Za-z0-9_]+`` rule, so embeddings are non-zero and
# cosine scores are meaningful. Whitespace-joining keeps queries/content
# non-empty (so the empty-query short-circuit never fires here).
_WORD = st.from_regex(r"[a-z]{2,8}", fullmatch=True)
_TEXT = st.lists(_WORD, min_size=1, max_size=5).map(" ".join)
_ROLE = st.sampled_from([MessageRole.user, MessageRole.assistant])


@settings(
    max_examples=75,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture],
)
@given(
    contents=st.lists(_TEXT, min_size=1, max_size=8),
    query=_TEXT,
    data=st.data(),
)
def test_recall_excludes_working_window_and_respects_min_score(
    tmp_path: Path,
    contents: list[str],
    query: str,
    data: st.DataObject,
) -> None:
    """Property 11: Recall excludes the working window.

    For any query and any Working_Window exclusion set X, no returned hit's
    ``message_id`` is in X, and every returned hit's score is >= the
    configured minimum score.

    **Validates: Requirements 4.2**
    """
    session_id = uuid4()
    messages = [Message(role=data.draw(_ROLE), content=c) for c in contents]

    # Draw an arbitrary subset of the stored message ids as the working window.
    mask = data.draw(
        st.lists(st.booleans(), min_size=len(messages), max_size=len(messages))
    )
    exclude_ids = {m.id for m, keep in zip(messages, mask, strict=True) if keep}

    store = MessageVectorStore(tmp_path / f"recall-{uuid4().hex}.sqlite")
    service = RecallService(store=store)
    cfg = RecallConfig()

    async def _run() -> list:
        await service.index_messages(session_id, messages)
        return await service.recall(
            session_id,
            query,
            cfg=cfg,
            exclude_message_ids=exclude_ids,
        )

    hits = asyncio.run(_run())

    for hit in hits:
        assert hit.message_id not in exclude_ids, (
            "recall returned a hit inside the excluded working window"
        )
        assert hit.score >= cfg.min_score, (
            f"recall returned a hit below min_score: {hit.score} < {cfg.min_score}"
        )


# Content that always embeds to a non-trivial vector: at least one
# alphanumeric character, no leading/trailing-only whitespace surprises.
_content = st.text(
    alphabet=st.characters(whitelist_categories=("Lu", "Ll", "Nd"), min_codepoint=48),
    min_size=1,
    max_size=40,
)

# A corpus is a list of sessions (≥2), each session being a non-empty list of
# message contents. Distinct session UUIDs are assigned inside the test.
_corpus = st.lists(
    st.lists(_content, min_size=1, max_size=5),
    min_size=2,
    max_size=4,
)


def _messages(contents: list[str]) -> list[Message]:
    return [Message(role=MessageRole.user, content=c) for c in contents]


# Property 10: Recall session isolation.
# ∀ stored vectors across ≥2 sessions, query: recall(s, …) returns only hits
# stored under s.
# **Validates: Requirements 4.1**
@settings(max_examples=75, deadline=None)
@given(corpus=_corpus, target_idx=st.integers(min_value=0, max_value=3))
def test_recall_returns_only_hits_from_queried_session(
    corpus: list[list[str]], target_idx: int
) -> None:
    async def _run() -> None:
        target = target_idx % len(corpus)
        with tempfile.TemporaryDirectory() as tmp:
            store = MessageVectorStore(Path(tmp) / "recall.sqlite")
            service = RecallService(store=store)

            session_ids: list[UUID] = [uuid4() for _ in corpus]
            ids_by_session: dict[UUID, set[UUID]] = {}
            for sid, contents in zip(session_ids, corpus, strict=True):
                msgs = _messages(contents)
                ids_by_session[sid] = {m.id for m in msgs}
                await service.index_messages(sid, msgs)

            target_sid = session_ids[target]
            # Query with content drawn from the target session so the
            # retrieval path actually produces hits; drop the score floor and
            # widen top_k so we see everything the store would surface.
            query = corpus[target][0]
            cfg = RecallConfig(top_k=1000, min_score=-1.0, snippet_chars=10_000)
            hits = await service.recall(target_sid, query, cfg=cfg)

            target_ids = ids_by_session[target_sid]
            other_ids: set[UUID] = set()
            for sid, ids in ids_by_session.items():
                if sid != target_sid:
                    other_ids |= ids

            for h in hits:
                # Every hit belongs to the queried session …
                assert h.message_id in target_ids, (
                    f"hit {h.message_id} not stored under queried session {target_sid}"
                )
            # … and no other session's message can leak through, even when
            # other sessions share identical content.
            returned = {h.message_id for h in hits}
            assert not (returned & (other_ids - target_ids)), (
                "recall leaked message ids from other sessions"
            )

    asyncio.run(_run())
