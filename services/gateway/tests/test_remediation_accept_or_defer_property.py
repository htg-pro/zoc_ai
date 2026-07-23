"""Property test for accept-or-defer remediation (Epic 5, task 5.4).

Feature: agent-reasoning-engine, Property 15.

**Validates: Requirements 7.5, 7.7**

A remediation is accepted (HANDLE_ERROR → PLAN_EDITS) if and only if the
candidate plan differs from the prior plan by at least one edit operation and
references the captured failure; otherwise the run pauses (→ PAUSED) and emits
an ``approval`` event deferring to the developer. Named distinctly from
``test_remediation_differs_or_defers_property.py`` (the zocai-ecosystem-rebuild
suite) so the two do not collide.
"""

from __future__ import annotations

import itertools

from hypothesis import given, settings
from hypothesis import strategies as st
from shared_schema.agent_events import ApprovalEvent
from zocai_gateway.edits import EditPlan, PlannedChange
from zocai_gateway.fsm import FSM
from zocai_gateway.memory.state_wrapper import FailureRecord
from zocai_gateway.remediation import (
    RemediationLoop,
    diff_plans,
    plan_references_failure,
)
from zocai_gateway.stages import Stage

_SHORT = st.text(alphabet="abcdef \n", max_size=12)
_PATHS = st.sampled_from(["a.py", "b.py", "c.py", "d.py"])
_COMMANDS = st.sampled_from(["pytest", "cargo build", "tsc", "make", "go test"])
_CHANGES = st.builds(PlannedChange, path=_PATHS, content=_SHORT, diff=_SHORT)
_PLANS = st.builds(EditPlan, reasoning=_SHORT, changes=st.lists(_CHANGES, max_size=4).map(tuple))


@st.composite
def _scenario(draw: st.DrawFn) -> tuple[EditPlan, EditPlan | None, FailureRecord]:
    command = draw(_COMMANDS)
    failure = FailureRecord(
        command=command, exit_code=draw(st.integers(min_value=1, max_value=99)), log=draw(_SHORT)
    )
    prior = draw(_PLANS)
    shape = draw(
        st.sampled_from(["none", "identical", "differs_refs", "differs_no_refs", "free"])
    )
    if shape == "none":
        candidate: EditPlan | None = None
    elif shape == "identical":
        candidate = prior
    elif shape == "differs_refs":
        candidate = EditPlan(
            reasoning=f"fix failing {command}",
            changes=(*prior.changes, PlannedChange(path="z.py", content=draw(_SHORT))),
        )
    elif shape == "differs_no_refs":
        candidate = EditPlan(reasoning="unrelated", changes=(PlannedChange(path="zz.py", content="qqq"),))
    else:
        candidate = draw(_PLANS)
    return prior, candidate, failure


@settings(max_examples=200)
@given(scenario=_scenario())
def test_remediation_accepted_iff_differs_and_references_else_defers(
    scenario: tuple[EditPlan, EditPlan | None, FailureRecord],
) -> None:
    """Property 15: accept a differing, failure-referencing plan; else defer.

    Feature: agent-reasoning-engine, Property 15

    **Validates: Requirements 7.5, 7.7**
    """
    prior, candidate, failure = scenario
    recorded: list[ApprovalEvent] = []
    loop = RemediationLoop(
        fsm=FSM(initial=Stage.RUN_CHECKS, run_id="r"),
        planner=lambda _prior, _failure: candidate,
        run_id="r",
        emit=recorded.append,  # type: ignore[arg-type]
        next_seq=itertools.count().__next__,
    )
    outcome = loop.on_checks_complete(
        failure.exit_code, command=failure.command, log=failure.log, prior_plan=prior
    )

    should_accept = (
        candidate is not None
        and diff_plans(prior, candidate).differs
        and plan_references_failure(candidate, failure)
    )
    approvals = [e for e in recorded if isinstance(e, ApprovalEvent)]

    if should_accept:
        assert outcome.remediated is True
        assert outcome.deferred is False
        assert outcome.stage is Stage.PLAN_EDITS  # R7.5
        assert loop.fsm.current is Stage.PLAN_EDITS
        assert approvals == []
    else:
        assert outcome.deferred is True  # R7.7
        assert outcome.stage is Stage.PAUSED
        assert loop.fsm.current is Stage.PAUSED
        assert len(approvals) == 1
        assert outcome.defer_event is approvals[0]
