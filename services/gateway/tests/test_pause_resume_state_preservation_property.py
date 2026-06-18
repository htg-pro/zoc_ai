"""Property test for pause-resume run-state preservation (task 5.15).

Feature: zocai-ecosystem-rebuild, Property 21: Pause-resume preserves run state.

**Validates: Requirements 4.5, 4.6**

Design Property 21 (verbatim intent): *For any* run paused for an exceeded
budget, the retained stage, file markers, patch diffs, and both counters equal
the live values at pause time, and resuming continues from the retained stage
with the retained state.

Strategy
--------
We drive an :class:`Orchestrator` (over a :class:`FullToolset` confined to a
fresh temporary workspace) all the way to a budget pause, accumulating
*arbitrary* run state on the way:

* an arbitrary non-terminal FSM stage the run sits in (the stage R4.5 retains
  and R4.6 resumes from);
* an arbitrary mix of counted file reads and writes (writes carry arbitrary
  content and an optional unified-diff, so the active-file markers and the
  patch-diff array are both built up to arbitrary, deduplicated contents);
* an arbitrary number of counted error-recovery entries.

Two pause kinds are generated:

* ``FILE`` — exactly ``FILE_CEILING`` (20) file ops are performed (with
  ``0..ERROR_CEILING`` recoveries mixed in below the error ceiling), then the
  21st file op is what trips the pause before it can start (R4.3);
* ``ERROR`` — an arbitrary ``0..FILE_CEILING-1`` file ops are performed, then
  exactly ``ERROR_CEILING`` (3) recoveries, then the 4th recovery is what trips
  the pause before it can start (R4.4).

A blocking op performs no work (no marker, no diff, no counter increment), so
the orchestrator's live state captured immediately *before* the trip equals its
state *at* pause time. We assert the snapshotted :class:`RetainedState` equals
that captured live state field-for-field (R4.5), then call
:meth:`Orchestrator.confirm_continue` and assert it returns the retained stage,
restores the retained markers/diffs/counters exactly, and lets the run make one
more op of progress (R4.6).

A fresh ``TemporaryDirectory`` per example keeps each generated workspace
isolated.
"""

from __future__ import annotations

import itertools
import tempfile
from pathlib import Path

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from zocai_gateway.edits import EditCoordinator, PlannedChange
from zocai_gateway.fsm import FSM
from zocai_gateway.orchestrator import Budget, BudgetKind, Orchestrator
from zocai_gateway.stages import Stage
from zocai_gateway.toolsets import FullToolset

# Stages a run can actually sit in when it pauses: any non-terminal stage (a
# terminal DONE / ERROR_CLOSED run never reaches the budget seam). PAUSED is
# excluded as a starting stage since the run is what *enters* the pause.
_NON_TERMINAL_STAGES = [
    Stage.INTAKE,
    Stage.ANALYZE,
    Stage.MAP_FILES,
    Stage.READ_FILES,
    Stage.PLAN_EDITS,
    Stage.APPLY_EDITS,
    Stage.RUN_CHECKS,
    Stage.SUMMARY,
    Stage.HANDLE_ERROR,
]

# A single file op: either a counted read of a pre-existing file, or a counted
# write of arbitrary content with an optional unified-diff payload.
_file_op = st.one_of(
    st.fixed_dictionaries({"op": st.just("read")}),
    st.fixed_dictionaries(
        {
            "op": st.just("write"),
            "content": st.text(max_size=48),
            "diff": st.text(max_size=24),  # "" => marker but no patch-diff
        }
    ),
)


def _make_orchestrator(root: Path, initial: Stage) -> Orchestrator:
    """An Orchestrator over a workspace toolset starting at ``initial``."""
    toolset = FullToolset(workspace_root=root)
    return Orchestrator(
        fsm=FSM(initial=initial, run_id="r1"),
        edits=EditCoordinator(toolset=toolset, run_id="r1"),
        run_id="r1",
        next_seq=itertools.count().__next__,
    )


def _perform_file_op(orch: Orchestrator, root: Path, index: int, spec: dict) -> None:
    """Perform one *successful* counted file op against a unique path."""
    if spec["op"] == "read":
        target = root / f"r{index}.txt"
        target.write_text(f"seed-{index}", encoding="utf-8")  # exist for the read
        assert orch.read_file(target.name) is not None
    else:
        assert (
            orch.write_file(
                PlannedChange(
                    path=f"w{index}.txt",
                    content=spec["content"],
                    diff=spec["diff"],
                )
            )
            is True
        )


