"""Embedding-dimension safety property for the semantic workspace index."""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st
from shared_schema.models import EmbedderInfo
from zocai_gateway.context.rag_matcher import cosine_sim
from zocai_gateway.workspace_index import WorkspaceIndexer


@settings(max_examples=100, deadline=None)
@given(
    declared=st.integers(min_value=1, max_value=8),
    returned=st.integers(min_value=0, max_value=9),
)
def test_dimension_mismatch_aborts_build_and_rejects_search(
    declared: int, returned: int
) -> None:
    """Feature: advanced-context-engine, Property 2: dimension mismatch aborts.

    **Validates: Requirements 1.6, 3.7**
    """
    if returned == declared:
        returned = declared + 1

    class WrongDimensionEmbedder:
        @property
        def info(self) -> EmbedderInfo:
            return EmbedderInfo(kind="test", model="wrong-dimension", dim=declared)

        def embed_documents(self, documents):
            return [[1.0] * returned for _document in documents]

        def embed_query(self, query):
            return [1.0] * returned

    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        (root / "main.py").write_text("searchable = True\n", encoding="utf-8")

        async def scenario() -> None:
            indexer = WorkspaceIndexer(embedder=WrongDimensionEmbedder())
            queue = indexer.broker.subscribe()
            with pytest.raises(ValueError, match="dimension"):
                await indexer.rebuild("session", root)

            assert indexer.is_ready("session") is False
            assert indexer.status("session", root).chunk_count == 0
            assert indexer.query("session", "searchable") == []
            events = [queue.get_nowait() for _ in range(queue.qsize())]
            assert events[-1].type == "index.error"
            assert "dimension" in (events[-1].message or "")

        asyncio.run(scenario())

    with pytest.raises(ValueError, match="dimension"):
        cosine_sim([1.0] * declared, [[1.0] * returned])
