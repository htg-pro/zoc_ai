"""High-level indexer API used by the agent and v1 routes."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
from datetime import UTC, datetime
from fnmatch import fnmatch
from pathlib import Path

from shared_schema.models import EmbedderInfo, IndexChunk, IndexQueryResult, IndexStatus

from .. import hotpath
from .embeddings import Embedder, HashEmbedder, ResilientEmbedder
from .store import VectorStore

# Files larger than this are skipped to keep chunk counts sane.
_MAX_BYTES = 256 * 1024
_BINARY_EXTS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".pdf",
    ".zip", ".tar", ".gz", ".7z", ".rar", ".bin", ".so", ".dll", ".dylib",
    ".exe", ".class", ".jar", ".woff", ".woff2", ".ttf", ".otf", ".mp3",
    ".mp4", ".webm", ".mov", ".avi", ".wav", ".sqlite", ".sqlite3", ".db",
}


def _chunk_id(file: str, start: int, end: int) -> str:
    return hashlib.blake2b(f"{file}:{start}:{end}".encode(), digest_size=12).hexdigest()


class IndexerService:
    def __init__(
        self,
        *,
        workspace_root: str,
        store: VectorStore,
        embedder: Embedder | None = None,
        exclude_globs: list[str] | None = None,
    ) -> None:
        self.workspace_root = str(Path(workspace_root).resolve())
        self.store = store
        self.embedder = embedder or HashEmbedder()
        self._watcher_task: asyncio.Task | None = None
        self._last_indexed_at: datetime | None = None
        # Exclusion patterns (glob/dir-name) for indexing. When not given
        # explicitly, restore whatever was last persisted for this store so
        # the setting survives indexer rebuilds and process restarts.
        if exclude_globs is None:
            self.exclude_globs = self._load_exclude_globs()
        else:
            self.exclude_globs = [g.strip() for g in exclude_globs if g.strip()]
            self._persist_exclude_globs()
        # If the embedding signature changed between runs the stored vectors
        # are incompatible with new queries (different dim or different
        # semantic space). Drop them so the next reindex starts clean.
        signature = self.embedder.signature
        prev_signature = store.get_meta("embedding_signature")
        cleared = False
        if prev_signature and prev_signature != signature:
            store.clear_all()
            store.set_meta("last_indexed_at", "")
            cleared = True
        store.set_meta("embedding_signature", signature)
        if not cleared:
            meta = store.get_meta("last_indexed_at")
            if meta:
                try:
                    self._last_indexed_at = datetime.fromisoformat(meta)
                except ValueError:
                    self._last_indexed_at = None
        # If the embedder can degrade to a fallback at runtime (e.g. cloud
        # provider goes down), make sure we wipe stale vectors so the new
        # embedding space isn't mixed with the old one.
        if isinstance(self.embedder, ResilientEmbedder):
            self.embedder.on_degrade = self._on_embedder_degrade

    # ── public API ──────────────────────────────────────────────────────

    async def reindex(self, *, max_files: int | None = None) -> IndexStatus:
        self.store.clear_all()
        files = hotpath.index_walk(self.workspace_root, max_files=max_files)
        for entry in files:
            await self._index_file(entry["path"])
        self._last_indexed_at = datetime.now(UTC)
        self.store.set_meta("last_indexed_at", self._last_indexed_at.isoformat())
        return self.status()

    async def index_file(self, path: str) -> None:
        await self._index_file(path)
        self._last_indexed_at = datetime.now(UTC)
        self.store.set_meta("last_indexed_at", self._last_indexed_at.isoformat())

    async def remove_file(self, path: str) -> None:
        self.store.clear_file(path)

    async def query(self, query: str, *, top_k: int = 8) -> list[IndexQueryResult]:
        vec = (await self.embedder.embed([query]))[0]
        hits = self.store.query(vec, top_k=top_k)
        out: list[IndexQueryResult] = []
        for score, row in hits:
            out.append(
                IndexQueryResult(
                    chunk=IndexChunk(
                        id=row["id"],
                        file=row["file"],
                        start_line=row["start_line"],
                        end_line=row["end_line"],
                        symbol=row["symbol"],
                        text=row["text"],
                    ),
                    score=float(score),
                )
            )
        return out

    def status(self) -> IndexStatus:
        return IndexStatus(
            workspace_root=self.workspace_root,
            file_count=self.store.file_count(),
            chunk_count=self.store.count(),
            last_indexed_at=self._last_indexed_at,
            watching=self._watcher_task is not None and not self._watcher_task.done(),
            embedder=self._embedder_info(),
        )

    def _embedder_info(self) -> EmbedderInfo:
        emb = self.embedder
        return EmbedderInfo(
            kind=str(emb.kind),
            model=emb.model,
            dim=int(emb.dim),
            is_fallback=bool(emb.is_fallback),
        )

    async def start_watcher(self) -> None:
        self.store.set_meta("watch_enabled", "1")
        if self._watcher_task and not self._watcher_task.done():
            return
        self._watcher_task = asyncio.create_task(self._run_watcher())

    async def stop_watcher(self) -> None:
        self.store.set_meta("watch_enabled", "0")
        if self._watcher_task and not self._watcher_task.done():
            self._watcher_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._watcher_task
        self._watcher_task = None

    @property
    def watch_preference(self) -> bool:
        """Whether the user last asked for watching to be on. Persisted so the
        UI shows the saved choice and watchers can resume after a rebuild."""

        return self.store.get_meta("watch_enabled") == "1"

    def set_exclude_globs(self, globs: list[str]) -> None:
        self.exclude_globs = [g.strip() for g in globs if g.strip()]
        self._persist_exclude_globs()

    # ── internals ───────────────────────────────────────────────────────

    def _load_exclude_globs(self) -> list[str]:
        raw = self.store.get_meta("exclude_globs")
        if not raw:
            return []
        try:
            parsed = json.loads(raw)
        except ValueError:
            return []
        if not isinstance(parsed, list):
            return []
        return [str(g).strip() for g in parsed if str(g).strip()]

    def _persist_exclude_globs(self) -> None:
        self.store.set_meta("exclude_globs", json.dumps(self.exclude_globs))

    def _is_excluded(self, rel: str) -> bool:
        if not self.exclude_globs:
            return False
        parts = Path(rel).parts
        for pat in self.exclude_globs:
            p = pat.strip().rstrip("/")
            if not p:
                continue
            # Match the whole relative path (e.g. "src/*.test.ts") …
            if fnmatch(rel, p):
                return True
            # … or any single path segment, so a bare directory/file name
            # like "node_modules" or "*.log" excludes it anywhere in the tree.
            if any(fnmatch(part, p) for part in parts):
                return True
        return False

    async def _index_file(self, path: str) -> None:
        p = Path(path)
        if not p.is_file():
            return
        try:
            relative = p.resolve().relative_to(self.workspace_root)
        except ValueError:
            return
        if self._is_excluded(str(relative)):
            return
        if p.suffix.lower() in _BINARY_EXTS:
            return
        try:
            if p.stat().st_size > _MAX_BYTES:
                return
        except OSError:
            return
        try:
            chunks = hotpath.chunk_file(str(p))
        except Exception:
            return
        if not chunks:
            return
        texts = [c["text"] for c in chunks]
        vectors = await self.embedder.embed(texts)
        rows = []
        rel = str(relative)
        self.store.clear_file(rel)
        for c, v in zip(chunks, vectors, strict=False):
            rows.append(
                {
                    "id": _chunk_id(rel, c["start_line"], c["end_line"]),
                    "file": rel,
                    "start_line": int(c["start_line"]),
                    "end_line": int(c["end_line"]),
                    "symbol": c.get("symbol"),
                    "text": c["text"],
                    "vector": v,
                }
            )
        self.store.upsert(rows)

    def _on_embedder_degrade(self, new_signature: str) -> None:
        # Wipe any vectors written under the previous embedding space and
        # force a fresh reindex against the fallback model.
        self.store.clear_all()
        self.store.set_meta("embedding_signature", new_signature)
        self.store.set_meta("last_indexed_at", "")
        self._last_indexed_at = None

    async def _run_watcher(self) -> None:
        try:
            async for event in hotpath.stream_watch(self.workspace_root):
                path = event.get("path")
                kind = event.get("kind")
                if not path:
                    continue
                if kind in {"removed", "renamed"}:
                    await self.remove_file(path)
                elif kind in {"created", "modified", "other"}:
                    await self.index_file(path)
        except asyncio.CancelledError:
            raise
        except Exception:
            return
