"""Dynamic workspace rebind + per-scope MCP host tests (zoc-ai-agent-chat-overhaul).

* Task 1 — the production launch does not pin the workspace as an immutable
  ``create_app(workspace_root=…)`` override; two successive requests see a
  changed desktop config without a restart, and the ``ZOC_STUDIO_WORKSPACE``
  env var is a *fallback*, not the immutable override.
* Task 2 — the MCP host is per :class:`WorkspaceScope`: a rebind retires the old
  scope (closing its MCP host) and builds a fresh one against the new root.

**Validates: Requirements 1.2, 1.6**
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from zocai_gateway.app import create_app
from zocai_gateway.workspace_binder import WorkspaceBinder, WorkspaceScope
from zocai_gateway.workspace_context import workspace_context_from_path


def _point_config_at(monkeypatch: pytest.MonkeyPatch, cfg: Path) -> None:
    # Override the conftest isolation so this test controls the desktop config.
    monkeypatch.setattr(
        "zocai_gateway.workspace_binder.default_desktop_config_path", lambda: cfg
    )


def _write_root(cfg: Path, root: Path) -> None:
    cfg.write_text(json.dumps({"workspace_root": str(root)}), encoding="utf-8")


# ── Task 1: two successive requests rebind without a restart ────────────────


def test_desktop_config_change_rebinds_without_restart(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = tmp_path / "desktop.json"
    _point_config_at(monkeypatch, cfg)
    dir_a = tmp_path / "workspace_a"
    dir_b = tmp_path / "workspace_bbbbb"  # distinct length → distinct config size
    dir_a.mkdir()
    dir_b.mkdir()
    _write_root(cfg, dir_a)

    # Production-style construction: no workspace_root override (as launch.py now
    # calls create_app). The binder resolves the active root per request.
    with TestClient(create_app()) as client:
        first = client.get("/v1/agent/runtime").json()
        assert first["workspace_root"].endswith("workspace_a")

        # Change the desktop config; the same process must rebind on the next
        # request with no restart.
        _write_root(cfg, dir_b)
        second = client.get("/v1/agent/runtime").json()
        assert second["workspace_root"].endswith("workspace_bbbbb")
        assert first["workspace_root"] != second["workspace_root"]


def test_launch_env_is_a_fallback_not_the_immutable_override(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = tmp_path / "desktop.json"
    _point_config_at(monkeypatch, cfg)
    env_dir = tmp_path / "from_env"
    cfg_a = tmp_path / "cfg_a"
    cfg_b = tmp_path / "cfg_bbbbb"
    for d in (env_dir, cfg_a, cfg_b):
        d.mkdir()

    # The supervisor may export the env var; it must stay a fallback (source #3),
    # never the immutable create_app override that froze the root for the run.
    monkeypatch.setenv("ZOC_STUDIO_WORKSPACE", str(env_dir))
    _write_root(cfg, cfg_a)

    with TestClient(create_app()) as client:
        # Desktop config takes precedence over the env fallback.
        assert client.get("/v1/agent/runtime").json()["workspace_root"].endswith("cfg_a")
        # Changing the config still rebinds even though the env var is set — proof
        # the env value did not become an immutable override.
        _write_root(cfg, cfg_b)
        assert client.get("/v1/agent/runtime").json()["workspace_root"].endswith("cfg_bbbbb")


def test_env_only_workspace_resolves_when_no_config(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With no desktop config, the env fallback still resolves the workspace."""
    cfg = tmp_path / "absent-desktop.json"  # never created
    _point_config_at(monkeypatch, cfg)
    env_dir = tmp_path / "env_only"
    env_dir.mkdir()
    monkeypatch.setenv("ZOC_STUDIO_WORKSPACE", str(env_dir))

    with TestClient(create_app()) as client:
        assert client.get("/v1/agent/runtime").json()["workspace_root"].endswith("env_only")


