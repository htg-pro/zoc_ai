"""Unit tests for the Orchestrator execution budget (task 5.4, Requirement 4).

These example-based tests pin the behavior task 5.4 owns:

- both counters start at zero (R4.1, R4.2);
- each gated file read/write increments ``file_iterations`` by one (R4.1);
- each error-recovery entry increments ``error_recoveries`` by one (R4.2/R5.2);
- the run pauses before the next operation at the 20 / 3 ceilings and emits a
  budget-exceeded event requiring confirmation (R4.3, R4.4);
- the paused run retains stage, markers, diffs, and counters (R4.5);
- confirmation resumes from the retained stage using the retained state (R4.6).

The dedicated property tests (Property 19, 20, 21) live in tasks 5.13-5.15.
"""

from __future__ import annotations

import itertools
from pathlib import Path

from shared_schema.agent_events import AgentEventModel, ApprovalEvent

from zocai_gateway.edits import EditCoordinator, PlannedChange
from zocai_gateway.fsm import FSM
from zocai_gateway.orchestrator import (
    Budget,
    BudgetKind,
    NotPausedError,
    Orchestrator,
)
from zocai_gateway.stages import Stage
from zocai_gateway.toolsets import FullToolset


def make_orchestrator(
    tmp_path: Path, *, initial: Stage = Stage.READ_FILES
) -> tuple[Orchestrator, list[ApprovalEvent]]:
    """An Orchestrator over a workspace toolset wired to a recording sink."""
    recorded: list[ApprovalEvent] = []
    seq = itertools.count().__next__
    toolset = FullToolset(workspace_root=tmp_path)
    fsm = FSM(initial=initial, run_id="r1")
    edits = EditCoordinator(toolset=toolset, run_id="r1")
    orch = Orchestrator(
        fsm=fsm,
        edits=edits,
        run_id="r1",
        emit=recorded.append,  # type: ignore[arg-type]
        next_seq=seq,
    )
    return orch, recorded


# -- counters start at zero (R4.1, R4.2) -------------------------------------


def test_counters_start_at_zero(tmp_path: Path) -> None:
    orch, _ = make_orchestrator(tmp_path)
    assert orch.budget.file_iterations == 0
    assert orch.budget.error_recoveries == 0
    assert orch.is_paused is False


# -- file iterations increment per read/write (R4.1) -------------------------


def test_file_read_and_write_increment_file_iterations(tmp_path: Path) -> None:
    orch, _ = make_orchestrator(tmp_path)
    (tmp_path / "a.txt").write_text("alpha", encoding="utf-8")

    text = orch.read_file("a.txt")
    assert text == "alpha"
    assert orch.budget.file_iterations == 1

    wrote = orch.write_file(PlannedChange(path="b.txt", content="beta", diff="+beta"))
    assert wrote is True
    assert orch.budget.file_iterations == 2
    assert (tmp_path / "b.txt").read_text(encoding="utf-8") == "beta"
    # markers + diffs tracked for retention (R4.5).
    assert orch.active_file_markers == ["a.txt", "b.txt"]
    assert [d.path for d in orch.patch_diffs] == ["b.txt"]


# -- error recovery increments per HANDLE_ERROR entry (R4.2, R5.2) -----------


def test_error_recovery_entry_increments_recoveries(tmp_path: Path) -> None:
    orch, _ = make_orchestrator(tmp_path)
    assert orch.enter_error_recovery() is True
    assert orch.budget.error_recoveries == 1
    assert orch.enter_error_recovery() is True
    assert orch.budget.error_recoveries == 2


# -- file ceiling pauses before the 21st op and emits an approval (R4.3) -----


def test_file_ceiling_pauses_before_next_iteration(tmp_path: Path) -> None:
    orch, recorded = make_orchestrator(tmp_path, initial=Stage.READ_FILES)
    # 20 successful writes consume the whole window.
    for i in range(Budget.FILE_CEILING):
        assert orch.write_file(PlannedChange(path=f"f{i}.txt", content=str(i))) is True
    assert orch.budget.file_iterations == 20
    assert orch.is_paused is False
    assert recorded == []

    # The 21st op pauses before doing anything and emits a budget event.
    blocked = orch.write_file(PlannedChange(path="overflow.txt", content="x"))
    assert blocked is False
    assert not (tmp_path / "overflow.txt").exists()  # not started (R4.3)
    assert orch.budget.file_iterations == 20  # not incremented on a blocked op
    assert orch.is_paused is True
    assert len(recorded) == 1
    event = recorded[0]
    assert isinstance(event, ApprovalEvent)
    assert "file" in event.prompt and "20" in event.prompt
    # conforms to the Event_Contract (R6.2).
    AgentEventModel.model_validate(event.model_dump(by_alias=True))


# -- error ceiling pauses before the 4th recovery and emits an approval (R4.4)


def test_error_ceiling_pauses_before_next_recovery(tmp_path: Path) -> None:
    orch, recorded = make_orchestrator(tmp_path)
    for _ in range(Budget.ERROR_CEILING):
        assert orch.enter_error_recovery() is True
    assert orch.budget.error_recoveries == 3
    assert orch.is_paused is False

    blocked = orch.enter_error_recovery()
    assert blocked is False
    assert orch.budget.error_recoveries == 3  # not incremented on a blocked entry
    assert orch.is_paused is True
    assert len(recorded) == 1
    assert "error" in recorded[0].prompt and "3" in recorded[0].prompt


# -- paused run retains stage / markers / diffs / counters (R4.5) ------------


def test_pause_retains_run_state(tmp_path: Path) -> None:
    orch, _ = make_orchestrator(tmp_path, initial=Stage.PLAN_EDITS)
    for i in range(Budget.FILE_CEILING):
        orch.write_file(PlannedChange(path=f"f{i}.txt", content=str(i), diff=f"+{i}"))
    orch.write_file(PlannedChange(path="overflow.txt", content="x"))  # triggers pause

    retained = orch.retained_state
    assert retained is not None
    assert retained.kind is BudgetKind.FILE
    assert retained.stage is Stage.PLAN_EDITS
    assert retained.file_iterations == 20
    assert retained.error_recoveries == 0
    assert len(retained.active_file_markers) == 20
    assert len(retained.patch_diffs) == 20


# -- confirmation resumes from the retained stage and lets the run proceed (R4.6)


def test_confirm_continue_resumes_from_retained_stage(tmp_path: Path) -> None:
    orch, _ = make_orchestrator(tmp_path, initial=Stage.PLAN_EDITS)
    for i in range(Budget.FILE_CEILING):
        orch.write_file(PlannedChange(path=f"f{i}.txt", content=str(i)))
    orch.write_file(PlannedChange(path="overflow.txt", content="x"))  # pause
    assert orch.is_paused is True

    resume_stage = orch.confirm_continue()
    assert resume_stage is Stage.PLAN_EDITS
    assert orch.is_paused is False
    # Cumulative counter is preserved (R4.5); the run can now proceed (R4.6).
    assert orch.budget.file_iterations == 20
    proceeded = orch.write_file(PlannedChange(path="after.txt", content="ok"))
    assert proceeded is True
    assert orch.budget.file_iterations == 21
    assert (tmp_path / "after.txt").read_text(encoding="utf-8") == "ok"


def test_confirm_continue_on_live_run_raises(tmp_path: Path) -> None:
    orch, _ = make_orchestrator(tmp_path)
    try:
        orch.confirm_continue()
    except NotPausedError:
        pass
    else:  # pragma: no cover - explicit failure if no error raised
        raise AssertionError("expected NotPausedError on a live run")
