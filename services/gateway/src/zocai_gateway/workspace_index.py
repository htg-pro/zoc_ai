"""Session-scoped workspace text index with websocket progress publication."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import itertools
import math
import os
import re
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal, Protocol

from shared_schema.models import (
    EmbedderInfo,
    IndexChunk,
    IndexQueryResult,
    IndexStatus,
    WorkspaceIndexProgress,
)

from zocai_gateway.context.index_store import (
    IndexManifest,
    IndexPersistence,
    LoadedIndex,
)
from zocai_gateway.context.rag_matcher import BM25Index, hybrid_rank
from zocai_gateway.context_mentions import IGNORED_DIR_NAMES
from zocai_gateway.event_bus import WorkspaceFilesChanged

MAX_INDEX_FILES = 100_000
MAX_FILE_BYTES = 2 * 1024 * 1024
CHUNK_LINES = 120
CHUNK_OVERLAP_LINES = 20
PROGRESS_QUEUE_SIZE = 64
INCREMENTAL_DEBOUNCE_SECONDS = 2.0

_TEXT_SUFFIXES = frozenset(
    {
        ".c",
        ".cc",
        ".cpp",
        ".cs",
        ".css",
        ".go",
        ".graphql",
        ".h",
        ".hpp",
        ".html",
        ".java",
        ".js",
        ".json",
        ".jsx",
        ".kt",
        ".lua",
        ".md",
        ".php",
        ".proto",
        ".py",
        ".rb",
        ".rs",
        ".scss",
        ".sh",
        ".sql",
        ".svelte",
        ".swift",
        ".toml",
        ".ts",
        ".tsx",
        ".vue",
        ".xml",
        ".yaml",
        ".yml",
        ".zig",
    }
)
_TEXT_FILENAMES = frozenset(
    {
        "dockerfile",
        "gemfile",
        "makefile",
        "procfile",
        "readme",
    }
)
_SENSITIVE_FILENAMES = frozenset(
    {
        ".env",
        ".env.local",
        ".env.production",
        ".npmrc",
        ".pypirc",
        "credentials",
        "credentials.json",
        "id_rsa",
        "id_ed25519",
    }
)
_TOKEN_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*|\d+|[^\s]")


@dataclass(frozen=True)
class IndexedWorkspace:
    status: IndexStatus
    chunks: tuple[IndexChunk, ...]
    token_count: int
    bm25_index: BM25Index
    embeddings: tuple[tuple[float, ...], ...]
    embedder: WorkspaceEmbedder
    file_token_counts: Mapping[str, int]


class WorkspaceEmbedder(Protocol):
    """Embedding seam used by the indexer for documents and queries."""

    @property
    def info(self) -> EmbedderInfo: ...

    def embed_documents(
        self, documents: Sequence[str]
    ) -> Sequence[Sequence[float]]: ...

    def embed_query(self, query: str) -> Sequence[float]: ...


class _HashEmbedder:
    """Dependency-free semantic fallback with deterministic token hashing."""

    DIMENSION = 256

    @property
    def info(self) -> EmbedderInfo:
        return _fallback_embedder()

    def embed_documents(
        self, documents: Sequence[str]
    ) -> Sequence[Sequence[float]]:
        return [_hash_embedding(document, self.DIMENSION) for document in documents]

    def embed_query(self, query: str) -> Sequence[float]:
        return _hash_embedding(query, self.DIMENSION)


class _FastEmbedModel(Protocol):
    def embed(self, documents: list[str]) -> Iterable[Sequence[float]]: ...

    def query_embed(self, query: str) -> Iterable[Sequence[float]]: ...


class FastEmbedEmbedder:
    """CPU-local embeddings from ``BAAI/bge-small-en-v1.5`` (dimension 384)."""

    MODEL_ID = "BAAI/bge-small-en-v1.5"
    DIMENSION = 384

    def __init__(self, model: _FastEmbedModel | None = None) -> None:
        if model is None:
            from fastembed import TextEmbedding  # type: ignore[import-not-found]

            model = TextEmbedding(
                model_name=self.MODEL_ID,
                providers=["CPUExecutionProvider"],
            )
        self._model = model

    @property
    def info(self) -> EmbedderInfo:
        return EmbedderInfo(
            kind="fastembed",
            model=self.MODEL_ID,
            dim=self.DIMENSION,
            is_fallback=False,
        )

    def embed_documents(
        self, documents: Sequence[str]
    ) -> Sequence[Sequence[float]]:
        if not documents:
            return ()
        embed = self._model.embed
        return tuple(tuple(float(value) for value in row) for row in embed(list(documents)))

    def embed_query(self, query: str) -> Sequence[float]:
        query_embed = self._model.query_embed
        rows = list(query_embed(query))
        if len(rows) != 1:
            raise ValueError(f"fastembed returned {len(rows)} query vectors")
        return tuple(float(value) for value in rows[0])


def load_embedder() -> WorkspaceEmbedder:
    """Load FastEmbed when available, falling back on every import/load error."""
    try:
        return FastEmbedEmbedder()
    except Exception:
        return _HashEmbedder()


class IndexProgressBroker:
    """Fan progress frames out to websocket subscribers without blocking indexing."""

    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[WorkspaceIndexProgress]] = set()
        self._latest_active: WorkspaceIndexProgress | None = None

    def subscribe(self) -> asyncio.Queue[WorkspaceIndexProgress]:
        queue: asyncio.Queue[WorkspaceIndexProgress] = asyncio.Queue(
            maxsize=PROGRESS_QUEUE_SIZE
        )
        self._subscribers.add(queue)
        if self._latest_active is not None:
            queue.put_nowait(self._latest_active)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[WorkspaceIndexProgress]) -> None:
        self._subscribers.discard(queue)

    def publish(self, event: WorkspaceIndexProgress) -> None:
        self._latest_active = (
            event
            if event.type in {"index.started", "index.progress"}
            else None
        )
        for queue in tuple(self._subscribers):
            if queue.full():
                with contextlib.suppress(asyncio.QueueEmpty):
                    queue.get_nowait()
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(event)


class WorkspaceIndexer:
    """Build an in-memory text index and expose hybrid lexical/semantic retrieval."""

    def __init__(
        self,
        broker: IndexProgressBroker | None = None,
        *,
        embedder: WorkspaceEmbedder | None = None,
        persistence: IndexPersistence | None = None,
        lazy: bool = False,
        debounce_seconds: float = INCREMENTAL_DEBOUNCE_SECONDS,
    ) -> None:
        if debounce_seconds < 0:
            raise ValueError("debounce_seconds must be non-negative")
        self.broker = broker or IndexProgressBroker()
        self._embedder = embedder or load_embedder()
        self._persistence = persistence
        self.lazy = lazy
        self._debounce_seconds = debounce_seconds
        self._indexes: dict[str, IndexedWorkspace] = {}
        self._workspace_roots: dict[str, Path] = {}
        self._build_states: dict[str, Literal["idle", "building", "ready"]] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._pending_paths: dict[str, set[str]] = {}
        self._debounce_tasks: dict[str, asyncio.Task[None]] = {}
        self._background_builds: dict[str, asyncio.Task[None]] = {}

    def register_workspace(
        self, session_id: str, workspace_root: Path | str
    ) -> IndexStatus:
        """Register the root needed by lazy retrieval without loading or scanning."""
        root = Path(workspace_root).expanduser().resolve()
        self._workspace_roots[session_id] = root
        self._build_states.setdefault(session_id, "idle")
        return self.status(session_id, root)

    async def open_workspace(
        self, session_id: str, workspace_root: Path | str
    ) -> IndexStatus:
        """Open a workspace lazily or make its index eagerly available."""
        status = self.register_workspace(session_id, workspace_root)
        if self.lazy:
            return status
        return await self.rebuild(session_id, workspace_root)

    def build_state(self, session_id: str) -> Literal["idle", "building", "ready"]:
        return self._build_states.get(session_id, "idle")

    def is_ready(self, session_id: str) -> bool:
        return self.build_state(session_id) == "ready" and session_id in self._indexes

    def status(self, session_id: str, workspace_root: Path | str) -> IndexStatus:
        indexed = self._indexes.get(session_id)
        if indexed is not None:
            return indexed.status
        return IndexStatus(
            workspace_root=str(Path(workspace_root).resolve()),
            file_count=0,
            chunk_count=0,
            watching=False,
            embedder=self._embedder.info,
        )

    async def rebuild(
        self,
        session_id: str,
        workspace_root: Path | str,
        *,
        force: bool = False,
    ) -> IndexStatus:
        root = Path(workspace_root).expanduser().resolve()
        self._workspace_roots[session_id] = root
        prior_ready = session_id in self._indexes
        self._build_states[session_id] = "building"
        lock = self._locks.setdefault(session_id, asyncio.Lock())
        try:
            async with lock:
                status = await self._rebuild_locked(session_id, root, force=force)
        except Exception:
            self._build_states[session_id] = "ready" if prior_ready else "idle"
            raise
        self._build_states[session_id] = "ready"
        return status

    async def handle_fs_changed(self, event: object) -> None:
        """Receive one internal ``fs://changed`` event and reset its debounce."""
        if not isinstance(event, WorkspaceFilesChanged) or not event.paths:
            return
        if event.session_id not in self._indexes:
            return
        self._pending_paths.setdefault(event.session_id, set()).update(event.paths)
        previous = self._debounce_tasks.get(event.session_id)
        if previous is not None:
            previous.cancel()
        self._debounce_tasks[event.session_id] = asyncio.create_task(
            self._flush_incremental_after_delay(event.session_id)
        )

    async def close(self) -> None:
        """Cancel pending incremental and lazy-build work during shutdown."""
        tasks = tuple(self._debounce_tasks.values()) + tuple(
            self._background_builds.values()
        )
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._debounce_tasks.clear()
        self._background_builds.clear()
        self._pending_paths.clear()

    async def query_async(
        self,
        session_id: str,
        workspace_root: Path | str,
        query: str,
        top_k: int = 20,
    ) -> list[IndexQueryResult]:
        """Nonblocking retrieval entrypoint used by async gateway callers."""
        self.register_workspace(session_id, workspace_root)
        if not self.is_ready(session_id):
            self._start_background_build(session_id)
            return []
        return await asyncio.to_thread(self.query, session_id, query, top_k)

    def query(
        self, session_id: str, query: str, top_k: int = 20
    ) -> list[IndexQueryResult]:
        indexed = self._indexes.get(session_id)
        if indexed is None:
            self._start_background_build(session_id)
            return []
        if not query.strip() or top_k <= 0:
            return []
        query_embedding = _validate_query_embedding(
            indexed.embedder.embed_query(query), indexed.embedder.info.dim
        )
        ranked = hybrid_rank(
            query,
            bm25_index=indexed.bm25_index,
            embeddings=indexed.embeddings,
            embed_query=lambda _query: query_embedding,
            limit=min(top_k, 50),
        )
        return [
            IndexQueryResult(chunk=indexed.chunks[index], score=score)
            for index, score in ranked
        ]

    def _start_background_build(self, session_id: str) -> None:
        if not self.lazy or self._build_states.get(session_id) != "idle":
            return
        root = self._workspace_roots.get(session_id)
        if root is None:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._build_states[session_id] = "building"

        async def build() -> None:
            try:
                await self.rebuild(session_id, root)
            except asyncio.CancelledError:
                raise
            except Exception:
                # ``rebuild`` publishes index.error and restores the state.
                return
            finally:
                self._background_builds.pop(session_id, None)

        self._background_builds[session_id] = loop.create_task(build())

    async def _rebuild_locked(
        self, session_id: str, root: Path, *, force: bool = False
    ) -> IndexStatus:
        resolved_root = root.expanduser().resolve()
        if not resolved_root.is_dir():
            event = WorkspaceIndexProgress(
                type="index.error",
                session_id=session_id,
                processed_files=0,
                total_files=0,
                indexed_files=0,
                token_count=0,
                message=f"workspace is not a directory: {resolved_root}",
            )
            self.broker.publish(event)
            raise ValueError(event.message)

        loaded: LoadedIndex | None = None
        if self._persistence is not None and not force:
            loaded = await asyncio.to_thread(
                self._persistence.load,
                resolved_root,
                current_embedder=self._embedder.info,
            )
        if loaded is not None:
            indexed = _indexed_from_loaded(resolved_root, loaded, self._embedder)
            self._indexes[session_id] = indexed
            self.broker.publish(
                WorkspaceIndexProgress(
                    type="index.completed",
                    session_id=session_id,
                    processed_files=indexed.status.file_count,
                    total_files=indexed.status.file_count,
                    indexed_files=indexed.status.file_count,
                    token_count=indexed.token_count,
                )
            )
            return indexed.status

        paths = await _discover_files(resolved_root)
        total_files = len(paths)
        processed_files = 0
        indexed_files = 0
        token_count = 0
        chunks: list[IndexChunk] = []
        file_token_counts: dict[str, int] = {}
        self.broker.publish(
            WorkspaceIndexProgress(
                type="index.started",
                session_id=session_id,
                processed_files=0,
                total_files=total_files,
                indexed_files=0,
                token_count=0,
            )
        )

        try:
            for path in paths:
                file_chunks, file_tokens = _index_file(resolved_root, path)
                processed_files += 1
                if file_chunks:
                    indexed_files += 1
                    chunks.extend(file_chunks)
                    token_count += file_tokens
                    file_token_counts[path.relative_to(resolved_root).as_posix()] = (
                        file_tokens
                    )
                self.broker.publish(
                    WorkspaceIndexProgress(
                        type="index.progress",
                        session_id=session_id,
                        processed_files=processed_files,
                        total_files=total_files,
                        indexed_files=indexed_files,
                        token_count=token_count,
                        current_file=path.relative_to(resolved_root).as_posix(),
                    )
                )
                await asyncio.sleep(0)
        except Exception as exc:
            self.broker.publish(
                WorkspaceIndexProgress(
                    type="index.error",
                    session_id=session_id,
                    processed_files=processed_files,
                    total_files=total_files,
                    indexed_files=indexed_files,
                    token_count=token_count,
                    message=str(exc)[:500],
                )
            )
            raise

        documents = [chunk.text for chunk in chunks]
        try:
            raw_embeddings = await asyncio.to_thread(
                self._embedder.embed_documents, documents
            )
            embeddings = _validate_embeddings(
                raw_embeddings,
                expected_count=len(documents),
                expected_dimension=self._embedder.info.dim,
            )
        except Exception as exc:
            self.broker.publish(
                WorkspaceIndexProgress(
                    type="index.error",
                    session_id=session_id,
                    processed_files=processed_files,
                    total_files=total_files,
                    indexed_files=indexed_files,
                    token_count=token_count,
                    message=f"embedding failed: {exc}"[:500],
                )
            )
            raise

        status = IndexStatus(
            workspace_root=str(resolved_root),
            file_count=indexed_files,
            chunk_count=len(chunks),
            last_indexed_at=datetime.now(UTC),
            watching=False,
            embedder=self._embedder.info,
        )
        bm25_index = BM25Index(documents)
        candidate = IndexedWorkspace(
            status=status,
            chunks=tuple(chunks),
            token_count=token_count,
            bm25_index=bm25_index,
            embeddings=embeddings,
            embedder=self._embedder,
            file_token_counts=file_token_counts,
        )
        try:
            await self._persist_snapshot(resolved_root, candidate)
        except Exception as exc:
            self.broker.publish(
                WorkspaceIndexProgress(
                    type="index.error",
                    session_id=session_id,
                    processed_files=processed_files,
                    total_files=total_files,
                    indexed_files=indexed_files,
                    token_count=token_count,
                    message=f"index persistence failed: {exc}"[:500],
                )
            )
            raise
        self._indexes[session_id] = candidate
        self.broker.publish(
            WorkspaceIndexProgress(
                type="index.completed",
                session_id=session_id,
                processed_files=processed_files,
                total_files=total_files,
                indexed_files=indexed_files,
                token_count=token_count,
            )
        )
        return status

    async def _persist_snapshot(
        self, root: Path, indexed: IndexedWorkspace
    ) -> None:
        if self._persistence is None:
            return
        manifest = IndexManifest.create(indexed.embedder.info, len(indexed.chunks))
        await asyncio.to_thread(
            self._persistence.save,
            root,
            indexed.chunks,
            indexed.embeddings,
            indexed.bm25_index,
            manifest,
        )

    async def _flush_incremental_after_delay(self, session_id: str) -> None:
        task = asyncio.current_task()
        paths: tuple[str, ...] = ()
        try:
            await asyncio.sleep(self._debounce_seconds)
            paths = tuple(sorted(self._pending_paths.pop(session_id, set())))
            if paths:
                await self._update_changed_files(session_id, paths)
        except asyncio.CancelledError:
            if paths:
                self._pending_paths.setdefault(session_id, set()).update(paths)
            return
        except Exception:
            return
        finally:
            if self._debounce_tasks.get(session_id) is task:
                self._debounce_tasks.pop(session_id, None)

    async def _update_changed_files(
        self, session_id: str, changed_paths: Sequence[str]
    ) -> None:
        lock = self._locks.setdefault(session_id, asyncio.Lock())
        async with lock:
            indexed = self._indexes.get(session_id)
            if indexed is None:
                return
            root = Path(indexed.status.workspace_root)
            resolved_changes = _resolve_changed_files(root, changed_paths)
            if not resolved_changes:
                return

            self.broker.publish(
                WorkspaceIndexProgress(
                    type="index.started",
                    session_id=session_id,
                    processed_files=0,
                    total_files=len(resolved_changes),
                    indexed_files=indexed.status.file_count,
                    token_count=indexed.token_count,
                )
            )
            try:
                await self._replace_changed_file_chunks(
                    session_id, indexed, root, resolved_changes
                )
            except Exception as exc:
                self.broker.publish(
                    WorkspaceIndexProgress(
                        type="index.error",
                        session_id=session_id,
                        processed_files=0,
                        total_files=len(resolved_changes),
                        indexed_files=indexed.status.file_count,
                        token_count=indexed.token_count,
                        message=f"incremental indexing failed: {exc}"[:500],
                    )
                )
                raise

    async def _replace_changed_file_chunks(
        self,
        session_id: str,
        indexed: IndexedWorkspace,
        root: Path,
        resolved_changes: Mapping[str, Path],
    ) -> None:
        affected = set(resolved_changes)
        retained = [
            (chunk, embedding)
            for chunk, embedding in zip(
                indexed.chunks, indexed.embeddings, strict=True
            )
            if chunk.file not in affected
        ]

        replacement_chunks: list[IndexChunk] = []
        file_token_counts = dict(indexed.file_token_counts)
        for relative, path in resolved_changes.items():
            file_token_counts.pop(relative, None)
            if not _is_indexable_candidate(path):
                continue
            file_chunks, file_tokens = _index_file(root, path)
            if file_chunks:
                replacement_chunks.extend(file_chunks)
                file_token_counts[relative] = file_tokens

        replacement_embeddings = _validate_embeddings(
            await asyncio.to_thread(
                indexed.embedder.embed_documents,
                [chunk.text for chunk in replacement_chunks],
            ),
            expected_count=len(replacement_chunks),
            expected_dimension=indexed.embedder.info.dim,
        )
        combined = retained + list(
            zip(replacement_chunks, replacement_embeddings, strict=True)
        )
        combined.sort(key=lambda item: (item[0].file, item[0].start_line, item[0].id))
        chunks = tuple(chunk for chunk, _embedding in combined)
        embeddings = tuple(embedding for _chunk, embedding in combined)
        token_count = sum(file_token_counts.values())
        status = indexed.status.model_copy(
            update={
                "file_count": len(file_token_counts),
                "chunk_count": len(chunks),
                "last_indexed_at": datetime.now(UTC),
            }
        )

        candidate = IndexedWorkspace(
            status=status,
            chunks=chunks,
            token_count=token_count,
            bm25_index=BM25Index([chunk.text for chunk in chunks]),
            embeddings=embeddings,
            embedder=indexed.embedder,
            file_token_counts=file_token_counts,
        )
        await self._persist_snapshot(root, candidate)
        self._indexes[session_id] = candidate
        self._build_states[session_id] = "ready"
        self.broker.publish(
            WorkspaceIndexProgress(
                type="index.completed",
                session_id=session_id,
                processed_files=len(resolved_changes),
                total_files=len(resolved_changes),
                indexed_files=len(file_token_counts),
                token_count=token_count,
            )
        )


