"""Smoke-test fixtures: spin up real local-LLM providers.

These tests are opt-in. They are skipped unless ``LLAMA_STUDIO_SMOKE=1`` is
set AND the configured provider's HTTP endpoint is reachable. That way a
developer running ``pytest tests/smoke`` without a model server still gets
clean skips instead of a wall of connection errors.

Configuration (all env vars, defaults shown):

    LLAMA_STUDIO_SMOKE=0                       # set to 1 to enable
    LLAMA_STUDIO_SMOKE_PROVIDER=llamacpp       # llamacpp
    LLAMA_STUDIO_SMOKE_MODEL=local             # any model the server has
    LLAMA_STUDIO_LLAMACPP_BASE_URL=http://127.0.0.1:8080
"""

from __future__ import annotations

import os
from pathlib import Path

import httpx
import pytest
from shared_schema.models import (
    PermissionGrant,
    PermissionScope,
    ProviderKind,
    Session,
)


def _enabled() -> bool:
    return os.environ.get("LLAMA_STUDIO_SMOKE", "0").lower() in {"1", "true", "yes"}


def _provider_kind() -> str:
    return os.environ.get("LLAMA_STUDIO_SMOKE_PROVIDER", "llamacpp").lower()


def _model() -> str:
    return os.environ.get("LLAMA_STUDIO_SMOKE_MODEL", "local")


def _health_url(kind: str) -> str:
    if kind == "llamacpp":
        base = os.environ.get("LLAMA_STUDIO_LLAMACPP_BASE_URL", "http://127.0.0.1:8080")
        return f"{base.rstrip('/')}/v1/models"
    raise ValueError(f"unsupported smoke provider: {kind}")


def pytest_collection_modifyitems(config, items):
    """Skip everything in this directory unless smoke mode is on and reachable."""

    if not _enabled():
        marker = pytest.mark.skip(reason="LLAMA_STUDIO_SMOKE not set; skipping real-LLM tests")
        for item in items:
            item.add_marker(marker)
        return

    kind = _provider_kind()
    try:
        r = httpx.get(_health_url(kind), timeout=2.0)
        reachable = r.status_code < 500
    except httpx.HTTPError as exc:
        reachable = False
        reason = f"{kind} endpoint unreachable: {exc}"
    else:
        reason = f"{kind} endpoint returned {r.status_code}"

    if not reachable:
        marker = pytest.mark.skip(reason=reason)
        for item in items:
            item.add_marker(marker)


@pytest.fixture(scope="session")
def smoke_provider_kind() -> str:
    return _provider_kind()


@pytest.fixture(scope="session")
def smoke_model() -> str:
    return _model()


@pytest.fixture
def smoke_workspace(tmp_path: Path) -> Path:
    """A tiny but realistic workspace the model can poke at."""

    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "math_utils.py").write_text(
        '"""Small math helpers used by the smoke suite."""\n\n\n'
        "def add(a: int, b: int) -> int:\n"
        '    """Return the sum of ``a`` and ``b``."""\n'
        "    return a + b\n\n\n"
        "def is_even(n: int) -> bool:\n"
        '    """Return True when ``n`` is even."""\n'
        "    return n % 2 == 0\n",
        encoding="utf-8",
    )
    (tmp_path / "README.md").write_text(
        "# smoke fixture\n\nA throwaway repo for end-to-end LLM smoke tests.\n",
        encoding="utf-8",
    )
    return tmp_path


@pytest.fixture
def smoke_state(tmp_path: Path, smoke_provider_kind: str, smoke_model: str, monkeypatch):
    monkeypatch.setenv("LLAMA_STUDIO_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("LLAMA_STUDIO_DEFAULT_PROVIDER", smoke_provider_kind)
    monkeypatch.setenv("LLAMA_STUDIO_DEFAULT_MODEL", smoke_model)

    from llama_studio_agent.config import get_settings, reset_settings_cache
    from llama_studio_agent.state import build_app_state

    reset_settings_cache()
    return build_app_state(get_settings())


@pytest.fixture
def smoke_session(smoke_state, smoke_workspace, smoke_provider_kind: str, smoke_model: str) -> Session:
    s = Session(
        title="smoke",
        workspace_root=str(smoke_workspace),
        provider=smoke_provider_kind,
        model=smoke_model,
    )
    smoke_state.repo.create_session(s)
    for scope in PermissionScope:
        smoke_state.repo.set_permission(s.id, PermissionGrant(scope=scope, granted=True))
        smoke_state.permissions.grant(s.id, scope)
    return s


@pytest.fixture
def smoke_orchestrator(smoke_state, smoke_session, smoke_provider_kind: str, smoke_model: str):
    from llama_studio_agent.agent.orchestrator import AgentOrchestrator

    provider = smoke_state.providers.get(ProviderKind(smoke_provider_kind))
    indexer = smoke_state.indexer_for(smoke_session.id, smoke_session.workspace_root)
    return AgentOrchestrator(
        provider=provider,
        model=smoke_model,
        registry=smoke_state.tools,
        repo=smoke_state.repo,
        bus=smoke_state.bus,
        indexer=indexer,
        permissions=smoke_state.permissions,
    )
