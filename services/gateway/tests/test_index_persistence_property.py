"""Persistence properties for the Advanced Context Engine semantic index."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from hypothesis import given, settings
from hypothesis import strategies as st
from shared_schema.models import EmbedderInfo, IndexChunk
from zocai_gateway.context.index_store import (
    BM25_FILE,
    CHUNKS_FILE,
    EMBEDDINGS_FILE,
    INDEX_SCHEMA_VERSION,
    MANIFEST_FILE,
    IndexManifest,
    IndexPersistence,
    workspace_hash,
)
from zocai_gateway.context.rag_matcher import BM25Index

_SAFE_SEGMENT = st.text(
    alphabet=st.characters(whitelist_categories=("Ll", "Lu", "Nd")),
    min_size=1,
    max_size=24,
)


@settings(max_examples=100, deadline=None)
@given(segment=_SAFE_SEGMENT)
def test_workspace_hash_is_deterministic_for_absolute_path(segment: str) -> None:
    """Feature: advanced-context-engine, Property 1: workspace hash determinism.

    **Validates: Requirements 2.1**
    """
    with tempfile.TemporaryDirectory() as temp:
        base = Path(temp)
        canonical = base / segment
        equivalent = base / "spelling" / ".." / segment
        distinct = base / f"{segment}-distinct"

        digest = workspace_hash(canonical)
        assert digest == workspace_hash(equivalent)
        assert digest != workspace_hash(distinct)
        assert len(digest) == 32
        assert set(digest) <= set("0123456789abcdef")


@settings(max_examples=100, deadline=None)
@given(dimension=st.integers(min_value=1, max_value=8), count=st.integers(0, 5))
def test_every_persisted_artifact_is_confined(
    dimension: int, count: int
) -> None:
    """Feature: advanced-context-engine, Property 3: persisted-file confinement.

    **Validates: Requirements 2.4**
    """
    with tempfile.TemporaryDirectory() as temp:
        base = Path(temp)
        indices_root = base / "indices"
        workspace = base / "workspace"
        store = IndexPersistence(indices_root)
        info = EmbedderInfo(kind="test", model="deterministic", dim=dimension)
        chunks = tuple(
            IndexChunk(
                id=f"chunk-{index}",
                file=f"src/{index}.py",
                start_line=1,
                end_line=1,
                text=f"document {index}",
            )
            for index in range(count)
        )
        embeddings = tuple(
            tuple(float(index + column) for column in range(dimension))
            for index in range(count)
        )
        store.save(
            workspace,
            chunks,
            embeddings,
            BM25Index([chunk.text for chunk in chunks]),
            IndexManifest.create(info, count),
        )

        resolved_root = indices_root.resolve()
        paths = store.artifact_paths(workspace)
        assert {path.name for path in paths} == {
            EMBEDDINGS_FILE,
            BM25_FILE,
            CHUNKS_FILE,
            MANIFEST_FILE,
        }
        for path in paths:
            assert path.exists()
            path.resolve().relative_to(resolved_root)


_GATE_CASES = st.sampled_from(
    [
        "valid",
        "schema-mismatch",
        "embedder-mismatch",
        "missing-artifact",
        "bad-manifest",
        "bad-chunks",
        "bad-embeddings",
        "bad-bm25",
    ]
)


@settings(max_examples=100, deadline=None)
@given(case=_GATE_CASES, dimension=st.integers(min_value=1, max_value=6))
def test_load_gate_requires_matching_schema_embedder_and_valid_artifacts(
    case: str, dimension: int
) -> None:
    """Feature: advanced-context-engine, Property 5: load-vs-rebuild gate.

    **Validates: Requirements 2.5, 2.6, 2.7**
    """
    with tempfile.TemporaryDirectory() as temp:
        base = Path(temp)
        workspace = base / "workspace"
        store = IndexPersistence(base / "indices")
        info = EmbedderInfo(kind="test", model="gate", dim=dimension)
        chunk = IndexChunk(
            id="chunk",
            file="main.py",
            start_line=1,
            end_line=1,
            text="searchable document",
        )
        store.save(
            workspace,
            (chunk,),
            (tuple(float(column + 1) for column in range(dimension)),),
            BM25Index([chunk.text]),
            IndexManifest.create(info, 1),
        )
        directory = store.dir_for(workspace)
        current = info

        if case == "schema-mismatch":
            path = directory / MANIFEST_FILE
            payload = json.loads(path.read_text(encoding="utf-8"))
            payload["schema_version"] = INDEX_SCHEMA_VERSION + 1
            path.write_text(json.dumps(payload), encoding="utf-8")
        elif case == "embedder-mismatch":
            current = info.model_copy(update={"model": "different"})
        elif case == "missing-artifact":
            (directory / CHUNKS_FILE).unlink()
        elif case == "bad-manifest":
            (directory / MANIFEST_FILE).write_text("{", encoding="utf-8")
        elif case == "bad-chunks":
            (directory / CHUNKS_FILE).write_text("{}", encoding="utf-8")
        elif case == "bad-embeddings":
            (directory / EMBEDDINGS_FILE).write_bytes(b"not-a-numpy-array")
        elif case == "bad-bm25":
            (directory / BM25_FILE).write_bytes(b"not-a-pickle")

        loaded = store.load(workspace, current_embedder=current)
        if case == "valid":
            assert loaded is not None
            assert loaded.chunks == (chunk,)
            assert loaded.manifest.schema_version == INDEX_SCHEMA_VERSION
            assert loaded.manifest.embedder == info
        else:
            assert loaded is None
