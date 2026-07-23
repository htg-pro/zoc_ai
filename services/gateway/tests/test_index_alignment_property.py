"""Chunk/vector positional-alignment property for incremental indexing."""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

from hypothesis import given, settings
from hypothesis import strategies as st
from shared_schema.models import EmbedderInfo
from zocai_gateway.workspace_index import WorkspaceIndexer

_FILE_NAMES = ("a.py", "b.py", "c.py")
_CONTENT = st.one_of(
    st.none(),
    st.just(""),
    st.text(alphabet="abc XYZ012", min_size=1, max_size=120),
)
_OPERATIONS = st.lists(
    st.tuples(st.sampled_from(_FILE_NAMES), _CONTENT),
    min_size=0,
    max_size=6,
)


class _ContentEmbedder:
    @property
    def info(self) -> EmbedderInfo:
        return EmbedderInfo(kind="test", model="content", dim=2)

    def embed_documents(self, documents):
        return [self._vector(document) for document in documents]

    def embed_query(self, query):
        return self._vector(query)

    @staticmethod
    def _vector(document: str) -> tuple[float, float]:
        return (float(len(document)), float(sum(map(ord, document)) % 997))


@settings(max_examples=100, deadline=None)
@given(operations=_OPERATIONS)
def test_chunks_and_embeddings_remain_positionally_aligned(
    operations: list[tuple[str, str | None]],
) -> None:
    """Feature: advanced-context-engine, Property 4: positional alignment.

    **Validates: Requirements 1.2, 4.5**
    """
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        state: dict[str, str | None] = {
            "a.py": "alpha initial",
            "b.py": "beta initial",
            "c.py": "gamma initial",
        }
        for name, content in state.items():
            assert content is not None
            (root / name).write_text(content, encoding="utf-8")

        async def scenario() -> None:
            embedder = _ContentEmbedder()
            indexer = WorkspaceIndexer(embedder=embedder, debounce_seconds=0)
            await indexer.rebuild("session", root)

            async def assert_alignment() -> None:
                indexed = indexer._indexes["session"]
                assert len(indexed.chunks) == len(indexed.embeddings)
                assert len(indexed.chunks) == indexed.bm25_index.document_count
                for chunk, embedding in zip(
                    indexed.chunks, indexed.embeddings, strict=True
                ):
                    assert embedding == embedder._vector(chunk.text)
                    assert state[chunk.file] is not None
                    assert str(state[chunk.file]).strip()
                absent = {
                    name
                    for name, content in state.items()
                    if content is None or not content.strip()
                }
                assert not absent.intersection(chunk.file for chunk in indexed.chunks)

            await assert_alignment()
            update = indexer._update_changed_files
            for name, content in operations:
                path = root / name
                state[name] = content
                if content is None:
                    path.unlink(missing_ok=True)
                else:
                    path.write_text(content, encoding="utf-8")
                await update("session", (str(path),))
                await assert_alignment()

        asyncio.run(scenario())
