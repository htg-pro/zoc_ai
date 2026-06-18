"""Property test for the HANDLE_ERROR diary + return transition (task 5.18).

Feature: zocai-ecosystem-rebuild, Property 24: HANDLE_ERROR records to the diary
and returns to PLAN_EDITS.

**Validates: Requirements 5.4, 5.5**

Design Property 24 (verbatim intent): *For any* HANDLE_ERROR execution that
produces a remediation, the failure details are appended to the Session_Diary
(R5.4) and the FSM transitions back to PLAN_EDITS (R5.5).

Strategy
--------
:meth:`zocai_gateway.remediation.RemediationLoop.on_checks_complete` owns this
behavior. We drive the real loop (no mocks) wired to a recording diary sink,
over arbitrary non-zero exit codes, failed commands, compiler logs, and prior
edit plans. For each example a *differing, failure-referencing* planner is
supplied — it embeds the failed command in its reasoning (so the R5.6
"references the captured failure" gate is met) and adds a sentinel change absent
from the prior plan (so the R5.6 "differs by ≥1 operation" gate is met) — which
is exactly the precondition Property 24 quantifies over: a HANDLE_ERROR
execution that *produces a remediation*.

We then assert the two post-conditions:

* the diary sink received **exactly one** failure entry carrying the captured
  command / exit code / log (R5.4);
* the FSM returned to ``PLAN_EDITS`` and the outcome reports a remediation
  (R5.5).

Commands are constrained to contain a non-whitespace character so the planner's
reference to the command is a genuine, detectable reference; everything else
(exit code sign, log content, prior plan shape) ranges freely so the property
covers the full input space well beyond the 100-example floor.
"""

from __future__ import annotations

import itertools

from hypothesis import given, settings
from hypothesis import strategies as st

from zocai_gateway.edits import EditPlan, PlannedChange
from zocai_gateway.fsm import FSM
from zocai_gateway.memory.state_wrapper import FailureRecord
from zocai_gateway.remediation import RemediationLoop
from zocai_gateway.stages import Stage

# A path the prior plan never uses, so the remediation's sentinel change is
# always an *added* operation and the plan therefore differs (R5.6).
_SENTINEL_PATH = "__remediation_sentinel__.py"

# Non-zero exit codes spanning positive (error) and negative (signal) domains.
_nonzero_exit_codes = st.integers().filter(lambda code: code != 0)

# Failed commands with at least one non-whitespace character, so the planner's
# reference to the command is detectable by plan_references_failure (R5.6).
_commands = st.text(min_size=1, max_size=80).filter(lambda s: s.strip() != "")

# Arbitrary compiler-log output, including the empty log.
_logs = st.text(max_size=200)


def _planned_changes() -> st.SearchStrategy[PlannedChange]:
    """Prior-plan changes on paths distinct from the remediation sentinel."""
    return st.builds(
        PlannedChange,
        path=st.text(max_size=20).filter(lambda p: p != _SENTINEL_PATH),
        content=st.text(max_size=20),
        diff=st.text(max_size=20),
    )


_prior_plans = st.builds(
    EditPlan,
    reasoning=st.text(max_size=40),
    changes=st.lists(_planned_changes(), max_size=4).map(tuple),
)


def _make_loop() -> tuple[RemediationLoop, list[dict[str, object]]]:
    """A loop at RUN_CHECKS wired to a recording diary sink and a planner that
    always produces a differing, failure-referencing remediation."""
    fsm = FSM(initial=Stage.RUN_CHECKS, run_id="r1")
    diary: list[dict[str, object]] = []

    def planner(prior: EditPlan, failure: FailureRecord) -> EditPlan:
        # References the failed command (R5.6 "references the failure") and adds
        # a sentinel change the prior plan never holds (R5.6 "differs by ≥1 op").
        return EditPlan(
            reasoning=f"remediation for failing command {failure.command}",
            changes=(
                *prior.changes,
                PlannedChange(path=_SENTINEL_PATH, content="# fix applied"),
            ),
        )

    loop = RemediationLoop(
        fsm=fsm,
        planner=planner,
        diary=diary.append,
        run_id="r1",
        next_seq=itertools.count().__next__,
    )
    return loop, diary


@settings(max_examples=200)
@given(
    exit_code=_nonzero_exit_codes,
    command=_commands,
    log=_logs,
    prior_plan=_prior_plans,
)
def test_handle_error_records_to_diary_and_returns_to_plan_edits(
    exit_code: int,
    command: str,
    log: str,
    prior_plan: EditPlan,
) -> None:
    """Property 24: a remediating HANDLE_ERROR appends exactly one failure entry
    to the Session_Diary (R5.4) and returns the FSM to PLAN_EDITS (R5.5).

    Feature: zocai-ecosystem-rebuild, Property 24

    **Validates: Requirements 5.4, 5.5**
    """
    loop, diary = _make_loop()

    outcome = loop.on_checks_complete(
        exit_code, command=command, log=log, prior_plan=prior_plan
    )

    # R5.4: exactly one failure entry was appended to the Session_Diary, and it
    # carries the captured command, exit code, and log.
    assert len(diary) == 1
    entry = diary[0]
    assert entry["type"] == "command"
    assert entry["command"] == command
    assert entry["exitCode"] == exit_code
    assert entry["log"] == outcome.failure.log  # FailureRecord-truncated log
    assert entry["runId"] == "r1"

    # R5.5: the remediation was accepted and the FSM returned to PLAN_EDITS.
    assert outcome.remediated is True
    assert outcome.deferred is False
    assert outcome.stage is Stage.PLAN_EDITS
    assert loop.fsm.current is Stage.PLAN_EDITS
    # Exactly one HANDLE_ERROR entry was counted on the way through (R5.1/5.2).
    assert loop.recoveries == 1
