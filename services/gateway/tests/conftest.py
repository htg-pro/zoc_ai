"""Pytest configuration for the gateway test suite.

Ensures the ``services/`` directory is importable so the bundled MCP servers in
``services/mcp_servers/`` can be imported as ``mcp_servers`` from the tests.
"""

from __future__ import annotations

import pathlib
import sys

import pytest

_SERVICES_DIR = str(pathlib.Path(__file__).resolve().parents[2])
if _SERVICES_DIR not in sys.path:
    sys.path.insert(0, _SERVICES_DIR)


@pytest.fixture(autouse=True)
def _isolate_desktop_config(
    tmp_path_factory: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Isolate the WorkspaceBinder from any real ``~/.zoc-studio/desktop.json``.

    Without this, a developer machine that has opened a workspace in the real
    desktop app would leak that root into ``create_app()`` calls that expect no
    workspace, making tests non-deterministic. Tests that need a workspace still
    pass ``workspace_root=`` explicitly (the injected override).
    """
    isolated = tmp_path_factory.mktemp("zoc_desktop_cfg") / "desktop.json"
    monkeypatch.setattr(
        "zocai_gateway.workspace_binder.default_desktop_config_path",
        lambda: isolated,
    )
    monkeypatch.delenv("ZOC_STUDIO_WORKSPACE", raising=False)


@pytest.fixture(autouse=True)
def _isolate_transcript_store(
    tmp_path_factory: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Point the Session/transcript store at a temp directory (R15.6).

    Sessions and transcripts became durable in task 22.1's wave, so a
    ``create_app()`` that creates a session now writes under
    ``~/.zoc-studio/sessions``. Without this fixture the suite would persist into a
    developer's real state and — worse for determinism — *read it back* on the next
    run, so a list assertion would pass alone and fail after any earlier test had
    created a session.

    Each test gets its own root, so nothing leaks between tests either.
    """
    root = tmp_path_factory.mktemp("zoc_sessions")
    monkeypatch.setattr("zocai_gateway.transcripts.default_transcript_root", lambda: root)