async def _discover_files(root: Path) -> list[Path]:
    paths: list[Path] = []

    def on_error(_error: OSError) -> None:
        return None

    for directory, dirnames, filenames in os.walk(root, onerror=on_error):
        dirnames[:] = sorted(
            name
            for name in dirnames
            if name not in IGNORED_DIR_NAMES and not (Path(directory) / name).is_symlink()
        )
        for name in sorted(filenames):
            path = Path(directory) / name
            if not _is_indexable_candidate(path):
                continue
            paths.append(path)
            if len(paths) >= MAX_INDEX_FILES:
                return paths
        await asyncio.sleep(0)
    return paths


def _resolve_changed_files(
    root: Path, changed_paths: Sequence[str]
) -> dict[str, Path]:
    """Confine changed paths to ``root`` and return workspace-relative keys."""
    resolved_root = root.resolve()
    resolved: dict[str, Path] = {}
    for raw_path in changed_paths:
        candidate = Path(raw_path)
        if not candidate.is_absolute():
            candidate = resolved_root / candidate
        candidate = candidate.resolve(strict=False)
        try:
            relative = candidate.relative_to(resolved_root).as_posix()
        except ValueError:
            continue
        if relative and relative != ".":
            resolved[relative] = candidate
    return resolved


def _is_indexable_candidate(path: Path) -> bool:
    lower_name = path.name.lower()
    if lower_name in _SENSITIVE_FILENAMES or path.is_symlink():
        return False
    if path.suffix.lower() not in _TEXT_SUFFIXES and lower_name not in _TEXT_FILENAMES:
        return False
    try:
        return path.is_file() and path.stat().st_size <= MAX_FILE_BYTES
    except OSError:
        return False


