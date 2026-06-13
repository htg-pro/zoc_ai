"""Shared pytest fixtures for the agent service."""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from shared_schema.models import (
    PermissionGrant,
    PermissionScope,
    ProviderKind,
    Session,
)

os.environ.setdefault("LLAMA_STUDIO_DEFAULT_PROVIDER", "mock")
os.environ.setdefault("LLAMA_STUDIO_DEFAULT_MODEL", "mock-1")


def _ensure_repo_paths():
    # Make repo packages importable when running tests directly.
    repo = Path(__file__).resolve().parents[3]
    for p in (
        repo / "packages" / "shared-types" / "python",
        repo / "services" / "agent" / "src",
    ):
        if str(p) not in os.sys.path:
            os.sys.path.insert(0, str(p))


_ensure_repo_paths()


@pytest.fixture
def tmp_workspace(tmp_path: Path) -> Path:
    """A pretend project workspace with a few files."""

    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "hello.py").write_text(
        "def greet(name):\n    return f'hello, {name}'\n",
        encoding="utf-8",
    )
    (tmp_path / "README.md").write_text("# fixture repo\n", encoding="utf-8")
    return tmp_path


@pytest.fixture
def app_state(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("LLAMA_STUDIO_DATA_DIR", str(tmp_path / "data"))
    from llama_studio_agent.config import get_settings, reset_settings_cache
    from llama_studio_agent.state import build_app_state

    reset_settings_cache()
    state = build_app_state(get_settings())
    return state


@pytest.fixture
def mock_provider(app_state):
    from llama_studio_agent.providers.mock import MockProvider

    provider = app_state.providers.get(ProviderKind.mock)
    assert isinstance(provider, MockProvider)
    provider.reset()
    return provider


@pytest.fixture
def session(app_state, tmp_workspace) -> Session:
    s = Session(title="t", workspace_root=str(tmp_workspace), provider="mock", model="mock-1")
    app_state.repo.create_session(s)
    for scope in PermissionScope:
        app_state.repo.set_permission(s.id, PermissionGrant(scope=scope, granted=True))
        app_state.permissions.grant(s.id, scope)
    return s


@pytest.fixture
def client(app_state) -> Iterator[TestClient]:
    from llama_studio_agent.app import create_app

    app = create_app(app_state.settings, state=app_state)
    with TestClient(app) as c:
        yield c


@pytest.fixture
def tool_call(monkeypatch):
    """Helper: build a ProviderToolCall."""

    from llama_studio_agent.providers.base import ProviderToolCall

    def _make(name: str, **kwargs):
        return ProviderToolCall(id=f"call-{name}", name=name, arguments=kwargs)

    return _make
