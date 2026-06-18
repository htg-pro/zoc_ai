"""Example test: DONE terminal close + Agent toolset capabilities.

Feature: zocai-ecosystem-rebuild — example test for task 5.20.

This worked example pins the two Agent-Mode guarantees a single happy-path run
relies on:

- **R3.4 — DONE closes the stream.** Driving an Agent run's FSM (bound through
  ``_Run.bind_fsm``) to the DONE stage emits the terminal ``done`` completion
  event and then enqueues the close sentinel behind it, so the run's SSE bus
  terminates rather than hanging open.
- **R3.5 — Agent toolset permits mutation in the workspace.** The
  :class:`FullToolset` the Agent path is constructed with permits
  ``write_file`` / ``run_shell`` / ``make_dir`` confined to the workspace root,
  and rejects targets that resolve outside that root.

Where ``test_done_terminal_close.py`` exhaustively pins the close wiring and the
PBTs cover the FSM/contract invariants, this example reads as one concrete
end-to-end Agent-Mode story: the run can mutate the workspace while it executes,
and the stream closes cleanly once it reaches DONE.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from zocai_gateway.app import RunRegistry
from zocai_gateway.fsm import FSM
from zocai_gateway.mode_router import AgentRunRequest, ModeRouter
from zocai_gateway.stages import Stage
from zocai_gateway.toolsets import FullToolset, ReadOnlyViolation


def _drive_to_done(fsm: FSM) -> None:
    """Advance ``fsm`` along the empty-plan happy path INTAKE → … → DONE."""
    fsm.advance()  # INTAKE -> ANALYZE
    fsm.advance()  # ANALYZE -> MAP_FILES
    fsm.advance()  # MAP_FILES -> READ_FILES
    fsm.advance()  # READ_FILES -> PLAN_EDITS
    fsm.plan_complete(has_changes=False)  # PLAN_EDITS -> RUN_CHECKS (R3.8)
    fsm.run_checks_result(0)  # RUN_CHECKS -> SUMMARY (R5.8)
    fsm.advance()  # SUMMARY -> DONE


# --------------------------------------------------------------------------- #
# R3.4 — DONE closes the stream
# --------------------------------------------------------------------------- #


def test_agent_run_reaching_done_emits_done_then_closes_stream() -> None:
    """Driving a bound Agent FSM to DONE puts ``done`` then the close sentinel.

    This is the worked R3.4 story: an Agent run is registered, its FSM is bound
    to the run's gate-and-close sink, and once the FSM reaches DONE the bus
    carries the terminal completion event immediately followed by the ``None``
    close sentinel that ends ``GET /v1/agent/events`` for the run.
    """
    registry = RunRegistry()
    run = registry.create(ModeRouter().route(AgentRunRequest(prompt="ship it", mode="agent")))
    fsm = run.bind_fsm(FSM(initial=Stage.INTAKE, run_id=run.run_id))

    _drive_to_done(fsm)

    drained: list[dict[str, object] | None] = []
    while not run.queue.empty():
        drained.append(run.queue.get_nowait())

    # The terminal done completion event reached the bus, marked ok...
    assert drained[-2] is not None
    assert drained[-2]["type"] == "done"
    assert drained[-2]["ok"] is True
    # ...then exactly one close sentinel, and it is the final frame (R3.4).
    assert drained[-1] is None
    assert drained.count(None) == 1


# --------------------------------------------------------------------------- #
# R3.5 — Agent toolset permits write / shell / mkdir within the workspace
# --------------------------------------------------------------------------- #


def test_agent_full_toolset_permits_write_within_workspace(tmp_path: Path) -> None:
    """The Agent path's FullToolset can write a file under the workspace root."""
    toolset = FullToolset(workspace_root=tmp_path)

    toolset.write_file("notes/todo.txt", "implement R3.5")

    written = tmp_path / "notes" / "todo.txt"
    assert written.read_text(encoding="utf-8") == "implement R3.5"


def test_agent_full_toolset_permits_make_dir_within_workspace(tmp_path: Path) -> None:
    """The Agent path's FullToolset can create a directory under the workspace."""
    toolset = FullToolset(workspace_root=tmp_path)

    toolset.make_dir("build/artifacts")

    created = tmp_path / "build" / "artifacts"
    assert created.is_dir()


def test_agent_full_toolset_permits_shell_within_workspace(tmp_path: Path) -> None:
    """The Agent path's FullToolset runs shell commands rooted at the workspace.

    The command runs with ``cwd`` set to the workspace root and returns the
    captured result, demonstrating the shell capability Agent Mode permits
    (R3.5) without leaving the workspace.
    """
    toolset = FullToolset(workspace_root=tmp_path)

    result = toolset.run_shell(["pwd"])

    assert result.returncode == 0
    assert Path(result.stdout.strip()).resolve() == tmp_path.resolve()


def test_agent_full_toolset_rejects_out_of_workspace_targets(tmp_path: Path) -> None:
    """Mutation aimed outside the workspace root is rejected (R3.5 confinement).

    A traversal target that resolves above the workspace raises
    :class:`ReadOnlyViolation` naming the rejected operation, so the Agent
    toolset's write/mkdir power stays confined to the workspace.
    """
    toolset = FullToolset(workspace_root=tmp_path)

    with pytest.raises(ReadOnlyViolation) as write_exc:
        toolset.write_file("../escape.txt", "nope")
    assert write_exc.value.operation == "write_file"

    with pytest.raises(ReadOnlyViolation) as mkdir_exc:
        toolset.make_dir("../escape-dir")
    assert mkdir_exc.value.operation == "make_dir"

    # Nothing was created outside the workspace.
    assert not (tmp_path.parent / "escape.txt").exists()
    assert not (tmp_path.parent / "escape-dir").exists()
