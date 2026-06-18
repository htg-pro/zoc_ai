"""The Error Remediation Loop for the Agent-Mode FSM (task 5.5, R5).

This module owns the ``RUN_CHECKS`` outcome handling and the ``HANDLE_ERROR``
remediation pass (design.md "Error Remediation Loop (R5)"). It builds on
:mod:`zocai_gateway.fsm` (the ``RUN_CHECKS`` exit-code branch
:meth:`~zocai_gateway.fsm.FSM.run_checks_result`, the remediation return
:meth:`~zocai_gateway.fsm.FSM.remediate`, and the defer seam
:meth:`~zocai_gateway.fsm.FSM.pause`), on :mod:`zocai_gateway.edits` (the
:class:`~zocai_gateway.edits.EditPlan` produced by ``PLAN_EDITS``), and on
:class:`~zocai_gateway.memory.state_wrapper.FailureRecord` /
:data:`~zocai_gateway.memory.state_wrapper.LOG_MAX_CHARS` for the captured
failure (its log is truncated to 65,536 characters *at construction*).

The contract this task implements, driven entirely through
:meth:`RemediationLoop.on_checks_complete`:

- **Zero exit (R5.8).** A zero ``RUN_CHECKS`` exit code transitions
  ``RUN_CHECKS -> SUMMARY``; nothing is captured and no recovery is counted.
- **Non-zero exit (R5.1).** A non-zero exit code transitions
  ``RUN_CHECKS -> HANDLE_ERROR``.
- **Count the recovery (R5.2).** Entering ``HANDLE_ERROR`` increments the
  cumulative error-recovery count. The count is exposed on
  :attr:`RemediationLoop.recoveries` and an optional :attr:`on_recovery` hook is
  invoked so the Orchestrator's shared :class:`Budget` (task 5.4) counts the
  same entry rather than double-counting it.
- **Capture the failure (R5.3).** The failed command, its exit code, and the
  compiler log are captured into a :class:`FailureRecord`; the log is truncated
  to :data:`LOG_MAX_CHARS` (65,536) by the record itself.
- **Persist to the diary (R5.4).** The captured failure is appended to the
  Session_Diary through the injected :attr:`diary` sink (wired by the
  Orchestrator to :meth:`~zocai_gateway.memory.diary_worker.DiaryWorker.append`).
- **Differing remediation, or defer (R5.5/5.6/5.7).** The injected
  :attr:`planner` proposes a remediation :class:`EditPlan`. The loop accepts it
  **only if** it differs from the immediately preceding plan by at least one
  added / removed / modified edit operation *and* references the captured
  failure (R5.6); on acceptance the FSM transitions ``HANDLE_ERROR ->
  PLAN_EDITS`` (R5.5). If the planner cannot produce such a plan — it returns
  ``None``, or its proposal does not differ, or it does not reference the
  failure — the loop pauses the run and emits an ``approval`` event deferring
  control to the developer (R5.7).

Event emission mirrors the :class:`~zocai_gateway.edits.EditCoordinator` seam:
the loop draws each event's ``seq`` from an injected monotonic ``next_seq`` and
forwards it to an injected :class:`~zocai_gateway.fsm.EmitSink`, so the defer
event interleaves correctly with the FSM stage events on the single ordered
stream (R6.5).
"""

from __future__ import annotations

import itertools
from collections import Counter
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Protocol

from shared_schema.agent_events import ApprovalEvent

from zocai_gateway.edits import EditPlan, PlannedChange
from zocai_gateway.fsm import FSM, EmitSink
from zocai_gateway.memory.state_wrapper import FailureRecord
from zocai_gateway.stages import Stage

__all__ = [
    "PlanDelta",
    "diff_plans",
    "plan_references_failure",
    "RemediationPlanner",
    "DiarySink",
    "RemediationOutcome",
    "RemediationLoop",
]


# ── Plan diffing (R5.6 "differs by at least one edit operation") ─────────────


@dataclass(frozen=True, slots=True)
class PlanDelta:
    """The structural difference between a prior and a proposed edit plan.

    Changes are compared as a multiset of :class:`PlannedChange` values: a
    proposed change absent from the prior plan is *added*, a prior change
    absent from the proposal is *removed*, and a path present in both whose
    content/diff changed is *modified* (paired prior → proposed). This is the
    "added / removed / modified edit operation" notion R5.6 requires.
    """

    added: tuple[PlannedChange, ...] = ()
    removed: tuple[PlannedChange, ...] = ()
    modified: tuple[tuple[PlannedChange, PlannedChange], ...] = ()

    @property
    def differs(self) -> bool:
        """Whether the proposal differs from the prior plan by ≥1 operation (R5.6)."""
        return bool(self.added or self.removed or self.modified)

    @property
    def operation_count(self) -> int:
        """Total number of added, removed, and modified edit operations."""
        return len(self.added) + len(self.removed) + len(self.modified)


