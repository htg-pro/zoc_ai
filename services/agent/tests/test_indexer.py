import pytest
from llama_studio_agent.config import Settings
from llama_studio_agent.indexer import embeddings as _emb
from llama_studio_agent.indexer.embeddings import (
    HashEmbedder,
    ProviderEmbedder,
    ResilientEmbedder,
    hash_embed,
    resolve_embedder,
)
from llama_studio_agent.indexer.service import IndexerService
from llama_studio_agent.indexer.store import VectorStore
from llama_studio_agent.providers import build_default_registry
from llama_studio_agent.providers.base import ProviderError


def test_hash_embed_deterministic():
    a = hash_embed("hello world", 64)
    b = hash_embed("hello world", 64)
    assert a == b
    assert len(a) == 64
    assert sum(x * x for x in a) == pytest.approx(1.0, abs=1e-4)


def test_vector_store_query(tmp_path):
    store = VectorStore(tmp_path / "v.sqlite")
    rows = [
        {"id": "1", "file": "a.py", "start_line": 1, "end_line": 5,
         "symbol": "alpha", "text": "alpha alpha alpha", "vector": hash_embed("alpha", 64)},
        {"id": "2", "file": "b.py", "start_line": 1, "end_line": 5,
         "symbol": "beta", "text": "beta beta beta", "vector": hash_embed("beta", 64)},
    ]
    store.upsert(rows)
    assert store.count() == 2
    hits = store.query(hash_embed("alpha", 64), top_k=2)
    assert hits[0][1]["id"] == "1"
    assert hits[0][0] > hits[1][0]


@pytest.mark.asyncio
async def test_indexer_query_uses_hotpath(tmp_workspace, tmp_path, monkeypatch):
    """Skip if hotpath binary isn't built — the orchestrator/indexer integration
    is exercised via the same service-level test below using a stubbed chunker."""

    import llama_studio_agent.indexer.service as svc

    # Stub out hotpath calls to avoid depending on the compiled CLI.
    def fake_walk(path, max_files=None):
        return [{"path": str(tmp_workspace / "src" / "hello.py"), "bytes": 10}]

    def fake_chunk(path):
        return [{
            "file": path,
            "start_line": 1,
            "end_line": 2,
            "symbol": "greet",
            "text": "def greet(name): return name",
        }]

    monkeypatch.setattr(svc.hotpath, "index_walk", fake_walk)
    monkeypatch.setattr(svc.hotpath, "chunk_file", fake_chunk)

    indexer = IndexerService(
        workspace_root=str(tmp_workspace),
        store=VectorStore(tmp_path / "idx.sqlite"),
        embedder=HashEmbedder(64),
    )
    status = await indexer.reindex()
    assert status.chunk_count == 1
    hits = await indexer.query("greet")
    assert hits
    assert hits[0].chunk.symbol == "greet"


class _StubProvider:
    kind = "openai"

    def __init__(self, dim: int = 4) -> None:
        self.dim = dim
        self.calls: list[tuple[list[str], str]] = []

    async def embed(self, texts, *, model):
        self.calls.append((list(texts), model))
        return [[float(len(t)), 1.0, 0.0, 0.0][: self.dim] for t in texts]


@pytest.mark.asyncio
async def test_provider_embedder_normalises_vectors():
    emb = ProviderEmbedder(_StubProvider(), model="text-embedding-3-small", dim=4)
    [v] = await emb.embed(["hello"])
    import math as _m

    assert _m.isclose(sum(x * x for x in v), 1.0, abs_tol=1e-6)
    assert emb.signature == "openai:text-embedding-3-small:4"


def test_resolve_embedder_auto_prefers_local_llamacpp(monkeypatch):
    monkeypatch.setattr(_emb, "_probe_llamacpp_embed_model", lambda *a, **k: "nomic-embed-text")
    settings = Settings(openai_api_key="sk-test")  # would otherwise pick OpenAI
    registry = build_default_registry(settings)
    emb = resolve_embedder(settings, registry)
    assert isinstance(emb, ResilientEmbedder)
    assert isinstance(emb.primary, ProviderEmbedder)
    assert emb.primary.provider.kind == "llamacpp"
    assert emb.primary.model == "nomic-embed-text"


