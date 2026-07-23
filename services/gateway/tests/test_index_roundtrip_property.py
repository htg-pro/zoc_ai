"""Persistence round-trip ranking property for the semantic index."""

from __future__ import annotations

import tempfile
from pathlib import Path

from hypothesis import given, settings
from hypothesis import strategies as st
from shared_schema.models import EmbedderInfo, IndexChunk
from zocai_gateway.context.index_store import IndexManifest, IndexPersistence
from zocai_gateway.context.rag_matcher import BM25Index, hybrid_search

_TEXT = st.text(alphabet="abcxyz needle", min_size=1, max_size=60)


def _embedding(text: str) -> tuple[float, float, float]:
    lowered = text.lower()
    return (
        float(lowered.count("a") + lowered.count("needle")),
        float(lowered.count("b") + lowered.count("x")),
        float(len(lowered) + 1),
    )


@settings(max_examples=100, deadline=None)
@given(
    documents=st.lists(_TEXT, min_size=1, max_size=8, unique=True),
    query=_TEXT,
    limit=st.integers(min_value=1, max_value=12),
)
def test_persistence_round_trip_preserves_hybrid_ranking(
    documents: list[str], query: str, limit: int
) -> None:
    """Feature: advanced-context-engine, Property 6: ranking round trip.

    **Validates: Requirements 2.8**
    """
    with tempfile.TemporaryDirectory() as temp:
        base = Path(temp)
        workspace = base / "workspace"
        store = IndexPersistence(base / "indices")
        info = EmbedderInfo(kind="test", model="rank", dim=3)
        chunks = tuple(
            IndexChunk(
                id=f"chunk-{index}",
                file=f"{index}.txt",
                start_line=1,
                end_line=1,
                text=document,
            )
            for index, document in enumerate(documents)
        )
        embeddings = tuple(_embedding(document) for document in documents)
        bm25 = BM25Index(documents)

        before = hybrid_search(
            query,
            chunks,
            bm25_index=bm25,
            embeddings=embeddings,
            embed_query=_embedding,
            k=limit,
        )
        store.save(
            workspace,
            chunks,
            embeddings,
            bm25,
            IndexManifest.create(info, len(chunks)),
        )
        loaded = store.load(workspace, current_embedder=info)
        assert loaded is not None

        after = hybrid_search(
            query,
            loaded.chunks,
            bm25_index=loaded.bm25_index,
            embeddings=loaded.embeddings,
            embed_query=_embedding,
            k=limit,
        )
        assert [chunk.id for chunk in after] == [chunk.id for chunk in before]
