"""Property test for the stage projection (zoc-ai-agent-chat-overhaul, Property 15).

Feature: zoc-ai-agent-chat-overhaul, Property 15: The stage projection is a
well-formed, monotone report.

**Validates: Requirements 7.1, 7.2, 7.3, 7.4**

The real :class:`FSM` (with ``emit_stage_reports`` on) is driven along randomized
*legal* transition sequences; the emitted :class:`StageEvent` frames are folded
by :func:`project_stages`, and the fold's invariants are asserted for every
drawn sequence.
"""

from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st
from shared_schema.agent_events import StageEvent
from zocai_gateway.fsm import FSM
from zocai_gateway.stage_view import (
    REPORTED_STAGE_ORDER,
    StageState,
    project_stages,
)
from zocai_gateway.stages import Stage

_MAX_STEPS = 40


def _drive_legal_walk(data: st.DataObject) -> list[StageEvent]:
    """Drive the FSM along a random legal walk, returning its emitted stage frames."""
    fsm = FSM(run_id="r-prop15", emit_stage_reports=True)
    steps = data.draw(st.integers(min_value=0, max_value=_MAX_STEPS))
    for _ in range(steps):
        if fsm.is_terminal:
            break
        escape = data.draw(st.sampled_from(["continue", "continue", "continue", "fail"]))
        if escape == "fail":
            fsm.fail("randomized unrecoverable error")
            break
        current = fsm.current
        if current is Stage.PLAN_EDITS:
            fsm.plan_complete(has_changes=data.draw(st.booleans()))
        elif current is Stage.RUN_CHECKS:
            fsm.run_checks_result(data.draw(st.integers(min_value=-8, max_value=8)))
        elif current is Stage.HANDLE_ERROR:
            fsm.remediate()
        else:
            if not fsm.legal_targets():
                break
            fsm.advance()
    return list(fsm.stage_events)


@settings(max_examples=200)
@given(data=st.data())
def test_stage_projection_well_formed_and_monotone(data: st.DataObject) -> None:
    """Property 15: the projection is a well-formed, monotone six-stage report.

    Feature: zoc-ai-agent-chat-overhaul, Property 15

    **Validates: Requirements 7.1, 7.2, 7.3, 7.4**
    """
    stage_events = _drive_legal_walk(data)
    reports = project_stages(stage_events)

    # R7.1: all six reported stages present, in canonical order, one state each.
    assert tuple(r.stage for r in reports) == REPORTED_STAGE_ORDER

    # R7.2: at most one stage active.
    assert sum(1 for r in reports if r.state is StageState.ACTIVE) <= 1

    # R7.3: every failed stage carries a non-empty reason.
    for report in reports:
        if report.state is StageState.FAILED:
            assert report.reason

    # R7.4: a stage that once reached SUCCEEDED never reports as anything else.
    succeeded_seen: set = set()
    for i in range(len(stage_events) + 1):
        by_stage = {r.stage: r.state for r in project_stages(stage_events[:i])}
        for stage in succeeded_seen:
            assert by_stage[stage] is StageState.SUCCEEDED
        for stage, state in by_stage.items():
            if state is StageState.SUCCEEDED:
                succeeded_seen.add(stage)