def test_resolve_embedder_auto_uses_openai_when_llamacpp_absent(monkeypatch):
    monkeypatch.setattr(_emb, "_probe_llamacpp_embed_model", lambda *a, **k: None)
    settings = Settings(openai_api_key="sk-test")
    registry = build_default_registry(settings)
    emb = resolve_embedder(settings, registry)
    assert isinstance(emb, ResilientEmbedder)
    assert isinstance(emb.primary, ProviderEmbedder)
    assert emb.primary.provider.kind == "openai"
    assert emb.primary.model == "text-embedding-3-small"
    assert emb.primary.dim == 1536


def test_resolve_embedder_falls_back_to_hash_when_nothing_available(monkeypatch):
    monkeypatch.setattr(_emb, "_probe_llamacpp_embed_model", lambda *a, **k: None)
    settings = Settings()
    registry = build_default_registry(settings)
    emb = resolve_embedder(settings, registry)
    assert isinstance(emb, HashEmbedder)
    assert emb.signature.startswith("hash:")


def test_resolve_embedder_honours_explicit_provider():
    settings = Settings(embedding_provider="llamacpp")
    registry = build_default_registry(settings)
    emb = resolve_embedder(settings, registry)
    assert isinstance(emb, ResilientEmbedder)
    assert emb.primary.provider.kind == "llamacpp"  # type: ignore[union-attr]
    assert emb.primary.model == "nomic-embed-text"  # type: ignore[union-attr]


@pytest.mark.asyncio
async def test_status_reports_hash_fallback_embedder(tmp_path):
    indexer = IndexerService(
        workspace_root=str(tmp_path),
        store=VectorStore(tmp_path / "v.sqlite"),
        embedder=HashEmbedder(64),
    )
    info = indexer.status().embedder
    assert info is not None
    assert info.kind == "hash"
    assert info.model is None
    assert info.dim == 64
    assert info.is_fallback is True


@pytest.mark.asyncio
async def test_status_reports_provider_embedder(tmp_path):
    emb = ProviderEmbedder(_StubProvider(), model="text-embedding-3-small", dim=4)
    indexer = IndexerService(
        workspace_root=str(tmp_path),
        store=VectorStore(tmp_path / "v.sqlite"),
        embedder=emb,
    )
    info = indexer.status().embedder
    assert info is not None
    assert info.kind == "openai"
    assert info.model == "text-embedding-3-small"
    assert info.dim == 4
    assert info.is_fallback is False


@pytest.mark.asyncio
async def test_status_embedder_reflects_resilient_degrade(tmp_path):
    primary = ProviderEmbedder(_FlakyProvider(), model="text-embedding-3-small", dim=8)
    emb = ResilientEmbedder(primary, HashEmbedder(8))
    indexer = IndexerService(
        workspace_root=str(tmp_path),
        store=VectorStore(tmp_path / "v.sqlite"),
        embedder=emb,
    )
    before = indexer.status().embedder
    assert before is not None and before.kind == "openai" and before.is_fallback is False
    # Force a query so the resilient embedder degrades to the hash fallback.
    await indexer.query("hello")
    after = indexer.status().embedder
    assert after is not None
    assert after.kind == "hash"
    assert after.is_fallback is True
    assert after.dim == 8


def test_resolve_embedder_explicit_hash():
    settings = Settings(embedding_provider="hash", openai_api_key="sk-test", embedding_dim=128)
    registry = build_default_registry(settings)
    emb = resolve_embedder(settings, registry)
    assert isinstance(emb, HashEmbedder)
    assert emb.dim == 128


class _FlakyProvider:
    kind = "openai"

    async def embed(self, texts, *, model):
        raise ProviderError("boom")


@pytest.mark.asyncio
async def test_resilient_embedder_degrades_on_provider_failure():
    primary = ProviderEmbedder(_FlakyProvider(), model="text-embedding-3-small", dim=8)
    emb = ResilientEmbedder(primary, HashEmbedder(8))
    out = await emb.embed(["hello"])
    assert emb.degraded
    assert emb.signature == "hash:8"
    assert len(out) == 1 and len(out[0]) == 8
    # Subsequent calls keep using the fallback (provider not retried).
    out2 = await emb.embed(["world"])
    assert len(out2[0]) == 8


