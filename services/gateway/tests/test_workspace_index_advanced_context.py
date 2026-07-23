"""Advanced semantic workspace-index unit and integration coverage."""

from __future__ import annotations

import asyncio
import importlib.util
import threading
import time
from pathlib import Path

import pytest
import zocai_gateway.workspace_index as workspace_index_module
from shared_schema.models import EmbedderInfo
from zocai_gateway.context.index_store import IndexPersistence
from zocai_gateway.workspace_index import (
    FastEmbedEmbedder,
    WorkspaceIndexer,
    _HashEmbedder,
    load_embedder,
)


class _FakeFastEmbedModel:
    def embed(self, documents: list[str]):
        return ([float(index)] * 384 for index, _document in enumerate(documents, 1))

    def query_embed(self, query: str):
        return ([1.0] * 384 for _ in [query])


def test_fastembed_adapter_reports_real_model_metadata() -> None:
    embedder = FastEmbedEmbedder(model=_FakeFastEmbedModel())

    assert embedder.info == EmbedderInfo(
        kind="fastembed",
        model="BAAI/bge-small-en-v1.5",
        dim=384,
        is_fallback=False,
    )
    assert len(embedder.embed_documents(["one", "two"])) == 2
    assert len(embedder.embed_documents(["one"])[0]) == 384
    assert len(embedder.embed_query("query")) == 384


def test_load_embedder_falls_back_after_any_model_load_failure(monkeypatch) -> None:
    def fail() -> None:
        raise RuntimeError("model unavailable")

    monkeypatch.setattr(workspace_index_module, "FastEmbedEmbedder", fail)

    embedder = load_embedder()

    assert isinstance(embedder, _HashEmbedder)
    assert embedder.info.kind == "hash"
    assert embedder.info.dim == 256
    assert embedder.info.is_fallback is True


def test_document_embedding_runs_off_the_event_loop(tmp_path: Path) -> None:
    (tmp_path / "main.py").write_text("value = 1\n", encoding="utf-8")
    main_thread = threading.get_ident()

    class ThreadRecordingEmbedder:
        thread_id: int | None = None

        @property
        def info(self) -> EmbedderInfo:
            return EmbedderInfo(kind="test", model="thread", dim=2)

        def embed_documents(self, documents):
            self.thread_id = threading.get_ident()
            time.sleep(0.02)
            return [[1.0, 0.0] for _document in documents]

        def embed_query(self, query):
            return [1.0, 0.0]

    async def scenario() -> None:
        embedder = ThreadRecordingEmbedder()
        indexer = WorkspaceIndexer(embedder=embedder)
        heartbeat = False

        async def tick() -> None:
            nonlocal heartbeat
            await asyncio.sleep(0.005)
            heartbeat = True

        await asyncio.gather(indexer.rebuild("session", tmp_path), tick())
        assert heartbeat is True
        assert embedder.thread_id is not None
        assert embedder.thread_id != main_thread

    asyncio.run(scenario())


def test_lazy_first_queries_start_exactly_one_nonblocking_build(tmp_path: Path) -> None:
    (tmp_path / "main.py").write_text("lazy searchable\n", encoding="utf-8")

    class BlockingEmbedder:
        def __init__(self) -> None:
            self.calls = 0
            self.started = threading.Event()
            self.release = threading.Event()

        @property
        def info(self) -> EmbedderInfo:
            return EmbedderInfo(kind="test", model="blocking", dim=2)

        def embed_documents(self, documents):
            self.calls += 1
            self.started.set()
            assert self.release.wait(timeout=2)
            return [[1.0, 0.0] for _document in documents]

        def embed_query(self, query):
            return [1.0, 0.0]

    async def scenario() -> None:
        embedder = BlockingEmbedder()
        indexer = WorkspaceIndexer(embedder=embedder, lazy=True)
        queue = indexer.broker.subscribe()
        status = await indexer.open_workspace("lazy", tmp_path)
        assert status.chunk_count == 0
        assert indexer.build_state("lazy") == "idle"

        assert await indexer.query_async("lazy", tmp_path, "searchable") == []
        for _ in range(200):
            if embedder.started.is_set():
                break
            await asyncio.sleep(0.001)
        assert embedder.started.is_set()
        assert indexer.build_state("lazy") == "building"
        assert await indexer.query_async("lazy", tmp_path, "searchable") == []
        assert embedder.calls == 1

        embedder.release.set()
        task = indexer._background_builds["lazy"]
        await task
        assert indexer.is_ready("lazy") is True
        assert indexer.query("lazy", "searchable")
        assert embedder.calls == 1

        events = [queue.get_nowait() for _ in range(queue.qsize())]
        assert [event.type for event in events] == [
            "index.started",
            "index.progress",
            "index.completed",
        ]
        await indexer.close()

    asyncio.run(scenario())