def diff_plans(prior: EditPlan, proposed: EditPlan) -> PlanDelta:
    """Compute the :class:`PlanDelta` between ``prior`` and ``proposed`` (R5.6).

    Identical changes (same path, content, and diff) present in both plans
    cancel out. Of the remainder, a path that appears on both the added and
    removed sides is reported once as a *modified* operation pairing the prior
    change with the proposed one; everything else is a pure add or remove.
    """
    prior_counts = Counter(prior.changes)
    proposed_counts = Counter(proposed.changes)

    # Multiset difference: what proposed adds vs. what it drops, ignoring the
    # changes the two plans share verbatim.
    added_counts = proposed_counts - prior_counts
    removed_counts = prior_counts - proposed_counts

    added_list = list(_expand(added_counts))
    removed_list = list(_expand(removed_counts))

    # Re-pair adds and removes that target the same path into modifications, so
    # "I changed the edit to file X" counts as one modified op rather than an
    # unrelated add plus remove.
    modified: list[tuple[PlannedChange, PlannedChange]] = []
    remaining_added: list[PlannedChange] = []
    removed_by_path: dict[str, list[PlannedChange]] = {}
    for change in removed_list:
        removed_by_path.setdefault(change.path, []).append(change)
    for change in added_list:
        bucket = removed_by_path.get(change.path)
        if bucket:
            modified.append((bucket.pop(0), change))
        else:
            remaining_added.append(change)
    remaining_removed = [c for bucket in removed_by_path.values() for c in bucket]

    return PlanDelta(
        added=tuple(remaining_added),
        removed=tuple(remaining_removed),
        modified=tuple(modified),
    )


def _expand(counts: Counter[PlannedChange]) -> list[PlannedChange]:
    """Flatten a multiset of changes back into a list preserving multiplicity."""
    expanded: list[PlannedChange] = []
    for change, count in counts.items():
        expanded.extend([change] * count)
    return expanded


def plan_references_failure(plan: EditPlan, failure: FailureRecord) -> bool:
    """Whether ``plan`` references the captured ``failure`` details (R5.6).

    A remediation plan references the failure when the failed command, or any
    non-empty line of the captured compiler log, appears verbatim in the plan's
    reasoning or in any change's path, content, or diff. This is the
    "references the captured failure details" gate R5.6 requires: a plan that
    is structurally different but ignores the failure is not a valid
    remediation and is deferred under R5.7.
    """
    haystack_parts = [plan.reasoning]
    for change in plan.changes:
        haystack_parts.extend((change.path, change.content, change.diff))
    haystack = "\n".join(haystack_parts)
    if not haystack:
        return False

    command = failure.command.strip()
    if command and command in haystack:
        return True
    return any(
        stripped and stripped in haystack
        for stripped in (line.strip() for line in failure.log.splitlines())
    )


# ── Seams ────────────────────────────────────────────────────────────────────


class RemediationPlanner(Protocol):
    """Produces a remediation edit plan from the prior plan and the failure (R5.6).

    Returns the proposed :class:`EditPlan`, or ``None`` when no remediation can
    be proposed. The :class:`RemediationLoop` still validates the proposal
    against R5.6 (it must differ from ``prior`` and reference ``failure``), so a
    planner that returns a non-differing or failure-ignoring plan results in a
    developer defer (R5.7) exactly as a ``None`` return does.
    """

    def __call__(self, prior: EditPlan, failure: FailureRecord) -> EditPlan | None: ...


def _defer_always(prior: EditPlan, failure: FailureRecord) -> EditPlan | None:
    """Default planner: proposes nothing, so the loop always defers (R5.7)."""
    return None


#: A Session_Diary append sink. Matches
#: :meth:`~zocai_gateway.memory.diary_worker.DiaryWorker.append` so the
#: Orchestrator can wire the diary directly; the returned value (a seq) is
#: ignored by the loop.
DiarySink = Callable[[Mapping[str, object]], object]


# ── Outcome ────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class RemediationOutcome:
    """The result of handling a ``RUN_CHECKS`` outcome.

    :attr:`stage` is the stage the FSM occupies afterwards: ``SUMMARY`` on a
    zero exit (R5.8), ``PLAN_EDITS`` after an accepted remediation (R5.5), or
    ``PAUSED`` after a developer defer (R5.7). :attr:`failure` is the captured
    failure (``None`` only on the zero-exit path). :attr:`plan` and
    :attr:`delta` are the accepted remediation plan and its difference from the
    prior plan (set only when :attr:`remediated`). :attr:`deferred` is ``True``
    when control was handed back to the developer, and :attr:`defer_event` is
    the emitted ``approval`` event in that case.
    """

    stage: Stage
    failure: FailureRecord | None = None
    plan: EditPlan | None = None
    delta: PlanDelta | None = None
    deferred: bool = False
    defer_event: ApprovalEvent | None = None

    @property
    def remediated(self) -> bool:
        """Whether a differing remediation plan was accepted and applied (R5.5)."""
        return self.plan is not None and not self.deferred


# ── The loop ──────────────────────────────────────────────────────────────


