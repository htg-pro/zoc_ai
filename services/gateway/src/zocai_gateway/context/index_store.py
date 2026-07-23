"""Versioned, workspace-keyed persistence for the semantic index.

The cache is local user-owned state under ``~/.zoc-studio/indices``.  A
manifest gate is checked before the pickled BM25 object is loaded; callers must
still treat the directory as trusted local cache rather than an untrusted data
boundary.
"""

from __future__ import annotations

import contextlib
import hashlib
import importlib
import json
import math
import os
import pickle
import tempfile
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from shared_schema.models import EmbedderInfo, IndexChunk

from zocai_gateway.context.rag_matcher import BM25Index

np: Any = importlib.import_module("numpy")

__all__ = [
    "BM25_FILE",
    "CHUNKS_FILE",
    "EMBEDDINGS_FILE",
    "INDEX_SCHEMA_VERSION",
    "INDICES_ROOT",
    "MANIFEST_FILE",
    "IndexManifest",
    "IndexPersistence",
    "LoadedIndex",
    "workspace_hash",
]

INDICES_ROOT = Path.home() / ".zoc-studio" / "indices"
INDEX_SCHEMA_VERSION = 1
EMBEDDINGS_FILE = "embeddings.npy"
BM25_FILE = "bm25.pkl"
CHUNKS_FILE = "chunks.json"
MANIFEST_FILE = "manifest.json"
_ARTIFACT_FILES = (EMBEDDINGS_FILE, BM25_FILE, CHUNKS_FILE, MANIFEST_FILE)


def workspace_hash(workspace_root: Path | str) -> str:
    """Return the stable 128-bit hex identifier for an absolute workspace path."""
    absolute = str(Path(workspace_root).expanduser().resolve())
    return hashlib.sha256(absolute.encode("utf-8")).hexdigest()[:32]


@dataclass(frozen=True, slots=True)
class IndexManifest:
    """Version and embedder identity needed to decide whether a cache is reusable."""

    schema_version: int
    embedder: EmbedderInfo
    chunk_count: int
    created_at: str

    @classmethod
    def create(cls, embedder: EmbedderInfo, chunk_count: int) -> IndexManifest:
        return cls(
            schema_version=INDEX_SCHEMA_VERSION,
            embedder=embedder,
            chunk_count=chunk_count,
            created_at=datetime.now(UTC).isoformat(),
        )

    def to_json(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "embedder": self.embedder.model_dump(mode="json", by_alias=True),
            "chunk_count": self.chunk_count,
            "created_at": self.created_at,
        }

    @classmethod
    def from_json(cls, value: object) -> IndexManifest:
        if not isinstance(value, dict):
            raise ValueError("manifest must be a JSON object")
        schema_version = value.get("schema_version")
        chunk_count = value.get("chunk_count")
        created_at = value.get("created_at")
        if type(schema_version) is not int or schema_version < 0:
            raise ValueError("invalid schema_version")
        if type(chunk_count) is not int or chunk_count < 0:
            raise ValueError("invalid chunk_count")
        if not isinstance(created_at, str) or not created_at:
            raise ValueError("invalid created_at")
        return cls(
            schema_version=schema_version,
            embedder=EmbedderInfo.model_validate(value.get("embedder")),
            chunk_count=chunk_count,
            created_at=created_at,
        )


@dataclass(frozen=True, slots=True)
class LoadedIndex:
    """A validated persisted snapshot with positional chunk/vector alignment."""

    chunks: tuple[IndexChunk, ...]
    embeddings: tuple[tuple[float, ...], ...]
    bm25_index: BM25Index
    manifest: IndexManifest