def test_incremental_failure_retains_prior_index(tmp_path: Path) -> None:
    target = tmp_path / "main.py"
    target.write_text("before\n", encoding="utf-8")

    class FailingEmbedder:
        fail = False

        @property
        def info(self) -> EmbedderInfo:
            return EmbedderInfo(kind="test", model="failure", dim=2)

        def embed_documents(self, documents):
            if self.fail:
                raise RuntimeError("incremental embedding failed")
            return [[1.0, 0.0] for _document in documents]

        def embed_query(self, query):
            return [1.0, 0.0]

    async def scenario() -> None:
        embedder = FailingEmbedder()
        indexer = WorkspaceIndexer(embedder=embedder)
        await indexer.rebuild("session", tmp_path)
        prior = indexer._indexes["session"]
        queue = indexer.broker.subscribe()

        target.write_text("after\n", encoding="utf-8")
        embedder.fail = True
        with pytest.raises(RuntimeError, match="incremental"):
            await indexer._update_changed_files(
                "session", (str(target),)
            )

        assert indexer._indexes["session"] is prior
        events = [queue.get_nowait() for _ in range(queue.qsize())]
        assert events[-1].type == "index.error"
        assert "incremental" in (events[-1].message or "")

    asyncio.run(scenario())


def test_persisted_index_reopens_without_rescan_and_preserves_order(
    tmp_path: Path, monkeypatch
) -> None:
    (tmp_path / "alpha.py").write_text("alpha needle\n", encoding="utf-8")
    (tmp_path / "beta.py").write_text("beta helper\n", encoding="utf-8")
    persistence = IndexPersistence(tmp_path / "indices")

    class DeterministicEmbedder:
        def __init__(self, *, reject_documents: bool = False) -> None:
            self.reject_documents = reject_documents
            self.document_calls = 0

        @property
        def info(self) -> EmbedderInfo:
            return EmbedderInfo(kind="test", model="reopen", dim=2)

        def embed_documents(self, documents):
            self.document_calls += 1
            if self.reject_documents:
                raise AssertionError("persisted reopen attempted to re-embed")
            return [
                [1.0, 0.0] if "alpha" in document else [0.0, 1.0]
                for document in documents
            ]

        def embed_query(self, query):
            return [1.0, 0.0] if "alpha" in query else [0.0, 1.0]

    async def scenario() -> None:
        first_embedder = DeterministicEmbedder()
        first = WorkspaceIndexer(
            embedder=first_embedder,
            persistence=persistence,
        )
        await first.rebuild("first", tmp_path)
        before = [result.chunk.file for result in first.query("first", "alpha")]
        assert first_embedder.document_calls == 1

        async def no_scan(_root: Path):
            raise AssertionError("persisted reopen attempted to rescan")

        monkeypatch.setattr(workspace_index_module, "_discover_files", no_scan)
        second_embedder = DeterministicEmbedder(reject_documents=True)
        second = WorkspaceIndexer(
            embedder=second_embedder,
            persistence=persistence,
        )
        queue = second.broker.subscribe()
        status = await second.rebuild("second", tmp_path)
        after = [result.chunk.file for result in second.query("second", "alpha")]

        assert status.file_count == 2
        assert second_embedder.document_calls == 0
        assert after == before
        events = [queue.get_nowait() for _ in range(queue.qsize())]
        assert [event.type for event in events] == ["index.completed"]

    asyncio.run(scenario())


def test_real_fastembed_loads_when_optional_dependency_is_present() -> None:
    if importlib.util.find_spec("fastembed") is None:
        pytest.skip("optional fastembed dependency is not installed")

    embedder = FastEmbedEmbedder()
    vector = embedder.embed_query("semantic index smoke test")
    assert embedder.info.is_fallback is False
    assert embedder.info.dim == 384
    assert len(vector) == 384
