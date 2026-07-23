"""PLAN_EDITS / APPLY_EDITS behavior for the Agent-Mode FSM (task 5.3).

This module owns the two edit stages of the 9-stage FSM (design "The 9-Stage
FSM and Orchestrator", R3.6-R3.9). It builds on :mod:`zocai_gateway.fsm`
(the legal transition table and the ``PLAN_EDITS``/``APPLY_EDITS`` branch
methods) and on the :class:`~zocai_gateway.toolsets.FullToolset` used to apply
edits within the confined workspace (R3.5).

The contract this task implements:

- **PLAN_EDITS (R3.6).** When the plan is produced, the Gateway emits a
  ``thinking`` event conforming to the Event_Contract that carries the edit
  reasoning with the collapsible display flag set. :meth:`EditCoordinator.plan_edits`
  emits exactly that event.
- **APPLY_EDITS (R3.7).** Applying a plan applies **only** the changes the
  plan describes and **nothing else**: each :class:`PlannedChange` is written
  to its workspace path through the :class:`FullToolset`, and one ``edit-file``
  event is emitted per successfully applied change. No write is performed for
  a path not present in the plan.
- **Empty plan (R3.8).** An empty plan applies nothing. The
  ``PLAN_EDITS -> RUN_CHECKS`` skip itself is owned by
  :meth:`zocai_gateway.fsm.FSM.plan_complete`; :meth:`EditCoordinator.apply_edits`
  simply performs no writes and emits no ``edit-file`` events for an empty plan.
- **Apply failure (R3.9).** If applying a change fails, the stage halts
  immediately: changes already applied are retained (their ``edit-file`` events
  stay on the stream and the applied list is preserved), an error event naming
  the failed change is emitted over the bus, and no further changes are
  attempted. The failure surfaces as an :class:`ApplyOutcome` whose
  :attr:`~ApplyOutcome.failed` change is set, so the Orchestrator (tasks
  5.4/5.5) can drive the FSM to the paused/error path.

Event sequencing is decoupled through an injected monotonic ``next_seq``
source and an :class:`~zocai_gateway.fsm.EmitSink`, mirroring the FSM's own
emission seam, so the Orchestrator can later share a single ordered sequence
across stage events, the thinking event, and the edit-file events.
"""

from __future__ import annotations

import itertools
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime

from shared_schema.agent_events import (
    ApprovalEvent,
    CommandEvent,
    EditFileEvent,
    ThinkingEvent,
)

from zocai_gateway.context.steering_compiler import is_write_preapproved
from zocai_gateway.fsm import EmitSink
from zocai_gateway.toolsets import FullToolset, ReadOnlyViolation

__all__ = [
    "ApplyOutcome",
    "ApprovalWaiter",
    "EditCoordinator",
    "EditPlan",
    "PlannedChange",
]


ApprovalWaiter = Callable[[float | None], object | None]


# ── Edit plan data model ─────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class PlannedChange:
    """A single planned edit produced by PLAN_EDITS.

    Applying the change writes :attr:`content` to :attr:`path` (relative to the
    workspace root, R3.5). :attr:`diff` carries the unified-diff text surfaced
    on the ``edit-file`` event for telemetry and mirrors the
    :class:`~zocai_gateway.memory.state_wrapper.Diff` payload so an applied
    change survives a hot-swap unchanged.
    """

    path: str
    content: str
    diff: str = ""


@dataclass(frozen=True, slots=True)
class EditPlan:
    """The output of PLAN_EDITS: reasoning plus the ordered changes to apply.

    :attr:`reasoning` is the edit rationale carried on the collapsible
    ``thinking`` event (R3.6). :attr:`changes` is applied **in order** and is
    the exact, exhaustive set of changes APPLY_EDITS may perform (R3.7); an
    empty :attr:`changes` is the empty plan that applies nothing (R3.8).
    """

    reasoning: str = ""
    changes: tuple[PlannedChange, ...] = ()

    @property
    def has_changes(self) -> bool:
        """Whether the plan contains at least one change (drives R3.8)."""
        return bool(self.changes)


