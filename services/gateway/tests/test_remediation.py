"""Unit tests for the Error Remediation Loop (task 5.5, R5).

These example-based tests pin the behavior task 5.5 owns:

- a zero ``RUN_CHECKS`` exit transitions to ``SUMMARY`` (R5.8);
- a non-zero exit transitions to ``HANDLE_ERROR`` (R5.1);
- entering ``HANDLE_ERROR`` increments the recovery count and fires the hook (R5.2);
- the failure is captured with its log truncated to 65,536 chars (R5.3);
- the captured failure is appended to the Session_Diary (R5.4);
- a differing, failure-referencing remediation returns to ``PLAN_EDITS`` (R5.5/5.6);
- a non-differing / failure-ignoring / absent plan pauses and defers (R5.7).

The dedicated property tests (Property 24, 25) live in tasks 5.18/5.19.
"""

from __future__ import annotations

import itertools

from shared_schema.agent_events import AgentEventModel, ApprovalEvent
from shared_schema.agent_events import AgentEvent as AgentEventUnion

from zocai_gateway.edits import EditPlan, PlannedChange
from zocai_gateway.fsm import FSM
from zocai_gateway.memory.state_wrapper import LOG_MAX_CHARS, FailureRecord
from zocai_gateway.remediation import (
    RemediationLoop,
    diff_plans,
    plan_references_failure,
)
from zocai_gateway.stages import Stage


def make_loop(
    planner=None,
) -> tuple[RemediationLoop, list[AgentEventUnion], list[dict[str, object]]]:
    """A loop whose FSM starts at RUN_CHECKS, wired to recording sinks."""
    fsm = FSM(initial=Stage.RUN_CHECKS, run_id="r1")
    recorded: list[AgentEventUnion] = []
    diary: list[dict[str, object]] = []
    seq = itertools.count().__next__
    kwargs: dict[str, object] = {
        "fsm": fsm,
        "diary": diary.append,
        "run_id": "r1",
        "emit": recorded.append,
        "next_seq": seq,
    }
    if planner is not None:
        kwargs["planner"] = planner
    return RemediationLoop(**kwargs), recorded, diary  # type: ignore[arg-type]


# -- R5.8: zero exit -> SUMMARY ----------------------------------------------


def test_zero_exit_transitions_to_summary() -> None:
    loop, recorded, diary = make_loop()
    outcome = loop.on_checks_complete(0)
    assert outcome.stage is Stage.SUMMARY
    assert loop.fsm.current is Stage.SUMMARY
    # No failure captured, no recovery counted, nothing deferred (R5.8).
    assert outcome.failure is None
    assert loop.recoveries == 0
    assert diary == []
    assert outcome.deferred is False


# -- R5.1: non-zero exit -> HANDLE_ERROR -------------------------------------


def test_nonzero_exit_enters_handle_error() -> None:
    # A planner that defers so the loop stops at the defer path; we only assert
    # that HANDLE_ERROR was entered (the recovery was counted on that entry).
    loop, _, _ = make_loop()
    loop.on_checks_complete(1, command="pytest", log="boom")
    # The loop counted exactly one HANDLE_ERROR entry (R5.1 happened, R5.2).
    assert loop.recoveries == 1


# -- R5.2: HANDLE_ERROR entry increments the recovery count + hook -----------


def test_handle_error_increments_recoveries_and_fires_hook() -> None:
    fsm = FSM(initial=Stage.RUN_CHECKS)
    hits = []
    loop = RemediationLoop(fsm=fsm, on_recovery=lambda: hits.append(1))
    loop.on_checks_complete(2, command="cargo build", log="error[E0382]")
    assert loop.recoveries == 1
    assert hits == [1]


# -- R5.3: capture failure, log truncated to 65,536 chars --------------------


def test_failure_capture_truncates_log_to_limit() -> None:
    loop, _, _ = make_loop()
    huge = "x" * (LOG_MAX_CHARS + 5_000)
    outcome = loop.on_checks_complete(1, command="make", log=huge)
    assert outcome.failure is not None
    assert outcome.failure.command == "make"
    assert outcome.failure.exit_code == 1
    assert len(outcome.failure.log) == LOG_MAX_CHARS
    assert loop.recorded_failures[-1] is outcome.failure


# -- R5.4: failure appended to the Session_Diary -----------------------------


def test_failure_appended_to_session_diary() -> None:
    loop, _, diary = make_loop()
    loop.on_checks_complete(3, command="tsc", log="TS2322: type error")
    assert len(diary) == 1
    entry = diary[0]
    assert entry["type"] == "command"
    assert entry["command"] == "tsc"
    assert entry["exitCode"] == 3
    assert entry["log"] == "TS2322: type error"
    assert entry["runId"] == "r1"


# -- R5.5/5.6: differing, failure-referencing remediation -> PLAN_EDITS -------


