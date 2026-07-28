"""Stage projection: the six user-facing stages the chat surface reports (R7).

The Gateway FSM (``fsm.py``) has nine stages plus ``HANDLE_ERROR``, ``PAUSED``,
and ``ERROR_CLOSED``. Requirement 7.1 names six user-facing stages. Rather than
renaming the FSM — which would touch the legal transition table, the diary
format, and evolution trajectories — this module maps the FSM stages onto the
six reported stages (:func:`report_stage_for`) and folds a stream of emitted
:class:`~shared_schema.agent_events.StageEvent` frames into a well-formed,
monotone report (:func:`project_stages`).

The fold is pure, so Property 15 is checkable without driving a real run.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from enum import Enum

from shared_schema.agent_events import StageEvent

from zocai_gateway.stages import Stage

__all__ = [
    "REPORTED_STAGE_ORDER",
    "ReportedStage",
    "StageReport",
    "StageState",
    "project_stages",
    "report_stage_for",
]


class ReportedStage(str, Enum):
    """The six user-facing stages (R7.1). Values mirror the wire ``ReportedStage``
    literal in ``shared_schema.agent_events`` field-for-field."""

    ANALYZE = "analyze"
    PLAN = "plan"
    EDIT = "edit"
    CHECK = "check"
    REVIEW = "review"
    SUMMARY = "summary"


class StageState(str, Enum):
    """The state of one reported stage (R7.1). Values mirror the wire literal."""

    PENDING = "pending"
    ACTIVE = "active"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    SKIPPED = "skipped"


#: Canonical left-to-right order of the reported stages (R7.1).
REPORTED_STAGE_ORDER: tuple[ReportedStage, ...] = (
    ReportedStage.ANALYZE,
    ReportedStage.PLAN,
    ReportedStage.EDIT,
    ReportedStage.CHECK,
    ReportedStage.REVIEW,
    ReportedStage.SUMMARY,
)


@dataclass(frozen=True, slots=True)
class StageReport:
    """One reported stage and its state (R7.1-R7.3)."""

    stage: ReportedStage
    state: StageState
    #: Human-readable failure reason; non-empty exactly when ``state`` is FAILED (R7.3).
    reason: str | None = None


#: The design's mapping table (D4): the nine FSM stages folded onto the six
#: reported stages. ``PAUSED`` and ``ERROR_CLOSED`` map to nothing — a fail marks
#: the reported stage that *was* active as FAILED, not a stage of its own; and
#: ``REVIEW`` has no FSM stage (it is the plan-mode approval gate / review event),
#: so it is reported via a REVIEW ``StageEvent`` emitted at the gate.
_FSM_TO_REPORTED: dict[Stage, ReportedStage] = {
    Stage.INTAKE: ReportedStage.ANALYZE,
    Stage.ANALYZE: ReportedStage.ANALYZE,
    Stage.MAP_FILES: ReportedStage.PLAN,
    Stage.READ_FILES: ReportedStage.PLAN,
    Stage.PLAN_EDITS: ReportedStage.PLAN,
    Stage.APPLY_EDITS: ReportedStage.EDIT,
    Stage.RUN_CHECKS: ReportedStage.CHECK,
    Stage.HANDLE_ERROR: ReportedStage.CHECK,
    Stage.SUMMARY: ReportedStage.SUMMARY,
    Stage.DONE: ReportedStage.SUMMARY,
}


def report_stage_for(fsm_stage: Stage) -> ReportedStage | None:
    """Map an FSM stage onto its reported stage, or ``None`` (R7.1, D4).

    ``PAUSED`` and ``ERROR_CLOSED`` return ``None``: they are not reported
    stages; a fail marks whichever reported stage was active as FAILED.
    """
    return _FSM_TO_REPORTED.get(fsm_stage)


def project_stages(history: Sequence[StageEvent]) -> tuple[StageReport, ...]:
    """Fold emitted stage frames into the six reported stages (R7.1-R7.4).

    Invariants the fold maintains, for every history:

    * all six stages present, each with exactly one state          (R7.1)
    * at most one ACTIVE                                            (R7.2)
    * a stage that reached SUCCEEDED never leaves it (and FAILED
      is likewise absorbing)                                        (R7.4)
    * FAILED carries a reason copied from the frame                 (R7.3)

    A stage going ACTIVE demotes the previously-active stage to SUCCEEDED and
    marks any earlier still-pending stage SKIPPED (the empty-plan / review skip),
    so the report reads as a monotone left-to-right progression.
    """
    order = REPORTED_STAGE_ORDER
    index = {stage: i for i, stage in enumerate(order)}
    states: dict[ReportedStage, StageState] = {stage: StageState.PENDING for stage in order}
    reasons: dict[ReportedStage, str | None] = {stage: None for stage in order}

    _terminal = (StageState.SUCCEEDED, StageState.FAILED)

    for event in history:
        reported = ReportedStage(event.stage)
        state = StageState(event.state)
        if state is StageState.FAILED:
            # R7.4: a stage that already succeeded stays succeeded — a later
            # failure (e.g. during a remediation re-pass) does not un-succeed an
            # earlier verified stage. The run's failure still travels on the
            # terminal error frame.
            if states[reported] is not StageState.SUCCEEDED:
                states[reported] = StageState.FAILED
                reasons[reported] = (
                    event.reason or "The run stopped before this stage completed."
                )
        elif state is StageState.SUCCEEDED:
            if states[reported] is not StageState.FAILED:
                states[reported] = StageState.SUCCEEDED
        elif state is StageState.ACTIVE:
            # Enforce "at most one active": any *other* active stage succeeded.
            for other, other_state in states.items():
                if other is not reported and other_state is StageState.ACTIVE:
                    states[other] = StageState.SUCCEEDED
            # Earlier still-pending stages were bypassed (empty-plan / review skip).
            for earlier in order[: index[reported]]:
                if states[earlier] is StageState.PENDING:
                    states[earlier] = StageState.SKIPPED
            if states[reported] not in _terminal:
                states[reported] = StageState.ACTIVE
        elif state is StageState.SKIPPED and states[reported] is StageState.PENDING:
            states[reported] = StageState.SKIPPED
        # PENDING frames never regress a stage; ignored.

    return tuple(
        StageReport(stage=stage, state=states[stage], reason=reasons[stage]) for stage in order
    )