@dataclass(frozen=True, slots=True)
class ApplyOutcome:
    """Result of APPLY_EDITS with halt-and-retain approval semantics."""

    applied: tuple[PlannedChange, ...]
    failed: PlannedChange | None = None
    pending_approval: PlannedChange | None = None
    rejected: bool = False
    error: str | None = None

    @property
    def needs_approval(self) -> bool:
        return self.pending_approval is not None and not self.rejected

    @property
    def paused(self) -> bool:
        return self.pending_approval is not None

    @property
    def ok(self) -> bool:
        """Whether every planned change was applied without failure or pause."""
        return self.failed is None and self.pending_approval is None


# ── The coordinator ──────────────────────────────────────────────────────────


@dataclass(slots=True)
class EditCoordinator:
    """Drives PLAN_EDITS / APPLY_EDITS emission and application (R3.6-R3.9).

    The coordinator is the seam between the FSM stage transitions and the
    workspace mutations. It applies edits through a :class:`FullToolset`
    confined to the workspace (R3.5) and emits contract-conforming events
    through the injected :attr:`emit` sink, drawing each event's ``seq`` from
    the injected :attr:`next_seq` source so a single ordered stream can be
    shared with the FSM stage events.

    Args:
        toolset: The Agent-Mode :class:`FullToolset` used to write edits.
        run_id: The run identifier stamped on emitted events.
        emit: Optional sink receiving each emitted event in production order.
            When ``None`` events are still recorded in :attr:`events`.
        next_seq: A monotonic sequence source. Defaults to an internal counter
            starting at zero; the Orchestrator injects a shared counter so the
            edit events interleave correctly with FSM stage events (R6.5).
    """

    toolset: FullToolset
    run_id: str = "run"
    emit: EmitSink | None = None
    next_seq: Callable[[], int] = field(
        default_factory=lambda: itertools.count().__next__
    )
    write_allowlist: frozenset[str] | None = None
    wait_for_approval: ApprovalWaiter | None = None
    events: list[ThinkingEvent | EditFileEvent | CommandEvent | ApprovalEvent] = field(
        init=False, default_factory=list
    )
    _approved_paths: set[str] = field(init=False, default_factory=set)
    _last_approval_rejected: bool = field(init=False, default=False)

    # -- PLAN_EDITS (R3.6) --------------------------------------------------

    def plan_edits(self, plan: EditPlan) -> ThinkingEvent:
        """Emit the collapsible ``thinking`` event carrying edit reasoning (R3.6).

        The event's ``collapsible`` flag is fixed ``True`` by the contract and
        its ``text`` carries :attr:`EditPlan.reasoning`, so the produced edit
        plan is surfaced as a collapsible thinking row before any change is
        applied. Returns the emitted event for the caller's convenience.
        """
        event = ThinkingEvent(
            seq=self.next_seq(),
            run_id=self.run_id,
            ts=self._now(),
            text=plan.reasoning,
            collapsible=True,
            truncated=False,
        )
        self._record(event)
        return event

    # -- APPLY_EDITS (R3.7, R3.8, R3.9) -------------------------------------

    def apply_edits(self, plan: EditPlan) -> ApplyOutcome:
        """Apply exactly the planned changes, halting and reporting on failure.

        Walks :attr:`EditPlan.changes` in order, writing each change to its
        workspace path through the :class:`FullToolset` and emitting one
        ``edit-file`` event per applied change. Only the planned changes are
        written — nothing outside the plan is touched (R3.7) — and an empty
        plan performs no writes at all (R3.8).

        If a write raises (an out-of-workspace :class:`ReadOnlyViolation`, or
        an :class:`OSError` from the filesystem), the stage halts on that
        change: the changes already applied are retained (their ``edit-file``
        events remain on the stream), an error event naming the failed change
        is emitted (R3.9), and no later change is attempted. The failure is
        returned in the :class:`ApplyOutcome` rather than raised so the
        Orchestrator can drive the FSM's paused/error path.
        """
        applied: list[PlannedChange] = []
        for change in plan.changes:
            if not self.authorize_write(change.path):
                rejected = self._last_approval_rejected
                reason = (
                    f"write rejected for undeclared path {change.path!r}"
                    if rejected
                    else f"write approval pending for undeclared path {change.path!r}"
                )
                return ApplyOutcome(
                    applied=tuple(applied),
                    pending_approval=change,
                    rejected=rejected,
                    error=reason,
                )
            try:
                self.toolset.write_file(change.path, change.content)
            except (ReadOnlyViolation, OSError, UnicodeDecodeError) as exc:
                # R3.9: halt, retain already-applied changes, emit an error
                # event naming the failed change, and attempt nothing further.
                reason = f"failed to apply change to {change.path!r}: {exc}"
                self._emit_apply_error(change, reason)
                return ApplyOutcome(
                    applied=tuple(applied), failed=change, error=reason
                )
            applied.append(change)
            self._emit_edit_file(change)
        return ApplyOutcome(applied=tuple(applied))

    def authorize_write(self, path: str) -> bool:
        """Return whether ``path`` may be mutated, waiting once when undeclared."""
        self._last_approval_rejected = False
        allowlist = self.write_allowlist
        workspace_root = self.toolset.workspace_root
        if allowlist is None:
            return True
        if is_write_preapproved(path, allowlist, workspace_root=workspace_root):
            return True
        if is_write_preapproved(
            path, frozenset(self._approved_paths), workspace_root=workspace_root
        ):
            return True

        event = ApprovalEvent(
            seq=self.next_seq(),
            run_id=self.run_id,
            ts=self._now(),
            prompt=f"Approve writing undeclared path: {path}",
            decision=None,
        )
        self._record(event)
        waiter = self.wait_for_approval
        if waiter is None:
            return False
        decision = waiter(None)
        verdict = (
            decision
            if isinstance(decision, str)
            else getattr(decision, "decision", None)
        )
        if verdict == "approve":
            normalized = (workspace_root / path).resolve()
            try:
                approved = normalized.relative_to(workspace_root).as_posix()
            except ValueError:
                return False
            self._approved_paths.add(approved)
            return True
        self._last_approval_rejected = verdict == "reject"
        return False

    def apply_all(self, plans: Iterable[EditPlan]) -> ApplyOutcome:
        """Apply a sequence of plans, stopping at the first failed change.

        A convenience for remediation passes (task 5.5) where more than one
        plan may be applied; preserves the same halt-and-retain semantics of
        :meth:`apply_edits` across the combined change set.
        """
        applied: list[PlannedChange] = []
        for plan in plans:
            outcome = self.apply_edits(plan)
            applied.extend(outcome.applied)
            if not outcome.ok:
                return ApplyOutcome(
                    applied=tuple(applied),
                    failed=outcome.failed,
                    pending_approval=outcome.pending_approval,
                    rejected=outcome.rejected,
                    error=outcome.error,
                )
        return ApplyOutcome(applied=tuple(applied))

    # -- emission helpers ---------------------------------------------------

    def _emit_edit_file(self, change: PlannedChange) -> None:
        """Emit an ``edit-file`` event documenting an applied change (R3.7)."""
        event = EditFileEvent(
            seq=self.next_seq(),
            run_id=self.run_id,
            ts=self._now(),
            path=change.path,
            diff=change.diff,
            adds=_diff_stats(change.diff)[0],
            dels=_diff_stats(change.diff)[1],
            status="done",
        )
        self._record(event)

    def _emit_apply_error(self, change: PlannedChange, reason: str) -> None:
        """Emit the terminal-for-the-stage error event naming the failed change (R3.9)."""
        event = CommandEvent(
            seq=self.next_seq(),
            run_id=self.run_id,
            ts=self._now(),
            command=f"apply-edit:{change.path}",
            command_id=f"apply-edit:{change.path}",
            status="fail",
            exit_code=1,
            error_tag=reason,
            output_tail=reason,
        )
        self._record(event)

    def _record(
        self, event: ThinkingEvent | EditFileEvent | CommandEvent | ApprovalEvent
    ) -> None:
        """Record ``event`` and forward it to the sink in production order."""
        self.events.append(event)
        if self.emit is not None:
            self.emit(event)

    @staticmethod
    def _now() -> str:
        """An ISO-8601 UTC timestamp for the ``ts`` field."""
        return datetime.now(UTC).isoformat()



def _diff_stats(diff: str) -> tuple[int, int]:
    adds = 0
    dels = 0
    for line in diff.splitlines():
        if line.startswith("+++") or line.startswith("---"):
            continue
        if line.startswith("+"):
            adds += 1
        elif line.startswith("-"):
            dels += 1
    return adds, dels