@st.composite
def _scenarios(draw: st.DrawFn) -> dict:
    """A pause scenario: a stage, a pause kind, and the ops leading up to it."""
    kind = draw(st.sampled_from([BudgetKind.FILE, BudgetKind.ERROR]))
    initial = draw(st.sampled_from(_NON_TERMINAL_STAGES))
    if kind is BudgetKind.FILE:
        # Fill the whole file window, with some (sub-ceiling) recoveries mixed in.
        file_ops = draw(
            st.lists(_file_op, min_size=Budget.FILE_CEILING, max_size=Budget.FILE_CEILING)
        )
        recoveries = draw(st.integers(min_value=0, max_value=Budget.ERROR_CEILING))
    else:
        # Arbitrary (sub-ceiling) file ops, then fill the whole error window.
        file_ops = draw(
            st.lists(_file_op, min_size=0, max_size=Budget.FILE_CEILING - 1)
        )
        recoveries = Budget.ERROR_CEILING
    return {
        "kind": kind,
        "initial": initial,
        "file_ops": file_ops,
        "recoveries": recoveries,
    }


@given(scenario=_scenarios())
@settings(max_examples=150, suppress_health_check=[HealthCheck.too_slow])
def test_pause_resume_preserves_run_state(scenario: dict) -> None:
    """Property 21 (R4.5, R4.6): retained state equals live pause state and resumes.

    Feature: zocai-ecosystem-rebuild, Property 21

    **Validates: Requirements 4.5, 4.6**
    """
    kind: BudgetKind = scenario["kind"]
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        orch = _make_orchestrator(root, scenario["initial"])

        # Accumulate arbitrary run state without tripping the pause yet.
        for i, spec in enumerate(scenario["file_ops"]):
            _perform_file_op(orch, root, i, spec)
        for _ in range(scenario["recoveries"]):
            assert orch.enter_error_recovery() is True
        assert orch.is_paused is False

        # Capture the LIVE values at (i.e. immediately before) pause time. The
        # blocking op that follows performs no work, so these are the pause-time
        # values the snapshot must equal (R4.5).
        live_stage = orch.fsm.current
        live_markers = tuple(orch.active_file_markers)
        live_diffs = tuple(orch.patch_diffs)
        live_file_iters = orch.budget.file_iterations
        live_error_recs = orch.budget.error_recoveries

        # Trip the pause: the next op of the saturated kind blocks before it
        # starts (R4.3 / R4.4) and snapshots the run state (R4.5).
        if kind is BudgetKind.FILE:
            tripped = orch.write_file(PlannedChange(path="overflow.txt", content="x"))
            assert not (root / "overflow.txt").exists()  # nothing started
        else:
            tripped = orch.enter_error_recovery()
        assert tripped is False
        assert orch.is_paused is True

        # R4.5: the retained state equals the live values at pause time, field
        # for field — stage, file markers, patch diffs, and BOTH counters.
        retained = orch.retained_state
        assert retained is not None
        assert retained.kind is kind
        assert retained.stage == live_stage
        assert retained.active_file_markers == live_markers
        assert retained.patch_diffs == live_diffs
        assert retained.file_iterations == live_file_iters
        assert retained.error_recoveries == live_error_recs
        # The blocked op neither advanced a counter nor mutated retained state.
        assert orch.budget.file_iterations == live_file_iters
        assert orch.budget.error_recoveries == live_error_recs

        # R4.6: confirming continuation resumes FROM the retained stage USING
        # the retained run state.
        resume_stage = orch.confirm_continue()
        assert resume_stage == retained.stage
        assert orch.is_paused is False
        assert tuple(orch.active_file_markers) == retained.active_file_markers
        assert tuple(orch.patch_diffs) == retained.patch_diffs
        assert orch.budget.file_iterations == retained.file_iterations
        assert orch.budget.error_recoveries == retained.error_recoveries

        # R4.6: with the retained state restored and a fresh window granted, the
        # resumed run makes one more op of progress of the kind that paused it.
        if kind is BudgetKind.FILE:
            assert orch.write_file(PlannedChange(path="after.txt", content="ok")) is True
            assert orch.budget.file_iterations == retained.file_iterations + 1
            assert orch.budget.error_recoveries == retained.error_recoveries
        else:
            assert orch.enter_error_recovery() is True
            assert orch.budget.error_recoveries == retained.error_recoveries + 1
            assert orch.budget.file_iterations == retained.file_iterations