# ── Task 2: per-scope MCP host, retired + rebuilt on rebind ─────────────────


class _FakeHost:
    """Stands in for an MCP host so the test can observe start/close + root."""

    def __init__(self, root: str) -> None:
        self.root = root
        self.closed = False

    async def aclose(self) -> None:
        self.closed = True


def test_scope_rebind_closes_old_mcp_host_and_uses_new_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cfg = tmp_path / "desktop.json"
    dir_a = tmp_path / "ws_a"
    dir_b = tmp_path / "ws_bbbbb"
    dir_a.mkdir()
    dir_b.mkdir()
    _write_root(cfg, dir_a)

    built_roots: list[str] = []

    async def factory(ws: object) -> WorkspaceScope:
        host = _FakeHost(ws.root_path)  # type: ignore[attr-defined]
        built_roots.append(ws.root_path)  # type: ignore[attr-defined]
        return WorkspaceScope(
            workspace=ws,  # type: ignore[arg-type]
            diary=None,
            diary_path=None,
            state_store=None,
            hermes=None,
            mcp_host=host,
        )

    binder = WorkspaceBinder(config_path=cfg, env={})
    binder.set_scope_factory(factory)

    async def drive() -> tuple[WorkspaceScope, WorkspaceScope]:
        scope1 = await binder.scope()
        _write_root(cfg, dir_b)  # rebind: change the desktop config
        scope2 = await binder.scope()
        return scope1, scope2

    scope1, scope2 = asyncio.run(drive())

    # New root/config used after rebind, and it is a *different* host object.
    assert scope1.mcp_host.root.endswith("ws_a")  # type: ignore[attr-defined]
    assert scope2.mcp_host.root.endswith("ws_bbbbb")  # type: ignore[attr-defined]
    assert scope1.mcp_host is not scope2.mcp_host
    # The old scope's MCP host is closed when the rebind retires it.
    assert scope1.mcp_host.closed is True  # type: ignore[attr-defined]
    assert [Path(r).name for r in built_roots] == ["ws_a", "ws_bbbbb"]


def test_scope_retire_closes_current_mcp_host(tmp_path: Path) -> None:
    """Shutdown (retire_scope) closes the active scope's MCP host (lifespan path)."""
    cfg = tmp_path / "desktop.json"
    root = tmp_path / "ws"
    root.mkdir()
    _write_root(cfg, root)

    host = _FakeHost(str(root))

    async def factory(ws: object) -> WorkspaceScope:
        return WorkspaceScope(
            workspace=ws,  # type: ignore[arg-type]
            diary=None,
            diary_path=None,
            state_store=None,
            hermes=None,
            mcp_host=host,
        )

    binder = WorkspaceBinder(config_path=cfg, env={})
    binder.set_scope_factory(factory)

    async def drive() -> None:
        await binder.scope()
        await binder.retire_scope()

    asyncio.run(drive())
    assert host.closed is True


def test_seeded_scope_context_matches_resolved_workspace(tmp_path: Path) -> None:
    """A seeded startup scope is returned for the matching workspace (no rebuild)."""
    cfg = tmp_path / "desktop.json"
    root = tmp_path / "seeded"
    root.mkdir()
    _write_root(cfg, root)
    ws = workspace_context_from_path(root)
    seeded_host = _FakeHost(ws.root_path)
    seeded = WorkspaceScope(
        workspace=ws,
        diary=None,
        diary_path=None,
        state_store=None,
        hermes=None,
        mcp_host=seeded_host,
    )
    rebuilt = False

    async def factory(_ws: object) -> WorkspaceScope:
        nonlocal rebuilt
        rebuilt = True
        return seeded

    binder = WorkspaceBinder(config_path=cfg, env={})
    binder.set_scope_factory(factory)
    binder.seed_scope(seeded)

    got = asyncio.run(binder.scope())
    assert got is seeded
    assert rebuilt is False  # seeded scope reused, factory not called