def _index_file(root: Path, path: Path) -> tuple[list[IndexChunk], int]:
    try:
        raw = path.read_bytes()
    except OSError:
        return [], 0
    if b"\0" in raw[:4096]:
        return [], 0
    text = raw.decode("utf-8", errors="replace")
    if not text.strip():
        return [], 0
    relative = path.relative_to(root).as_posix()
    lines = text.splitlines()
    chunks: list[IndexChunk] = []
    step = max(1, CHUNK_LINES - CHUNK_OVERLAP_LINES)
    for start in range(0, len(lines), step):
        selected = lines[start : start + CHUNK_LINES]
        if not selected:
            break
        chunk_text = "\n".join(selected)
        digest = hashlib.sha1(
            f"{relative}:{start}:{chunk_text}".encode()
        ).hexdigest()[:20]
        chunks.append(
            IndexChunk(
                id=digest,
                file=relative,
                start_line=start + 1,
                end_line=start + len(selected),
                text=chunk_text,
            )
        )
        if start + CHUNK_LINES >= len(lines):
            break
    return chunks, len(_TOKEN_RE.findall(text))


def _indexed_from_loaded(
    root: Path, loaded: LoadedIndex, embedder: WorkspaceEmbedder
) -> IndexedWorkspace:
    file_token_counts: dict[str, int] = {}
    for chunk in loaded.chunks:
        file_token_counts[chunk.file] = file_token_counts.get(chunk.file, 0) + len(
            _TOKEN_RE.findall(chunk.text)
        )
    try:
        indexed_at = datetime.fromisoformat(loaded.manifest.created_at)
    except ValueError:
        indexed_at = datetime.now(UTC)
    status = IndexStatus(
        workspace_root=str(root),
        file_count=len(file_token_counts),
        chunk_count=len(loaded.chunks),
        last_indexed_at=indexed_at,
        watching=False,
        embedder=embedder.info,
    )
    return IndexedWorkspace(
        status=status,
        chunks=loaded.chunks,
        token_count=sum(file_token_counts.values()),
        bm25_index=loaded.bm25_index,
        embeddings=loaded.embeddings,
        embedder=embedder,
        file_token_counts=file_token_counts,
    )


