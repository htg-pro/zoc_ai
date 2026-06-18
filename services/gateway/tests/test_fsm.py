"""Unit tests for the 9-stage Agent-Mode FSM (task 5.1).

These example-based tests pin the behavior task 5.1 owns: the legal transition
table (illegal transitions are unconstructable, R3.2), a conforming stage event
on every stage entry (R3.3), the empty-plan skip (R3.8), the RUN_CHECKS exit-code
branch and remediation return (R5.1/5.5/5.8), and the terminal ERROR_CLOSED path
distinct from DONE (R3.10).

The exhaustive transition/order property (Property 12), the stage-entry-event
property (Property 13), the empty-plan-skip property (Property 16), and the
terminal-error property (Property 18) live in their dedicated property-test
tasks (5.6, 5.7, 5.10, 5.12).
"""

from __future__ import annotations

import pytest
from shared_schema.agent_events import (
    AgentEventModel,
    CommandEvent,
    DoneEvent,
    SummaryEvent,
    ThinkingEvent,
)

from zocai_gateway.fsm import (
    LEGAL,
    AmbiguousTransitionError,
    FSM,
    IllegalTransitionError,
    default_stage_event_factory,
)
from zocai_gateway.stages import Stage

# The canonical happy-path order (R3.2).
HAPPY_PATH = [
    Stage.INTAKE,
    Stage.ANALYZE,
    Stage.MAP_FILES,
    Stage.READ_FILES,
    Stage.PLAN_EDITS,
    Stage.APPLY_EDITS,
    Stage.RUN_CHECKS,
    Stage.SUMMARY,
    Stage.DONE,
]


def make_fsm() -> tuple[FSM, list]:
    """An FSM wired to a recording sink; returns the FSM and the recorded events."""
    recorded: list = []
    fsm = FSM(run_id="r1", emit=recorded.append)
    return fsm, recorded


# -- construction / initial entry (R3.1, R3.3) -------------------------------


def test_fsm_starts_at_initial_stage() -> None:
    fsm, _ = make_fsm()
    assert fsm.initial is Stage.INTAKE
    assert fsm.current is Stage.INTAKE
    assert fsm.is_terminal is False


def test_initial_stage_emits_a_conforming_stage_event() -> None:
    fsm, recorded = make_fsm()
    assert len(recorded) == 1
    # Every emitted event validates against the Event_Contract (R3.3).
    AgentEventModel.model_validate(recorded[0].model_dump(by_alias=True))


def test_custom_initial_stage_is_respected() -> None:
    fsm = FSM(initial=Stage.PLAN_EDITS)
    assert fsm.current is Stage.PLAN_EDITS


# -- legal happy-path progression (R3.2, R3.3) -------------------------------


def test_full_happy_path_advances_in_canonical_order() -> None:
    fsm, recorded = make_fsm()
    visited = [Stage.INTAKE]
    # INTAKE..READ_FILES are deterministic single-successor advances.
    for _ in range(4):
        visited.append(fsm.advance())
    # PLAN_EDITS branch with changes -> APPLY_EDITS.
    visited.append(fsm.plan_complete(has_changes=True))
    visited.append(fsm.advance())  # APPLY_EDITS -> RUN_CHECKS
    visited.append(fsm.run_checks_result(0))  # -> SUMMARY
    visited.append(fsm.advance())  # SUMMARY -> DONE
    assert visited == HAPPY_PATH
    assert fsm.is_terminal is True
    # One stage event per entered stage, in order (R3.3).
    assert [e for e in recorded]  # non-empty
    assert len(recorded) == len(HAPPY_PATH)
    assert [e.seq for e in recorded] == list(range(len(HAPPY_PATH)))


def test_every_stage_entry_emits_one_conforming_event() -> None:
    fsm, recorded = make_fsm()
    fsm.advance()  # ANALYZE
    fsm.advance()  # MAP_FILES
    for ev in recorded:
        AgentEventModel.model_validate(ev.model_dump(by_alias=True))
    assert len(recorded) == 3  # INTAKE, ANALYZE, MAP_FILES


# -- illegal transitions are unconstructable (R3.2) --------------------------


def test_illegal_transition_raises() -> None:
    fsm, _ = make_fsm()
    with pytest.raises(IllegalTransitionError):
        fsm.transition_to(Stage.DONE)  # INTAKE -> DONE is illegal


def test_skipping_a_stage_raises() -> None:
    fsm, _ = make_fsm()
    with pytest.raises(IllegalTransitionError):
        fsm.transition_to(Stage.MAP_FILES)  # INTAKE -> MAP_FILES skips ANALYZE


def test_advance_on_branching_stage_is_ambiguous() -> None:
    fsm = FSM(initial=Stage.PLAN_EDITS)
    with pytest.raises(AmbiguousTransitionError):
        fsm.advance()