@dataclass(slots=True)
class RemediationLoop:
    """Drives ``RUN_CHECKS`` outcomes and the ``HANDLE_ERROR`` pass (R5.1-R5.8).

    Args:
        fsm: The FSM whose ``RUN_CHECKS`` branch, ``remediate`` return, and
            ``pause`` defer the loop drives. Must be at ``RUN_CHECKS`` when
            :meth:`on_checks_complete` is called.
        planner: Proposes a remediation plan (R5.6). Defaults to a planner that
            always defers, so a loop without one is safe but never remediates.
        diary: Optional Session_Diary append sink (R5.4). When ``None`` the
            captured failure is still recorded in :attr:`recorded_failures`.
        on_recovery: Optional hook invoked once per ``HANDLE_ERROR`` entry so a
            shared budget counts the recovery (R5.2) without double counting.
        run_id: The run identifier stamped on emitted events.
        emit: Optional sink receiving each emitted event in production order.
        next_seq: Monotonic sequence source for emitted events; the Orchestrator
            injects a shared counter so events interleave with FSM stage events.
    """

    fsm: FSM
    planner: RemediationPlanner = _defer_always
    diary: DiarySink | None = None
    on_recovery: Callable[[], None] | None = None
    run_id: str = "run"
    emit: EmitSink | None = None
    next_seq: Callable[[], int] = field(
        default_factory=lambda: itertools.count().__next__
    )
    recoveries: int = field(init=False, default=0)
    recorded_failures: list[FailureRecord] = field(init=False, default_factory=list)
    events: list[ApprovalEvent] = field(init=False, default_factory=list)

    # -- entrypoint --------------------------------------------------------

    def on_checks_complete(
        self,
        exit_code: int,
        *,
        command: str = "",
        log: str = "",
        prior_plan: EditPlan | None = None,
    ) -> RemediationOutcome:
        """Resolve a ``RUN_CHECKS`` outcome (R5.1-R5.8).

        On a zero ``exit_code`` the FSM advances to ``SUMMARY`` (R5.8). On a
        non-zero ``exit_code`` the FSM enters ``HANDLE_ERROR`` (R5.1) and the
        remediation pass runs: the recovery is counted (R5.2), the
        ``command``/``exit_code``/``log`` are captured (R5.3, log truncated to
        65,536 chars), the failure is appended to the diary (R5.4), and the
        :attr:`planner` is asked for a remediation against ``prior_plan``. An
        accepted differing plan returns the FSM to ``PLAN_EDITS`` (R5.5/5.6);
        otherwise the run pauses and defers to the developer (R5.7).
        """
        if exit_code == 0:
            stage = self.fsm.run_checks_result(0)  # RUN_CHECKS -> SUMMARY (R5.8)
            return RemediationOutcome(stage=stage)

        # R5.1: a non-zero check transitions RUN_CHECKS -> HANDLE_ERROR.
        self.fsm.run_checks_result(exit_code)

        # R5.2: count this entry into the error remediation loop.
        self.recoveries += 1
        if self.on_recovery is not None:
            self.on_recovery()

        # R5.3: capture the failure; FailureRecord truncates the log itself.
        failure = FailureRecord(command=command, exit_code=exit_code, log=log)
        self.recorded_failures.append(failure)

        # R5.4: append the failure details to the Session_Diary.
        if self.diary is not None:
            self.diary(self._failure_entry(failure))

        # R5.6: ask for a remediation plan and accept it only if it differs
        # from the prior plan and references the captured failure.
        prior = prior_plan if prior_plan is not None else EditPlan()
        candidate = self.planner(prior, failure)
        if candidate is not None:
            delta = diff_plans(prior, candidate)
            if delta.differs and plan_references_failure(candidate, failure):
                stage = self.fsm.remediate()  # HANDLE_ERROR -> PLAN_EDITS (R5.5)
                return RemediationOutcome(
                    stage=stage, failure=failure, plan=candidate, delta=delta
                )

        # R5.7: no differing remediation -> pause and defer to the developer.
        stage = self.fsm.pause("remediation deferred to developer")
        event = self._emit_defer_event(failure)
        return RemediationOutcome(
            stage=stage, failure=failure, deferred=True, defer_event=event
        )

    # -- helpers -----------------------------------------------------------

    def _failure_entry(self, failure: FailureRecord) -> dict[str, object]:
        """Build the Session_Diary entry recording the captured failure (R5.4)."""
        return {
            "type": "command",
            "runId": self.run_id,
            "ts": _now(),
            "command": failure.command,
            "exitCode": failure.exit_code,
            "log": failure.log,
        }

    def _emit_defer_event(self, failure: FailureRecord) -> ApprovalEvent:
        """Emit the ``approval`` event that defers control to the developer (R5.7)."""
        event = ApprovalEvent(
            seq=self.next_seq(),
            run_id=self.run_id,
            ts=_now(),
            prompt=(
                "Remediation could not produce a differing edit plan for failed "
                f"command {failure.command!r} (exit {failure.exit_code}); "
                "developer input required."
            ),
        )
        self.events.append(event)
        if self.emit is not None:
            self.emit(event)
        return event


def _now() -> str:
    """An ISO-8601 UTC timestamp for the ``ts`` field."""
    return datetime.now(timezone.utc).isoformat()
