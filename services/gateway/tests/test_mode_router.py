"""Unit tests for the Mode_Router and mode toolsets (task 4.1, R2.1/R3.1/R3.5).

These example-based tests pin the routing contract: Ask Mode routes to a
read-only path with the planner skipped, Agent Mode routes to an
execution-capable path with the FSM initialized at INTAKE and a full
toolset. The exhaustive routing property lives in the dedicated property
test (task 4.3, Property 8); read-only enforcement has its own property test
(task 4.4, Property 9).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from zocai_gateway.fsm import FSM
from zocai_gateway.mode_router import (
    AgentPath,
    AgentRunRequest,
    AskPath,
    ExecutionPath,
    Mode,
    ModeRouter,
)
from zocai_gateway.stages import Stage
from zocai_gateway.toolsets import (
    FullToolset,
    ReadOnlyToolset,
    Toolset,
)


@pytest.fixture
def router() -> ModeRouter:
    return ModeRouter()


def test_ask_mode_routes_to_ask_path(router: ModeRouter) -> None:
    path = router.route(AgentRunRequest(prompt="explain this", mode=Mode.ASK))
    assert isinstance(path, AskPath)
    assert path.mode is Mode.ASK


def test_ask_path_skips_planner_and_is_read_only(router: ModeRouter) -> None:
    path = router.route(AgentRunRequest(prompt="q", mode=Mode.ASK))
    assert path.skip_planner is True
    assert path.is_read_only is True
    assert isinstance(path.toolset, ReadOnlyToolset)


def test_agent_mode_routes_to_agent_path(router: ModeRouter) -> None:
    path = router.route(AgentRunRequest(prompt="build it", mode=Mode.AGENT))
    assert isinstance(path, AgentPath)
    assert path.mode is Mode.AGENT


def test_agent_path_starts_fsm_at_intake(router: ModeRouter) -> None:
    path = router.route(AgentRunRequest(prompt="build it", mode=Mode.AGENT))
    assert isinstance(path, AgentPath)
    assert isinstance(path.fsm, FSM)
    assert path.fsm.initial is Stage.INTAKE
    assert path.fsm.current is Stage.INTAKE


def test_agent_path_runs_planner_and_is_not_read_only(router: ModeRouter) -> None:
    path = router.route(AgentRunRequest(prompt="build it", mode=Mode.AGENT))
    assert path.skip_planner is False
    assert path.is_read_only is False
    assert isinstance(path.toolset, FullToolset)


def test_execution_path_is_abstract() -> None:
    with pytest.raises(TypeError):
        ExecutionPath()  # type: ignore[abstract]


# --- Toolset capability shape (R2.3, R3.5) ---


def test_read_only_toolset_physically_lacks_mutating_operations() -> None:
    toolset = ReadOnlyToolset()
    assert hasattr(toolset, "read_file")  # reads allowed in both modes (R8.6)
    assert not hasattr(toolset, "write_file")
    assert not hasattr(toolset, "run_shell")
    assert not hasattr(toolset, "make_dir")


def test_full_toolset_exposes_mutating_operations() -> None:
    toolset = FullToolset()
    for op in ("read_file", "write_file", "run_shell", "make_dir"):
        assert hasattr(toolset, op)


def test_full_toolset_is_a_toolset() -> None:
    assert isinstance(FullToolset(), Toolset)
    assert isinstance(ReadOnlyToolset(), Toolset)


def test_full_toolset_write_and_read_within_workspace(tmp_path: Path) -> None:
    toolset = FullToolset(workspace_root=str(tmp_path))
    toolset.write_file("notes/hello.txt", "hi")
    assert toolset.read_file("notes/hello.txt") == "hi"


def test_full_toolset_make_dir_within_workspace(tmp_path: Path) -> None:
    toolset = FullToolset(workspace_root=str(tmp_path))
    toolset.make_dir("sub/dir")
    assert (tmp_path / "sub" / "dir").is_dir()