def test_can_transition_reflects_legal_table() -> None:
    fsm, _ = make_fsm()
    assert fsm.can_transition(Stage.ANALYZE) is True
    assert fsm.can_transition(Stage.READ_FILES) is False
    assert fsm.legal_targets() == frozenset({Stage.ANALYZE})


# -- empty-plan skip (R3.8) --------------------------------------------------


def test_empty_plan_skips_apply_and_goes_to_run_checks() -> None:
    fsm = FSM(initial=Stage.PLAN_EDITS)
    assert fsm.plan_complete(has_changes=False) is Stage.RUN_CHECKS


def test_non_empty_plan_goes_to_apply_edits() -> None:
    fsm = FSM(initial=Stage.PLAN_EDITS)
    assert fsm.plan_complete(has_changes=True) is Stage.APPLY_EDITS


def test_plan_complete_outside_plan_edits_raises() -> None:
    fsm, _ = make_fsm()  # at INTAKE
    with pytest.raises(IllegalTransitionError):
        fsm.plan_complete(has_changes=False)


# -- RUN_CHECKS branch + remediation (R5.1, R5.5, R5.8) ----------------------


def test_run_checks_zero_exit_goes_to_summary() -> None:
    fsm = FSM(initial=Stage.RUN_CHECKS)
    assert fsm.run_checks_result(0) is Stage.SUMMARY


def test_run_checks_nonzero_exit_goes_to_handle_error() -> None:
    fsm = FSM(initial=Stage.RUN_CHECKS)
    assert fsm.run_checks_result(1) is Stage.HANDLE_ERROR


def test_handle_error_remediates_back_to_plan_edits() -> None:
    fsm = FSM(initial=Stage.HANDLE_ERROR)
    assert fsm.remediate() is Stage.PLAN_EDITS


def test_run_checks_result_outside_run_checks_raises() -> None:
    fsm, _ = make_fsm()  # at INTAKE
    with pytest.raises(IllegalTransitionError):
        fsm.run_checks_result(0)


# -- terminal ERROR_CLOSED path distinct from DONE (R3.10) -------------------


def test_fail_moves_to_error_closed_from_any_non_terminal_stage() -> None:
    for stage in HAPPY_PATH[:-1]:  # every non-DONE happy-path stage
        fsm = FSM(initial=stage)
        assert fsm.fail("boom") is Stage.ERROR_CLOSED
        assert fsm.is_terminal is True


def test_error_closed_is_not_reachable_via_legal_table() -> None:
    fsm = FSM(initial=Stage.SUMMARY)
    with pytest.raises(IllegalTransitionError):
        fsm.transition_to(Stage.ERROR_CLOSED)


def test_error_closed_emits_terminal_error_event_distinct_from_done() -> None:
    fsm, recorded = make_fsm()
    fsm.fail("unrecoverable")
    terminal = recorded[-1]
    assert not isinstance(terminal, DoneEvent)
    assert isinstance(terminal, CommandEvent)
    assert terminal.error_tag == "unrecoverable"
    AgentEventModel.model_validate(terminal.model_dump(by_alias=True))


def test_cannot_fail_from_terminal_stage() -> None:
    fsm = FSM(initial=Stage.DONE)
    with pytest.raises(IllegalTransitionError):
        fsm.fail("too late")


def test_done_has_no_legal_successors() -> None:
    fsm = FSM(initial=Stage.DONE)
    assert fsm.legal_targets() == frozenset()
    assert fsm.is_terminal is True


# -- default stage-event factory shape ---------------------------------------


def test_default_factory_event_kinds_per_stage() -> None:
    assert isinstance(default_stage_event_factory(Stage.DONE, 0, "r", "t"), DoneEvent)
    assert isinstance(
        default_stage_event_factory(Stage.SUMMARY, 0, "r", "t"), SummaryEvent
    )
    assert isinstance(
        default_stage_event_factory(Stage.ANALYZE, 0, "r", "t"), ThinkingEvent
    )
    err = default_stage_event_factory(Stage.ERROR_CLOSED, 0, "r", "t", "why")
    assert isinstance(err, CommandEvent)
    assert err.error_tag == "why"


def test_legal_table_matches_canonical_design_shape() -> None:
    # DONE is terminal; ERROR_CLOSED / PAUSED are not in the legal table.
    assert LEGAL[Stage.DONE] == set()
    assert Stage.ERROR_CLOSED not in LEGAL
    assert Stage.PAUSED not in LEGAL
    assert LEGAL[Stage.PLAN_EDITS] == {Stage.APPLY_EDITS, Stage.RUN_CHECKS}
    assert LEGAL[Stage.RUN_CHECKS] == {Stage.SUMMARY, Stage.HANDLE_ERROR}
