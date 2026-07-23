from __future__ import annotations

import asyncio
import threading
import time

from shared_schema.models import EmbedderInfo, WorkspaceIndexProgress
from zocai_gateway.event_bus import (
    FS_CHANGED_TOPIC,
    GatewayEventBus,
    WorkspaceFilesChanged,
)
from zocai_gateway.workspace_index import (
    INCREMENTAL_DEBOUNCE_SECONDS,
    IndexProgressBroker,
    WorkspaceIndexer,
)


def test_rebuild_emits_monotonic_progress_and_builds_searchable_index(tmp_path) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "alpha.py").write_text(
        "def alpha():\n    return 'searchable needle'\n",
        encoding="utf-8",
    )
    (tmp_path / "src" / "beta.ts").write_text(
        "export const beta = 2;\n",
        encoding="utf-8",
    )
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "ignored.ts").write_text("needle", encoding="utf-8")
    (tmp_path / ".env").write_text("SECRET=needle\n", encoding="utf-8")

    async def scenario() -> None:
        indexer = WorkspaceIndexer()
        queue = indexer.broker.subscribe()

        status = await indexer.rebuild("session-1", tmp_path)
        events = [queue.get_nowait() for _ in range(queue.qsize())]

        assert [event.type for event in events] == [
            "index.started",
            "index.progress",
            "index.progress",
            "index.completed",
        ]
        assert [event.processed_files for event in events] == [0, 1, 2, 2]
        assert all(event.total_files == 2 for event in events)
        assert events[-1].indexed_files == 2
        assert events[-1].token_count > 0
        assert status.file_count == 2
        assert status.chunk_count == 2

        matches = indexer.query("session-1", "searchable needle")
        assert matches
        assert matches[0].chunk.file == "src/alpha.py"

    asyncio.run(scenario())


def test_new_subscriber_replays_only_active_progress() -> None:
    async def scenario() -> None:
        broker = IndexProgressBroker()
        active = WorkspaceIndexProgress(
            type="index.progress",
            sessionId="session-1",
            processedFiles=3,
            totalFiles=10,
            indexedFiles=3,
            tokenCount=100,
        )
        broker.publish(active)
        active_queue = broker.subscribe()
        assert active_queue.get_nowait() == active

        broker.publish(
            active.model_copy(
                update={
                    "type": "index.completed",
                    "processed_files": 10,
                    "indexed_files": 10,
                }
            )
        )
        completed_queue = broker.subscribe()
        assert completed_queue.empty()

    asyncio.run(scenario())


def test_query_can_return_semantic_match_without_lexical_overlap(tmp_path) -> None:
    (tmp_path / "alpha.py").write_text("def alpha():\n    return 1\n", encoding="utf-8")
    (tmp_path / "beta.py").write_text("def beta():\n    return 2\n", encoding="utf-8")

    class ControlledEmbedder:
        @property
        def info(self) -> EmbedderInfo:
            return EmbedderInfo(kind="test", model="controlled", dim=2)

        def embed_documents(self, documents):
            return [
                [0.0, 1.0] if "alpha" in document else [1.0, 0.0]
                for document in documents
            ]

        def embed_query(self, query):
            assert query == "conceptual lookup"
            return [1.0, 0.0]

    async def scenario() -> None:
        indexer = WorkspaceIndexer(embedder=ControlledEmbedder())
        status = await indexer.rebuild("session-semantic", tmp_path)

        matches = indexer.query("session-semantic", "conceptual lookup")

        assert status.embedder is not None
        assert status.embedder.kind == "test"
        assert matches
        assert matches[0].chunk.file == "beta.py"

    asyncio.run(scenario())


