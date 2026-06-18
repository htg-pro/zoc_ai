"""Unit tests for the FS read adapter and shell spawner (task 8.5, R8.6 + R8.9).

These example-based tests pin the two behaviors the task calls out:

* native FS reads are available in **both** Ask and Agent Mode (R8.6); and
* shell execution is permitted **if and only if** Agent Mode is active — it
  runs in Agent Mode and is refused in Ask Mode (R8.9).

Both adapters delegate to the workspace-confined toolset primitives, so the
confinement guarantee is exercised here too. The exhaustive RAG/steering/token
property tests live in tasks 8.6–8.13; the broader FS/shell/MCP example test
is task 8.13.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from zocai_gateway.context.shell_fs import (
    FSReadAdapter,
    ShellExecutionNotPermitted,
    ShellSpawner,
)
from zocai_gateway.mode_router import Mode
from zocai_gateway.toolsets import ReadOnlyViolation


# ── FS read adapter: reads available in both modes (R8.6) ────────────────────


def test_fs_read_adapter_reads_workspace_file(tmp_path: Path) -> None:
    (tmp_path / "notes.txt").write_text("hello", encoding="utf-8")
    adapter = FSReadAdapter(workspace_root=str(tmp_path))
    assert adapter.read_file("notes.txt") == "hello"


def test_fs_read_adapter_is_mode_agnostic(tmp_path: Path) -> None:
    # The adapter carries no mode and applies no gate: a single adapter serves
    # reads regardless of which mode the caller is in (R8.6).
    (tmp_path / "src.py").write_text("x = 1\n", encoding="utf-8")
    adapter = FSReadAdapter(workspace_root=str(tmp_path))
    # Reading is permitted whether the surrounding run is Ask or Agent Mode.
    assert adapter.read_file("src.py") == "x = 1\n"
    assert adapter.read_file(Path("src.py")) == "x = 1\n"


def test_fs_read_adapter_confined_to_workspace(tmp_path: Path) -> None:
    adapter = FSReadAdapter(workspace_root=str(tmp_path / "ws"))
    (tmp_path / "ws").mkdir()
    (tmp_path / "outside.txt").write_text("secret", encoding="utf-8")
    with pytest.raises(ReadOnlyViolation) as excinfo:
        adapter.read_file("../outside.txt")
    assert excinfo.value.operation == "read_file"


def test_fs_read_adapter_exposes_resolved_workspace_root(tmp_path: Path) -> None:
    adapter = FSReadAdapter(workspace_root=str(tmp_path))
    assert adapter.workspace_root == tmp_path.resolve()


# ── Shell spawner: permitted iff Agent Mode (R8.9) ───────────────────────────


def test_shell_permitted_iff_agent_mode() -> None:
    assert ShellSpawner(Mode.AGENT).shell_permitted is True
    assert ShellSpawner(Mode.ASK).shell_permitted is False


@pytest.mark.parametrize("mode", list(Mode))
def test_shell_permitted_matches_agent_mode_for_every_mode(mode: Mode) -> None:
    # The biconditional holds across every defined mode: permitted exactly when
    # the mode is AGENT, refused otherwise (R8.9).
    spawner = ShellSpawner(mode)
    assert spawner.shell_permitted is (mode is Mode.AGENT)


def test_agent_mode_shell_executes_within_workspace(tmp_path: Path) -> None:
    spawner = ShellSpawner(Mode.AGENT, workspace_root=str(tmp_path))
    # Run the command from an argv (no shell string) and confirm it executed
    # with the workspace as the working directory.
    result = spawner.run_shell([sys.executable, "-c", "import os; print(os.getcwd())"])
    assert result.returncode == 0
    assert result.stdout.strip() == str(tmp_path.resolve())


def test_ask_mode_shell_is_refused_and_runs_nothing(tmp_path: Path) -> None:
    spawner = ShellSpawner(Mode.ASK, workspace_root=str(tmp_path))
    marker = tmp_path / "ran.txt"
    with pytest.raises(ShellExecutionNotPermitted) as excinfo:
        spawner.run_shell([sys.executable, "-c", f"open({str(marker)!r}, 'w').close()"])
    # Refusal names the rejected operation type and nothing was executed.
    assert excinfo.value.operation == "run_shell"
    assert not marker.exists()


def test_shell_execution_not_permitted_is_a_read_only_violation() -> None:
    # The Gateway's error-event conversion (task 4.2) keys off ReadOnlyViolation,
    # so the shell refusal must be one of those.
    assert issubclass(ShellExecutionNotPermitted, ReadOnlyViolation)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-v"]))
