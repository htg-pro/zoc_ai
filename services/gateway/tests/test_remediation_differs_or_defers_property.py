"""Property test for differing remediation or developer defer (task 5.19).

Feature: zocai-ecosystem-rebuild, Property 25: Remediation plan differs from
the prior plan or defers.

**Validates: Requirements 5.6, 5.7**

Design Property 25 (verbatim intent): *For any* prior edit plan and captured
failure, either the remediation plan differs from the prior plan by at least
one added, removed, or modified operation that references the failure, or the
run pauses and emits an event deferring control to the developer.

Strategy
--------
:meth:`zocai_gateway.remediation.RemediationLoop.on_checks_complete` owns the
``HANDLE_ERROR`` remediation decision. We drive the *real* loop (real FSM, real
``EditPlan``/``FailureRecord``, no mocks) over arbitrary triples of

* a ``prior`` edit plan,
* a ``candidate`` plan the injected planner proposes (including ``None``), and
* a captured ``failure`` (command + short log),

and assert the loop's branch is exactly the R5.6/R5.7 contract:

* the candidate is accepted (``HANDLE_ERROR -> PLAN_EDITS``, ``remediated``,
  not deferred, no defer event) **iff** it is not ``None`` and it both differs
  from ``prior`` (``diff_plans(...).differs``) and references the captured
  failure (``plan_references_failure(...)``);
* otherwise the run pauses (``-> PAUSED``), is ``deferred``, and emits exactly
  one ``approval`` defer event handing control to the developer.

The generator deliberately biases the candidate across five shapes — absent,
identical-to-prior, differing-and-referencing, differing-but-failure-ignoring,
and free-form — so both the accept branch and the defer branch are exercised
well beyond the 100-example floor. Logs are kept short so no truncation occurs
and the test can reconstruct the loop's :class:`FailureRecord` exactly.
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

# Small, controlled text domains so plans, paths, and logs collide often enough
# to exercise the diff/reference branches (and stay well under LOG_MAX_CHARS so
# no truncation happens and the failure record is reproducible in the test).
_short_text = st.text(alphabet="abcdef \n", max_size=12)
_paths = st.sampled_from(["a.py", "b.py", "c.py", "d.py"])
_commands = st.sampled_from(["pytest", "cargo build", "tsc", "make", "go test"])

_changes = st.builds(
    PlannedChange, path=_paths, content=_short_text, diff=_short_text
)
_plans = st.builds(
    EditPlan,
    reasoning=_short_text,
    changes=st.lists(_changes, max_size=4).map(tuple),
)


@st.composite
def _scenario(draw: st.DrawFn) -> tuple[EditPlan, EditPlan | None, FailureRecord]:
    """Draw a (prior, candidate, failure) triple biased across both branches."""
    command = draw(_commands)
    log = draw(_short_text)
    failure = FailureRecord(command=command, exit_code=draw(st.integers(min_value=1)), log=log)
    prior = draw(_plans)

    shape = draw(
        st.sampled_from(
            ["none", "identical", "differs_refs", "differs_no_refs", "free"]
        )
    )
    if shape == "none":
        candidate: EditPlan | None = None
    elif shape == "identical":
        candidate = prior
    elif shape == "differs_refs":
        # Reference the failed command in the reasoning and change an edit so the
        # candidate both differs and references the failure (the accept branch).
        candidate = EditPlan(
            reasoning=f"fix failing {command}",
            changes=prior.changes + (PlannedChange(path="z.py", content=draw(_short_text)),),
        )
    elif shape == "differs_no_refs":
        # Structurally different but mentions nothing from the failure.
        candidate = EditPlan(
            reasoning="unrelated",
            changes=(PlannedChange(path="zz.py", content="qqq"),),
        )
    else:
        candidate = draw(_plans)
    return prior, candidate, failure


def _make_loop(candidate: EditPlan | None) -> tuple[RemediationLoop, list[ApprovalEvent]]:
    """A loop at RUN_CHECKS whose planner always proposes ``candidate``."""
    recorded: list[ApprovalEvent] = []
    fsm = FSM(initial=Stage.RUN_CHECKS, run_id="r1")
    loop = RemediationLoop(
        fsm=fsm,
        planner=lambda prior, failure: candidate,
        run_id="r1",
        emit=recorded.append,  # type: ignore[arg-type]
        next_seq=itertools.count().__next__,
    )
    return loop, recorded


@settings(max_examples=200)
@given(scenario=_scenario())
def test_remediation_differs_and_references_or_defers(
    scenario: tuple[EditPlan, EditPlan | None, FailureRecord],
) -> None:
    """Property 25: accept a differing, failure-referencing plan; else defer (R5.6/5.7).

    Feature: zocai-ecosystem-rebuild, Property 25

    **Validates: Requirements 5.6, 5.7**
    """
    prior, candidate, failure = scenario

    loop, recorded = _make_loop(candidate)
    outcome = loop.on_checks_complete(
        failure.exit_code,
        command=failure.command,
        log=failure.log,
        prior_plan=prior,
    )

    # The R5.6 acceptance gate: a non-None plan that differs AND references the
    # captured failure. (Logs are short, so the loop's FailureRecord equals
    # ``failure`` and this reconstruction matches the loop's own evaluation.)
    should_accept = (
        candidate is not None
        and diff_plans(prior, candidate).differs
        and plan_references_failure(candidate, failure)
    )

    approvals = [e for e in recorded if isinstance(e, ApprovalEvent)]

    if should_accept:
        # R5.5/5.6: HANDLE_ERROR -> PLAN_EDITS, remediation applied, no defer.
        assert outcome.remediated is True
        assert outcome.deferred is False
        assert outcome.stage is Stage.PLAN_EDITS
        assert loop.fsm.current is Stage.PLAN_EDITS
        assert outcome.plan is candidate
        assert outcome.delta is not None and outcome.delta.differs is True
        assert outcome.defer_event is None
        assert approvals == []
    else:
        # R5.7: no differing/referencing plan -> pause and defer to the developer.
        assert outcome.deferred is True
        assert outcome.remediated is False
        assert outcome.stage is Stage.PAUSED
        assert loop.fsm.current is Stage.PAUSED
        # Exactly one approval event was emitted, deferring control.
        assert len(approvals) == 1
        assert outcome.defer_event is approvals[0]
        assert "developer input required" in approvals[0].prompt
