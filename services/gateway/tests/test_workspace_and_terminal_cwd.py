"""Workspace root resolution and terminal working-directory confinement.

The reported symptom was a terminal opening in the application's install/bin
directory instead of the selected project. The cause was a chain of silent
fallbacks to the sidecar's own working directory (``"."`` / ``Path.cwd()`` /
``cwd=req.cwd or None``), so these tests assert the absence of that fallback as
much as the presence of the right answer.

The cwd decision is covered for the five situations the product actually hits:
workspace opened, workspace switched, terminal reopened, no workspace, and a
workspace folder that has been deleted.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from zocai_gateway.app import SpawnTerminalRequest, TerminalProcess, TerminalRegistry, create_app
from zocai_gateway.errors import ErrorCode
from zocai_gateway.workspace_context import (
    resolve_terminal_cwd,
    workspace_context_from_path,
)

# ── WorkspaceContext ───────────────────────────────────────────────────────


def test_workspace_context_is_canonical(tmp_path: Path) -> None:
    nested = tmp_path / "project"
    nested.mkdir()
    context = workspace_context_from_path(f"{nested}{os.sep}.{os.sep}")
    assert context is not None
    assert context.root_path == str(nested.resolve())
    assert context.display_name == "project"
    assert context.workspace_id


def test_workspace_context_follows_a_symlinked_root(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real, target_is_directory=True)
    context = workspace_context_from_path(link)
    assert context is not None
    assert context.root_path == str(real.resolve())


def test_workspace_context_is_none_without_a_root() -> None:
    assert workspace_context_from_path(None) is None
    assert workspace_context_from_path("   ") is None


def test_workspace_context_rejects_a_non_directory(tmp_path: Path) -> None:
    file_path = tmp_path / "notadir.txt"
    file_path.write_text("x", encoding="utf-8")
    with pytest.raises(ValueError, match=ErrorCode.WORKSPACE_INVALID):
        workspace_context_from_path(file_path)


def test_workspace_context_contains_rejects_traversal(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    root.mkdir()
    (root / "src").mkdir()
    context = workspace_context_from_path(root)
    assert context is not None
    assert context.contains(root / "src") is True
    assert context.contains(root) is True
    assert context.contains(root / "..") is False
    assert context.contains(tmp_path / "elsewhere") is False


# ── terminal cwd, the five real cases ──────────────────────────────────────


def test_cwd_workspace_opened_uses_the_root(tmp_path: Path) -> None:
    context = workspace_context_from_path(tmp_path)
    decision = resolve_terminal_cwd(None, context)
    assert decision.ok
    assert decision.cwd == str(tmp_path.resolve())
    assert decision.fell_back is False


def test_cwd_workspace_switched_uses_the_new_root(tmp_path: Path) -> None:
    first = tmp_path / "a"
    second = tmp_path / "b"
    first.mkdir()
    second.mkdir()
    # A request still naming the *old* root is confined to the new workspace.
    decision = resolve_terminal_cwd(str(first), workspace_context_from_path(second))
    assert decision.ok
    assert decision.cwd == str(second.resolve())
    assert decision.fell_back is True
    assert decision.code == ErrorCode.PATH_OUTSIDE_WORKSPACE


def test_cwd_terminal_reopened_in_a_subdirectory_is_kept(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    sub = root / "packages" / "app"
    sub.mkdir(parents=True)
    decision = resolve_terminal_cwd(str(sub), workspace_context_from_path(root))
    assert decision.ok
    assert decision.cwd == str(sub.resolve())
    assert decision.fell_back is False


def test_cwd_without_a_workspace_is_refused() -> None:
    decision = resolve_terminal_cwd(None, None)
    assert decision.ok is False
    assert decision.cwd is None
    assert decision.code == ErrorCode.NO_WORKSPACE
    # Refusing is the point: the alternative is the app's own directory.
    assert "Open a project folder" in (decision.message or "")


def test_cwd_for_a_deleted_workspace_is_refused(tmp_path: Path) -> None:
    root = tmp_path / "gone"
    root.mkdir()
    context = workspace_context_from_path(root)
    root.rmdir()
    decision = resolve_terminal_cwd(None, context)
    assert decision.ok is False
    assert decision.code == ErrorCode.WORKSPACE_INVALID


def test_cwd_never_falls_back_to_the_process_directory(tmp_path: Path) -> None:
    """The regression guard for the original bug.

    Whatever is requested, the answer is inside the workspace — never the
    directory the sidecar happens to be running in.
    """
    root = tmp_path / "ws"
    root.mkdir()
    context = workspace_context_from_path(root)
    for requested in (None, "", "..", "/etc", "../../..", "does/not/exist"):
        decision = resolve_terminal_cwd(requested, context)
        assert decision.cwd is not None
        assert Path(decision.cwd).resolve() == root.resolve()
        assert Path(decision.cwd).resolve() != Path.cwd().resolve()


# ── the registry enforces it ───────────────────────────────────────────────


def test_registry_refuses_to_spawn_without_a_workspace() -> None:
    registry = TerminalRegistry(lambda: None)
    with pytest.raises(PermissionError):
        registry.create(SpawnTerminalRequest(cmd="/bin/sh", args=["-c", "true"]))


def test_registry_spawns_inside_the_workspace(tmp_path: Path) -> None:
    context = workspace_context_from_path(tmp_path)
    registry = TerminalRegistry(lambda: context)
    terminal = registry.create(SpawnTerminalRequest(cmd="/bin/sh", args=["-c", "true"]))
    try:
        assert terminal.cwd == str(tmp_path.resolve())
        assert terminal.session.cwd == str(tmp_path.resolve())
    finally:
        terminal.stop()


def test_registry_confines_an_escaping_cwd_to_the_root(tmp_path: Path) -> None:
    context = workspace_context_from_path(tmp_path)
    registry = TerminalRegistry(lambda: context)
    terminal = registry.create(SpawnTerminalRequest(cmd="/bin/sh", args=["-c", "true"], cwd="/etc"))
    try:
        assert terminal.cwd == str(tmp_path.resolve())
    finally:
        terminal.stop()


def test_terminal_process_requires_an_existing_directory(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="does not exist"):
        TerminalProcess(
            SpawnTerminalRequest(cmd="/bin/sh"),
            cwd=str(tmp_path / "missing"),
        )


@pytest.mark.skipif(os.name != "posix", reason="PTY spawn is POSIX-only")
def test_spawned_shell_actually_runs_in_the_workspace(tmp_path: Path) -> None:
    """End-to-end: `pwd` inside the spawned PTY reports the workspace root."""
    root = tmp_path / "ws"
    root.mkdir()
    context = workspace_context_from_path(root)
    registry = TerminalRegistry(lambda: context)
    terminal = registry.create(SpawnTerminalRequest(cmd="/bin/sh", args=["-c", "pwd"]))
    try:
        chunks: list[str] = []
        for _ in range(200):
            item = terminal._events.get(timeout=5)
            if item is None:
                break
            if item.get("type") == "data":
                chunks.append(str(item.get("chunk", "")))
            if item.get("type") == "exit":
                break
        assert str(root.resolve()) in "".join(chunks)
    finally:
        terminal.stop()


# ── the HTTP surface ───────────────────────────────────────────────────────


def test_spawn_endpoint_returns_a_structured_refusal_for_a_bad_command(
    tmp_path: Path,
) -> None:
    client = TestClient(create_app(drive=False, workspace_root=tmp_path))
    response = client.post("/v1/terminal", json={"cmd": "   "})
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert detail["code"] == ErrorCode.TERMINAL_SPAWN_FAILED
    assert detail["message"].strip()


def test_runtime_reports_the_canonical_workspace(tmp_path: Path) -> None:
    client = TestClient(create_app(drive=False, workspace_root=tmp_path))
    body = client.get("/v1/agent/runtime").json()
    assert body["workspace"]["rootPath"] == str(tmp_path.resolve())
    assert body["workspace"]["displayName"] == tmp_path.name
    assert body["workspace_root"] == str(tmp_path.resolve())


def test_rootless_instance_never_reports_the_process_directory() -> None:
    """A gateway with no workspace must not claim the sidecar's own directory."""
    client = TestClient(create_app(drive=False))
    body = client.get("/v1/agent/runtime").json()
    assert body["workspace"] is None
    assert body["workspace_root"] is None