def test_differing_remediation_returns_to_plan_edits() -> None:
    prior = EditPlan(
        reasoning="initial",
        changes=(PlannedChange(path="a.py", content="x = 1"),),
    )

    def planner(prev: EditPlan, failure: FailureRecord) -> EditPlan:
        # References the failed command and modifies the edit -> valid (R5.6).
        return EditPlan(
            reasoning=f"fix for failing {failure.command}",
            changes=(PlannedChange(path="a.py", content="x = 2"),),
        )

    loop, _, _ = make_loop(planner=planner)
    outcome = loop.on_checks_complete(1, command="pytest", log="AssertionError", prior_plan=prior)

    assert outcome.remediated is True
    assert outcome.deferred is False
    assert outcome.stage is Stage.PLAN_EDITS
    assert loop.fsm.current is Stage.PLAN_EDITS
    assert outcome.plan is not None and outcome.delta is not None
    # The one modified edit is the difference referencing the failure (R5.6).
    assert outcome.delta.differs is True
    assert outcome.delta.operation_count == 1


# -- R5.7: planner returns None -> pause + defer -----------------------------


def test_no_plan_pauses_and_defers_to_developer() -> None:
    loop, recorded, _ = make_loop()  # default planner always returns None
    outcome = loop.on_checks_complete(1, command="pytest", log="boom")

    assert outcome.deferred is True
    assert outcome.remediated is False
    assert outcome.stage is Stage.PAUSED
    assert loop.fsm.current is Stage.PAUSED
    # A conforming approval event deferring to the developer was emitted (R5.7).
    approvals = [e for e in recorded if isinstance(e, ApprovalEvent)]
    assert len(approvals) == 1
    assert outcome.defer_event is approvals[0]
    assert "developer input required" in approvals[0].prompt
    AgentEventModel.model_validate(approvals[0].model_dump(by_alias=True))


# -- R5.7: a non-differing plan also defers ----------------------------------


def test_non_differing_plan_defers() -> None:
    prior = EditPlan(changes=(PlannedChange(path="a.py", content="x = 1"),))

    def planner(prev: EditPlan, failure: FailureRecord) -> EditPlan:
        return prev  # identical -> does not differ -> defer (R5.7)

    loop, _, _ = make_loop(planner=planner)
    outcome = loop.on_checks_complete(1, command="pytest", log="boom", prior_plan=prior)
    assert outcome.deferred is True
    assert outcome.stage is Stage.PAUSED


# -- R5.7: a differing plan that ignores the failure defers ------------------


def test_differing_plan_that_ignores_failure_defers() -> None:
    prior = EditPlan(changes=(PlannedChange(path="a.py", content="x = 1"),))

    def planner(prev: EditPlan, failure: FailureRecord) -> EditPlan:
        # Structurally different but references nothing from the failure (R5.6 unmet).
        return EditPlan(
            reasoning="unrelated tweak",
            changes=(PlannedChange(path="b.py", content="y = 9"),),
        )

    loop, _, _ = make_loop(planner=planner)
    outcome = loop.on_checks_complete(1, command="pytest-xyz", log="ImportError", prior_plan=prior)
    assert outcome.deferred is True
    assert outcome.stage is Stage.PAUSED


# -- plan diffing helper ------------------------------------------------------


def test_diff_plans_classifies_add_remove_modify() -> None:
    prior = EditPlan(
        changes=(
            PlannedChange(path="keep.py", content="same"),
            PlannedChange(path="mod.py", content="old"),
            PlannedChange(path="gone.py", content="bye"),
        )
    )
    proposed = EditPlan(
        changes=(
            PlannedChange(path="keep.py", content="same"),  # unchanged -> ignored
            PlannedChange(path="mod.py", content="new"),  # modified
            PlannedChange(path="fresh.py", content="hi"),  # added
        )
    )
    delta = diff_plans(prior, proposed)
    assert [c.path for c in delta.added] == ["fresh.py"]
    assert [c.path for c in delta.removed] == ["gone.py"]
    assert [(p.path, q.content) for p, q in delta.modified] == [("mod.py", "new")]
    assert delta.differs is True
    assert delta.operation_count == 3


def test_identical_plans_do_not_differ() -> None:
    plan = EditPlan(changes=(PlannedChange(path="a.py", content="x"),))
    assert diff_plans(plan, plan).differs is False


# -- references-failure helper ------------------------------------------------


def test_plan_references_failure_by_command_or_log_line() -> None:
    failure = FailureRecord(command="pytest tests/", exit_code=1, log="E   AssertionError: nope")
    by_command = EditPlan(reasoning="rerun pytest tests/ after fix")
    by_log_line = EditPlan(
        changes=(PlannedChange(path="t.py", content="# E   AssertionError: nope"),)
    )
    unrelated = EditPlan(reasoning="something else entirely")
    assert plan_references_failure(by_command, failure) is True
    assert plan_references_failure(by_log_line, failure) is True
    assert plan_references_failure(unrelated, failure) is False