def test_fs_changed_debounces_and_reembeds_only_affected_file(tmp_path) -> None:
    alpha = tmp_path / "alpha.py"
    beta = tmp_path / "beta.py"
    alpha.write_text("alpha original\n", encoding="utf-8")
    beta.write_text("beta untouched\n", encoding="utf-8")

    class CountingEmbedder:
        batches: list[list[str]] = []

        @property
        def info(self) -> EmbedderInfo:
            return EmbedderInfo(kind="test", model="counting", dim=2)

        def embed_documents(self, documents):
            batch = list(documents)
            self.batches.append(batch)
            return [
                [1.0, 0.0] if "alpha" in document else [0.0, 1.0]
                for document in batch
            ]

        def embed_query(self, query):
            return [1.0, 0.0] if "alpha" in query else [0.0, 1.0]

    async def scenario() -> None:
        embedder = CountingEmbedder()
        indexer = WorkspaceIndexer(embedder=embedder, debounce_seconds=0.02)
        bus = GatewayEventBus()
        unsubscribe = bus.subscribe(FS_CHANGED_TOPIC, indexer.handle_fs_changed)
        await indexer.rebuild("session-incremental", tmp_path)

        alpha.write_text("alpha intermediate\n", encoding="utf-8")
        await bus.publish(
            FS_CHANGED_TOPIC,
            WorkspaceFilesChanged(
                session_id="session-incremental", paths=(str(alpha),)
            ),
        )
        await asyncio.sleep(0.005)
        alpha.write_text("alpha finalmarker\n", encoding="utf-8")
        await bus.publish(
            FS_CHANGED_TOPIC,
            WorkspaceFilesChanged(
                session_id="session-incremental", paths=(str(alpha),)
            ),
        )
        await asyncio.sleep(0.05)

        assert len(embedder.batches) == 2
        assert len(embedder.batches[0]) == 2
        assert embedder.batches[1] == ["alpha finalmarker"]
        assert indexer.query("session-incremental", "finalmarker")[0].chunk.file == (
            "alpha.py"
        )
        assert indexer.query("session-incremental", "beta untouched")[0].chunk.file == (
            "beta.py"
        )

        unsubscribe()
        await indexer.close()

    assert INCREMENTAL_DEBOUNCE_SECONDS == 2.0
    asyncio.run(scenario())


def test_fs_changed_during_embedding_preserves_both_batches(tmp_path) -> None:
    alpha = tmp_path / "alpha.py"
    beta = tmp_path / "beta.py"
    alpha.write_text("alpha original\n", encoding="utf-8")
    beta.write_text("beta original\n", encoding="utf-8")

    class SlowEmbedder:
        def __init__(self) -> None:
            self.batches: list[list[str]] = []
            self.incremental_started = threading.Event()

        @property
        def info(self) -> EmbedderInfo:
            return EmbedderInfo(kind="test", model="slow", dim=2)

        def embed_documents(self, documents):
            batch = list(documents)
            self.batches.append(batch)
            if len(self.batches) == 2:
                self.incremental_started.set()
                time.sleep(0.05)
            return [[1.0, 0.0] for _document in batch]

        def embed_query(self, query):
            return [1.0, 0.0]

    async def scenario() -> None:
        embedder = SlowEmbedder()
        indexer = WorkspaceIndexer(embedder=embedder, debounce_seconds=0.01)
        bus = GatewayEventBus()
        bus.subscribe(FS_CHANGED_TOPIC, indexer.handle_fs_changed)
        await indexer.rebuild("session-race", tmp_path)

        alpha.write_text("alpha updatedmarker\n", encoding="utf-8")
        await bus.publish(
            FS_CHANGED_TOPIC,
            WorkspaceFilesChanged(session_id="session-race", paths=(str(alpha),)),
        )
        while not embedder.incremental_started.is_set():
            await asyncio.sleep(0.002)

        beta.write_text("beta finalmarker\n", encoding="utf-8")
        await bus.publish(
            FS_CHANGED_TOPIC,
            WorkspaceFilesChanged(session_id="session-race", paths=(str(beta),)),
        )
        await asyncio.sleep(0.12)

        last_batch = embedder.batches[-1]
        assert "alpha updatedmarker" in last_batch
        assert "beta finalmarker" in last_batch
        assert indexer.query("session-race", "updatedmarker")[0].chunk.file == (
            "alpha.py"
        )
        assert indexer.query("session-race", "finalmarker")[0].chunk.file == "beta.py"
        await indexer.close()

    asyncio.run(scenario())
