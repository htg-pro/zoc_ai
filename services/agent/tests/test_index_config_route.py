"""Tests for the /v1/sessions/{id}/index/config API."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _stub_hotpath(monkeypatch):
    import llama_studio_agent.indexer.service as svc

    monkeypatch.setattr(svc.hotpath, "index_walk", lambda *_a, **_k: [])
    monkeypatch.setattr(svc.hotpath, "chunk_file", lambda *_a, **_k: [])


def test_get_config_returns_defaults(client, session):
    r = client.get(f"/v1/sessions/{session.id}/index/config")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["workspace_root"] == session.workspace_root
    assert body["exclude_globs"] == []
    assert body["watch"] is False


def test_put_config_saves_exclude_and_watch(client, session):
    r = client.put(
        f"/v1/sessions/{session.id}/index/config",
        json={"exclude_globs": ["node_modules", "*.log"], "watch": True},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["exclude_globs"] == ["node_modules", "*.log"]
    assert body["watch"] is True

    # Values survive a fresh GET (persisted, not local-only).
    again = client.get(f"/v1/sessions/{session.id}/index/config").json()
    assert again["exclude_globs"] == ["node_modules", "*.log"]
    assert again["watch"] is True


def test_put_config_changes_workspace_root(client, session, app_state, tmp_path):
    new_root = tmp_path / "other"
    new_root.mkdir()
    r = client.put(
        f"/v1/sessions/{session.id}/index/config",
        json={"workspace_root": str(new_root)},
    )
    assert r.status_code == 200, r.text
    assert r.json()["workspace_root"] == str(new_root)
    # The session record was updated so other routes pick up the new root.
    refreshed = app_state.repo.get_session(session.id)
    assert refreshed is not None
    assert refreshed.workspace_root == str(new_root)


def test_put_config_toggles_watch_off(client, session):
    client.put(f"/v1/sessions/{session.id}/index/config", json={"watch": True})
    r = client.put(f"/v1/sessions/{session.id}/index/config", json={"watch": False})
    assert r.status_code == 200, r.text
    assert r.json()["watch"] is False


def test_put_config_rejects_nonexistent_root(client, session, app_state, tmp_path):
    missing = tmp_path / "does-not-exist"
    r = client.put(
        f"/v1/sessions/{session.id}/index/config",
        json={"workspace_root": str(missing)},
    )
    assert r.status_code == 422, r.text
    assert "does not exist" in r.json()["detail"]
    # The session root was left untouched.
    refreshed = app_state.repo.get_session(session.id)
    assert refreshed is not None
    assert refreshed.workspace_root == session.workspace_root


def test_put_config_rejects_file_root(client, session, app_state, tmp_path):
    a_file = tmp_path / "a-file.txt"
    a_file.write_text("not a directory")
    r = client.put(
        f"/v1/sessions/{session.id}/index/config",
        json={"workspace_root": str(a_file)},
    )
    assert r.status_code == 422, r.text
    assert "not a directory" in r.json()["detail"]
    refreshed = app_state.repo.get_session(session.id)
    assert refreshed is not None
    assert refreshed.workspace_root == session.workspace_root