@pytest.mark.asyncio
async def test_indexer_wipes_store_when_embedder_degrades(tmp_path):
    store = VectorStore(tmp_path / "v.sqlite")
    store.upsert([
        {
            "id": "1", "file": "a.py", "start_line": 1, "end_line": 5,
            "symbol": "alpha", "text": "alpha",
            "vector": hash_embed("alpha", 8),
        }
    ])
    primary = ProviderEmbedder(_FlakyProvider(), model="text-embedding-3-small", dim=8)
    emb = ResilientEmbedder(primary, HashEmbedder(8))
    indexer = IndexerService(workspace_root=str(tmp_path), store=store, embedder=emb)
    # Pre-degrade: signature stored is the primary's.
    assert store.get_meta("embedding_signature") == "openai:text-embedding-3-small:8"
    assert store.count() == 1
    # Trigger failure → indexer should clear stale vectors via the callback.
    await indexer.query("alpha")
    assert emb.degraded
    assert store.count() == 0
    assert store.get_meta("embedding_signature") == "hash:8"


def test_probe_llamacpp_embed_model_picks_preferred(monkeypatch):
    class _Resp:
        def raise_for_status(self): pass
        def json(self): return {"data": [{"id": "llama3"}, {"id": "nomic-embed-text"}]}

    monkeypatch.setattr(_emb.httpx, "get", lambda *a, **k: _Resp())
    assert _emb._probe_llamacpp_embed_model("http://x") == "nomic-embed-text"


def test_probe_llamacpp_embed_model_returns_none_on_network_error(monkeypatch):
    import httpx as _httpx

    def _raise(*a, **k):
        raise _httpx.ConnectError("nope")

    monkeypatch.setattr(_emb.httpx, "get", _raise)
    assert _emb._probe_llamacpp_embed_model("http://x") is None


def test_is_excluded_matches_dir_names_and_globs(tmp_path):
    indexer = IndexerService(
        workspace_root=str(tmp_path),
        store=VectorStore(tmp_path / "v.sqlite"),
        embedder=HashEmbedder(64),
        exclude_globs=["node_modules", "*.log", "dist/"],
    )
    assert indexer._is_excluded("node_modules/pkg/index.js") is True
    assert indexer._is_excluded("src/app.log") is True
    assert indexer._is_excluded("dist/bundle.js") is True
    assert indexer._is_excluded("src/app.py") is False


def test_exclude_globs_persist_and_reload(tmp_path):
    store = VectorStore(tmp_path / "v.sqlite")
    first = IndexerService(
        workspace_root=str(tmp_path), store=store, embedder=HashEmbedder(64)
    )
    first.set_exclude_globs(["node_modules", "*.lock"])
    # A fresh service over the same store restores the persisted patterns.
    second = IndexerService(
        workspace_root=str(tmp_path), store=VectorStore(tmp_path / "v.sqlite"),
        embedder=HashEmbedder(64),
    )
    assert second.exclude_globs == ["node_modules", "*.lock"]


@pytest.mark.asyncio
async def test_reindex_skips_excluded_files(tmp_workspace, tmp_path, monkeypatch):
    import llama_studio_agent.indexer.service as svc

    keep = tmp_workspace / "src" / "hello.py"
    skip = tmp_workspace / "node_modules" / "dep.py"
    skip.parent.mkdir(parents=True, exist_ok=True)
    skip.write_text("def dep(): return 1\n", encoding="utf-8")

    def fake_walk(path, max_files=None):
        return [{"path": str(keep), "bytes": 10}, {"path": str(skip), "bytes": 10}]

    def fake_chunk(path):
        return [{"file": path, "start_line": 1, "end_line": 2, "symbol": "x", "text": "code"}]

    monkeypatch.setattr(svc.hotpath, "index_walk", fake_walk)
    monkeypatch.setattr(svc.hotpath, "chunk_file", fake_chunk)

    indexer = IndexerService(
        workspace_root=str(tmp_workspace),
        store=VectorStore(tmp_path / "idx.sqlite"),
        embedder=HashEmbedder(64),
        exclude_globs=["node_modules"],
    )
    status = await indexer.reindex()
    # Only the non-excluded file made it into the index.
    assert status.file_count == 1


def test_indexer_clears_store_when_embedding_signature_changes(tmp_path):
    store = VectorStore(tmp_path / "v.sqlite")
    store.upsert([
        {
            "id": "1", "file": "a.py", "start_line": 1, "end_line": 5,
            "symbol": "alpha", "text": "alpha", "vector": hash_embed("alpha", 64),
        }
    ])
    # First open writes the current signature.
    IndexerService(workspace_root=str(tmp_path), store=store, embedder=HashEmbedder(64))
    assert store.count() == 1

    # Re-open with a different embedding dim → store must be cleared.
    IndexerService(workspace_root=str(tmp_path), store=store, embedder=HashEmbedder(128))
    assert store.count() == 0
