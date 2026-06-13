"""Tests for the /v1/settings runtime-settings API."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from llama_studio_agent.config import (
    SETTINGS_OVERRIDES_FILENAME,
    load_runtime_overrides,
    save_runtime_overrides,
)


def test_get_settings_default(client):
    r = client.get("/v1/settings")
    assert r.status_code == 200
    body = r.json()
    assert body["embedding"]["provider"] == "auto"
    assert body["embedding"]["model"] is None


def test_patch_settings_sets_embedding(client, app_state):
    r = client.patch(
        "/v1/settings",
        json={"embedding": {"provider": "llamacpp", "model": "nomic-embed-text"}},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["embedding"]["provider"] == "llamacpp"
    assert body["embedding"]["model"] == "nomic-embed-text"
    assert app_state.settings.embedding_provider == "llamacpp"
    assert app_state.settings.embedding_model == "nomic-embed-text"


def test_patch_settings_auto_clears_model(client, app_state):
    # First switch to openai with a model …
    client.patch("/v1/settings", json={"embedding": {"provider": "openai", "model": "x"}})
    # … then back to auto with empty model.
    r = client.patch("/v1/settings", json={"embedding": {"provider": "auto", "model": ""}})
    assert r.status_code == 200
    assert r.json()["embedding"]["provider"] == "auto"
    assert r.json()["embedding"]["model"] is None
    assert app_state.settings.embedding_provider is None
    assert app_state.settings.embedding_model is None


def test_patch_settings_persists_to_disk(client, app_state):
    client.patch(
        "/v1/settings",
        json={"embedding": {"provider": "hash", "model": None}},
    )
    overrides_path = Path(app_state.settings.data_dir) / SETTINGS_OVERRIDES_FILENAME
    assert overrides_path.exists()
    on_disk = json.loads(overrides_path.read_text("utf-8"))
    assert on_disk["embedding_provider"] == "hash"


def test_load_runtime_overrides_filters_unknown_keys(tmp_path):
    save_runtime_overrides(
        str(tmp_path),
        {"embedding_provider": "openai", "host": "0.0.0.0"},  # type: ignore[dict-item]
    )
    loaded = load_runtime_overrides(str(tmp_path))
    assert loaded == {"embedding_provider": "openai"}


def test_get_settings_coerces_unknown_provider_to_auto(client, app_state):
    # Simulate a stale env override that doesn't map cleanly onto the enum.
    app_state.settings.embedding_provider = "mock"
    body = client.get("/v1/settings").json()
    assert body["embedding"]["provider"] == "auto"


@pytest.mark.asyncio
async def test_patch_clears_cached_indexers(app_state, session, monkeypatch):
    # Seed the indexer cache so we can verify the PATCH resets it.
    import llama_studio_agent.indexer.service as svc

    monkeypatch.setattr(svc.hotpath, "index_walk", lambda *_a, **_k: [])
    indexer_before = app_state.indexer_for(session.id, session.workspace_root)
    assert session.id in app_state._indexers

    from llama_studio_agent.v1.settings import _refresh_indexers

    app_state.settings.embedding_provider = "hash"
    await _refresh_indexers(app_state)

    # The cache entry should have been dropped (rebuilt on next access).
    indexer_after = app_state.indexer_for(session.id, session.workspace_root)
    assert indexer_after is not indexer_before