class IndexPersistence:
    """Atomically save and defensively load one cache directory per workspace."""

    def __init__(self, indices_root: Path | str = INDICES_ROOT) -> None:
        self.indices_root = Path(indices_root).expanduser().resolve(strict=False)

    def dir_for(self, workspace_root: Path | str) -> Path:
        """Return the lexical cache directory derived only from ``workspace_hash``."""
        return self.indices_root / workspace_hash(workspace_root)

    def artifact_paths(self, workspace_root: Path | str) -> tuple[Path, ...]:
        """Return all fixed artifact paths, rejecting a symlink escape."""
        directory = self._validated_directory(workspace_root, create=False)
        return tuple(self._artifact_path(directory, name) for name in _ARTIFACT_FILES)

    def save(
        self,
        workspace_root: Path | str,
        chunks: Sequence[IndexChunk],
        embeddings: Sequence[Sequence[float]],
        bm25_index: BM25Index,
        manifest: IndexManifest,
    ) -> None:
        """Write a coherent snapshot with the manifest replaced last.

        Every individual artifact is fsynced and atomically replaced.  The
        manifest is the commit marker, so readers never consider a new snapshot
        until the data artifacts have reached their final names.
        """
        directory = self._validated_directory(workspace_root, create=True)
        chunk_rows = tuple(chunks)
        matrix = np.asarray(embeddings)
        if manifest.schema_version != INDEX_SCHEMA_VERSION:
            raise ValueError("cannot persist an unsupported index schema")
        if manifest.chunk_count != len(chunk_rows):
            raise ValueError("manifest chunk count does not match chunks")
        if bm25_index.document_count != len(chunk_rows):
            raise ValueError("BM25 document count does not match chunks")
        if len(chunk_rows) == 0:
            matrix = np.empty((0, manifest.embedder.dim), dtype=np.float64)
        if matrix.ndim != 2 or matrix.shape != (
            len(chunk_rows),
            manifest.embedder.dim,
        ):
            raise ValueError("embedding matrix shape does not match manifest")
        if not np.isfinite(matrix).all():
            raise ValueError("embedding matrix contains non-finite values")

        embeddings_path = self._artifact_path(directory, EMBEDDINGS_FILE)
        bm25_path = self._artifact_path(directory, BM25_FILE)
        chunks_path = self._artifact_path(directory, CHUNKS_FILE)
        manifest_path = self._artifact_path(directory, MANIFEST_FILE)

        self._atomic_binary(embeddings_path, lambda handle: np.save(handle, matrix))
        self._atomic_binary(
            bm25_path,
            lambda handle: pickle.dump(
                bm25_index, handle, protocol=pickle.HIGHEST_PROTOCOL
            ),
        )
        chunk_payload = [chunk.model_dump(mode="json", by_alias=True) for chunk in chunk_rows]
        self._atomic_text(
            chunks_path,
            json.dumps(chunk_payload, ensure_ascii=False, separators=(",", ":")),
        )
        self._atomic_text(
            manifest_path,
            json.dumps(manifest.to_json(), ensure_ascii=False, separators=(",", ":")),
        )

    def load(
        self,
        workspace_root: Path | str,
        *,
        current_embedder: EmbedderInfo,
    ) -> LoadedIndex | None:
        """Return a fully validated snapshot, or ``None`` for every cache miss.

        Missing, malformed, mismatched, symlink-escaped, and otherwise corrupt
        artifacts are all normal cache misses and never escape to the caller.
        """
        try:
            directory = self._validated_directory(workspace_root, create=False)
            manifest_path = self._artifact_path(directory, MANIFEST_FILE)
            manifest = IndexManifest.from_json(
                json.loads(manifest_path.read_text(encoding="utf-8"))
            )
            if manifest.schema_version != INDEX_SCHEMA_VERSION:
                return None
            if manifest.embedder != current_embedder:
                return None

            chunks_path = self._artifact_path(directory, CHUNKS_FILE)
            chunks_value: Any = json.loads(chunks_path.read_text(encoding="utf-8"))
            if not isinstance(chunks_value, list):
                return None
            chunks = tuple(IndexChunk.model_validate(value) for value in chunks_value)
            if len(chunks) != manifest.chunk_count:
                return None

            embeddings_path = self._artifact_path(directory, EMBEDDINGS_FILE)
            with embeddings_path.open("rb") as handle:
                matrix = np.load(handle, allow_pickle=False)
            if matrix.ndim != 2 or matrix.shape != (
                manifest.chunk_count,
                current_embedder.dim,
            ):
                return None
            embeddings = tuple(
                tuple(float(value) for value in row.tolist()) for row in matrix
            )
            if any(
                not math.isfinite(value)
                for row in embeddings
                for value in row
            ):
                return None

            bm25_path = self._artifact_path(directory, BM25_FILE)
            with bm25_path.open("rb") as handle:
                bm25_index = pickle.load(handle)
            if not isinstance(bm25_index, BM25Index):
                return None
            if bm25_index.document_count != manifest.chunk_count:
                return None
            return LoadedIndex(
                chunks=chunks,
                embeddings=embeddings,
                bm25_index=bm25_index,
                manifest=manifest,
            )
        except Exception:
            return None

    def _validated_directory(
        self, workspace_root: Path | str, *, create: bool
    ) -> Path:
        root = self.indices_root
        if create:
            root.mkdir(parents=True, exist_ok=True)
        if not root.is_dir():
            raise FileNotFoundError(root)
        resolved_root = root.resolve(strict=True)
        directory = resolved_root / workspace_hash(workspace_root)
        if directory.exists() and directory.is_symlink():
            raise ValueError("index directory must not be a symlink")
        if create:
            directory.mkdir(mode=0o700, parents=False, exist_ok=True)
        resolved_directory = directory.resolve(strict=True)
        resolved_directory.relative_to(resolved_root)
        return resolved_directory

    def _artifact_path(self, directory: Path, name: str) -> Path:
        if name not in _ARTIFACT_FILES:
            raise ValueError(f"unknown index artifact: {name}")
        path = directory / name
        resolved = path.resolve(strict=False)
        resolved.relative_to(self.indices_root.resolve(strict=True))
        if path.exists() and path.is_symlink():
            raise ValueError("index artifact must not be a symlink")
        return path

    @staticmethod
    def _atomic_text(path: Path, content: str) -> None:
        IndexPersistence._atomic_binary(
            path, lambda handle: handle.write(content.encode("utf-8"))
        )

    @staticmethod
    def _atomic_binary(path: Path, write: Callable[[Any], object]) -> None:
        temp_name: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w+b", dir=path.parent, prefix=f".{path.name}.", delete=False
            ) as handle:
                temp_name = handle.name
                write(handle)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, path)
            temp_name = None
        finally:
            if temp_name is not None:
                with contextlib.suppress(FileNotFoundError):
                    os.unlink(temp_name)