def _validate_query_embedding(
    embedding: Sequence[float], expected_dimension: int
) -> tuple[float, ...]:
    row = tuple(float(value) for value in embedding)
    if len(row) != expected_dimension:
        raise ValueError(
            f"query embedder returned dimension {len(row)}; expected {expected_dimension}"
        )
    if any(not math.isfinite(value) for value in row):
        raise ValueError("query embedder returned a non-finite value")
    return row


def _fallback_embedder() -> EmbedderInfo:
    return EmbedderInfo(kind="hash", model=None, dim=256, is_fallback=True)


def _validate_embeddings(
    embeddings: Sequence[Sequence[float]],
    *,
    expected_count: int,
    expected_dimension: int,
) -> tuple[tuple[float, ...], ...]:
    rows = tuple(tuple(float(value) for value in row) for row in embeddings)
    if len(rows) != expected_count:
        raise ValueError(
            f"embedder returned {len(rows)} vectors for {expected_count} documents"
        )
    for row in rows:
        if len(row) != expected_dimension:
            raise ValueError(
                f"embedder returned dimension {len(row)}; expected {expected_dimension}"
            )
        if any(not math.isfinite(value) for value in row):
            raise ValueError("embedder returned a non-finite value")
    return rows


def _hash_embedding(text: str, dimension: int) -> tuple[float, ...]:
    tokens = [
        token.lower()
        for token in _TOKEN_RE.findall(text)
        if len(token) > 1 and any(character.isalnum() for character in token)
    ]
    if not tokens:
        return (0.0,) * dimension

    features = tokens + [
        f"{left}\0{right}" for left, right in itertools.pairwise(tokens)
    ]
    vector = [0.0] * dimension
    for feature, frequency in Counter(features).items():
        digest = hashlib.blake2b(feature.encode("utf-8"), digest_size=8).digest()
        bucket = int.from_bytes(digest[:4], "little") % dimension
        sign = 1.0 if digest[4] & 1 else -1.0
        vector[bucket] += sign * (1.0 + math.log(frequency))
    norm = math.sqrt(sum(value * value for value in vector))
    if norm == 0.0:
        return (0.0,) * dimension
    return tuple(value / norm for value in vector)
