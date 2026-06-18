"""The Orchestrator execution budget (task 5.4, Requirement 4).

The Orchestrator owns the run-scoped state of an Agent-Mode run — the FSM
stage, the cumulative file-iteration and error-recovery counters, the active
file markers, and the patch-diff arrays — and enforces the hard
:class:`Execution_Budget` over it (design.md "Execution Budget Enforcement
(R4)"). It composes the two modules that own the stage machinery:

* :mod:`zocai_gateway.fsm` — the 9-stage FSM whose ``current`` stage is the
  stage the budget retains and resumes from (R4.5, R4.6);
* :mod:`zocai_gateway.edits` — the PLAN_EDITS / APPLY_EDITS coordinator whose
  :class:`~zocai_gateway.toolsets.FullToolset` performs the workspace file
  reads and writes that the budget counts (R4.1).

The contract this task implements:

* **Counters start at zero (R4.1, R4.2).** A fresh :class:`Budget` has both
  ``file_iterations`` and ``error_recoveries`` at zero.
* **File iterations (R4.1).** Every gated file read or write performed through
  the Orchestrator increments ``file_iterations`` by exactly one.
* **Error recoveries (R4.2, R5.2).** Every entry into the error-remediation
  loop (``HANDLE_ERROR``) increments ``error_recoveries`` by exactly one.
* **Pause at the ceiling, before the next op (R4.3, R4.4).** When
  ``file_iterations`` has reached ``FILE_CEILING`` (20) the next file
  iteration is blocked *before* it starts; likewise the next error recovery is
  blocked when ``error_recoveries`` has reached ``ERROR_CEILING`` (3). The run
  pauses and a budget-exceeded event requiring developer confirmation is
  emitted over the bus.
* **Retain run state while paused (R4.5).** Pausing snapshots the FSM stage,
  the active file markers, the patch diffs, and both counters into a
  :class:`RetainedState`.
* **Resume from the retained stage on confirmation (R4.6).**
  :meth:`Orchestrator.confirm_continue` restores the retained run state, grants
  a fresh budget window so the confirmed run can actually make progress, and
  returns the retained stage to resume from.

Granting a fresh window on confirmation (rather than resetting the counters)
keeps the cumulative counters faithful to the number of operations actually
performed — the R4.1/R4.2 + R5.2 counting invariant — while still honouring
R4.4's "requires Developer confirmation to continue": the effective ceiling
moves up by one window per confirmation so the next pause fires one window
later, never retroactively un-counting work already done.

Spec: .kiro/specs/zocai-ecosystem-rebuild/design.md — "Execution Budget Enforcement (R4)"
Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6 (and the R5.2 HANDLE_ERROR count).
"""

from __future__ import annotations

import itertools
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import ClassVar

from shared_schema.agent_events import AgentEvent, ApprovalEvent

from zocai_gateway.edits import EditCoordinator, PlannedChange
from zocai_gateway.fsm import FSM, EmitSink
from zocai_gateway.memory.state_wrapper import Diff
from zocai_gateway.stages import Stage

__all__ = [
    "Budget",
    "BudgetKind",
    "RetainedState",
    "BudgetExceededError",
    "NotPausedError",
    "Orchestrator",
]


# ── Budget ───────────────────────────────────────────────────────────────────


class BudgetKind(str, Enum):
    """Which Execution_Budget ceiling triggered a pause.

    ``FILE`` is the 20 file-iteration ceiling (R4.3); ``ERROR`` is the 3
    error-recovery ceiling (R4.4). The kind is carried on the pause so the
    confirmation that resumes the run grants the matching budget window.
    """

    FILE = "file"
    ERROR = "error"


@dataclass(slots=True)
class Budget:
    """The cumulative Execution_Budget counters and their ceilings (R4).

    Mirrors the design's ``Budget`` shape: both counters start at zero (R4.1,
    R4.2), ``FILE_CEILING`` is 20 and ``ERROR_CEILING`` is 3, and the
    ``before_*`` guards report whether the next operation may proceed *before*
    it starts (R4.3, R4.4).

    The cumulative ``file_iterations`` / ``error_recoveries`` only ever grow by
    the number of operations actually performed (R4.1/R4.2 + R5.2). The
    *effective* ceilings (``file_ceiling`` / ``error_ceiling``) start at the
    fixed ceiling and are raised one window at a time by :meth:`grant_file_window`
    / :meth:`grant_error_window` when the developer confirms continuation, so a
    confirmed run can make progress without ever un-counting prior work.
    """

    #: The fixed file-iteration ceiling (R4.3) and error-recovery ceiling (R4.4).
    FILE_CEILING: ClassVar[int] = 20
    ERROR_CEILING: ClassVar[int] = 3

    file_iterations: int = 0
    error_recoveries: int = 0
    file_ceiling: int = 20
    error_ceiling: int = 3

    def before_file_op(self) -> bool:
        """Whether the next file iteration may start (``False`` ⇒ pause, R4.3)."""
        return self.file_iterations < self.file_ceiling

    def before_recovery(self) -> bool:
        """Whether the next error recovery may start (``False`` ⇒ pause, R4.4)."""
        return self.error_recoveries < self.error_ceiling

    def count_file_op(self) -> None:
        """Increment the cumulative file-iteration count by one (R4.1)."""
        self.file_iterations += 1

    def count_recovery(self) -> None:
        """Increment the cumulative error-recovery count by one (R4.2, R5.2)."""
        self.error_recoveries += 1

    def grant_file_window(self) -> None:
        """Raise the effective file ceiling by one window on confirmation (R4.6)."""
        self.file_ceiling += self.FILE_CEILING

    def grant_error_window(self) -> None:
        """Raise the effective error ceiling by one window on confirmation (R4.6)."""
        self.error_ceiling += self.ERROR_CEILING


@dataclass(frozen=True, slots=True)
class RetainedState:
    """The run state retained while a run is paused for budget (R4.5).

    Captures exactly what R4.5 requires to resume: the current FSM ``stage``,
    the ``active_file_markers``, the ``patch_diffs``, and both cumulative
    counters. :attr:`kind` records which ceiling fired so the resuming
    confirmation grants the matching budget window.
    """

    kind: BudgetKind
    stage: Stage
    active_file_markers: tuple[str, ...]
    patch_diffs: tuple[Diff, ...]
    file_iterations: int
    error_recoveries: int


class BudgetExceededError(RuntimeError):
    """Raised when an operation is attempted on a run already paused for budget.

    The run must be resumed via :meth:`Orchestrator.confirm_continue` before any
    further file iteration or error recovery is attempted (R4.5/R4.6).
    """


class NotPausedError(RuntimeError):
    """Raised when :meth:`Orchestrator.confirm_continue` is called on a live run."""


# ── Orchestrator ──────────────────────────────────────────────────────────────


@dataclass(slots=True)
class Orchestrator:
    """Enforces the Execution_Budget over a composed FSM + edit coordinator (R4).

    The Orchestrator gates every file read/write and every error-recovery entry
    on the :class:`Budget`, pausing and emitting a budget-exceeded event at the
    ceiling (R4.3, R4.4), retaining run state while paused (R4.5), and resuming
    from the retained stage on confirmation (R4.6).

    Args:
        fsm: The 9-stage FSM whose ``current`` stage is retained/resumed.
        edits: The PLAN_EDITS/APPLY_EDITS coordinator; its
            :class:`~zocai_gateway.toolsets.FullToolset` performs the counted
            workspace reads and writes.
        budget: The cumulative budget counters and ceilings. Defaults to a fresh
            zeroed :class:`Budget` (R4.1, R4.2).
        run_id: The run identifier stamped on emitted budget events.
        emit: Optional sink receiving each emitted budget event in order. When
            ``None`` events are still recorded in :attr:`events`.
        next_seq: Monotonic sequence source for emitted budget events. Defaults
            to an internal counter; the integration layer (task 14.1) injects a
            shared counter so budget events interleave with FSM/edit events
            (R6.5).
    """

    fsm: FSM
    edits: EditCoordinator
    budget: Budget = field(default_factory=Budget)
    run_id: str = "run"
    emit: EmitSink | None = None
    next_seq: Callable[[], int] = field(
        default_factory=lambda: itertools.count().__next__
    )
    active_file_markers: list[str] = field(init=False, default_factory=list)
    patch_diffs: list[Diff] = field(init=False, default_factory=list)
    events: list[AgentEvent] = field(init=False, default_factory=list)
    _retained: RetainedState | None = field(init=False, default=None)

    # -- introspection ------------------------------------------------------

    @property
    def is_paused(self) -> bool:
        """Whether the run is currently paused for an exceeded budget (R4.5)."""
        return self._retained is not None

    @property
    def retained_state(self) -> RetainedState | None:
        """The retained run state while paused, else ``None`` (R4.5)."""
        return self._retained

    # -- gated file operations (R4.1, R4.3) ---------------------------------

    def read_file(self, rel_path: Path | str) -> str | None:
        """Read a workspace file as a counted file iteration (R4.1).

        Returns the file text, or ``None`` when the run pauses because the file
        ceiling has been reached before this read could start (R4.3). The read
        is performed through the edit coordinator's confined toolset.
        """
        if not self._guard_file_op():
            return None
        text = self.edits.toolset.read_file(rel_path)
        self.budget.count_file_op()
        self._mark_active(str(rel_path))
        return text

    def write_file(self, change: PlannedChange) -> bool:
        """Write a planned change as a counted file iteration (R4.1).

        Returns ``True`` when the change was written, or ``False`` when the run
        pauses because the file ceiling has been reached before this write
        could start (R4.3). A written change updates the active markers and, if
        it carries diff text, the retained patch-diff array.
        """
        if not self._guard_file_op():
            return False
        self.edits.toolset.write_file(change.path, change.content)
        self.budget.count_file_op()
        self._mark_active(change.path)
        if change.diff:
            self.patch_diffs.append(Diff(path=change.path, diff=change.diff))
        return True

    # -- gated error recovery (R4.2, R4.4, R5.2) ----------------------------

    def enter_error_recovery(self) -> bool:
        """Enter the error-remediation loop as a counted recovery (R4.2, R5.2).

        Returns ``True`` when the entry is allowed and counted, or ``False``
        when the run pauses because the error-recovery ceiling has been reached
        before this attempt could start (R4.4). This gates the ``HANDLE_ERROR``
        entry; the remediation work itself is task 5.5.
        """
        if self._retained is not None:
            raise BudgetExceededError(
                "run is paused for budget; confirm continuation before recovering"
            )
        if not self.budget.before_recovery():
            self._pause(BudgetKind.ERROR)
            return False
        self.budget.count_recovery()
        return True

    # -- pause / resume (R4.5, R4.6) ----------------------------------------

    def confirm_continue(self) -> Stage:
        """Resume a budget-paused run from the retained stage (R4.6).

        Restores the retained run state (markers, diffs, counters), grants a
        fresh budget window for the ceiling that fired so the run can make
        progress, clears the pause, and returns the FSM stage to resume from.

        Raises:
            NotPausedError: If the run is not currently paused for budget.
        """
        retained = self._retained
        if retained is None:
            raise NotPausedError("run is not paused for an exceeded budget")
        # R4.5/R4.6: resume using the retained run state exactly.
        self.active_file_markers = list(retained.active_file_markers)
        self.patch_diffs = list(retained.patch_diffs)
        self.budget.file_iterations = retained.file_iterations
        self.budget.error_recoveries = retained.error_recoveries
        # R4.6: confirmation grants a fresh window so the resumed run proceeds.
        if retained.kind is BudgetKind.FILE:
            self.budget.grant_file_window()
        else:
            self.budget.grant_error_window()
        self._retained = None
        return retained.stage

    # -- internals ----------------------------------------------------------

    def _guard_file_op(self) -> bool:
        """Block-or-allow the next file iteration, pausing at the ceiling (R4.3)."""
        if self._retained is not None:
            raise BudgetExceededError(
                "run is paused for budget; confirm continuation before file ops"
            )
        if not self.budget.before_file_op():
            self._pause(BudgetKind.FILE)
            return False
        return True

    def _mark_active(self, marker: str) -> None:
        """Record ``marker`` as an active file marker (deduplicated, in order)."""
        if marker not in self.active_file_markers:
            self.active_file_markers.append(marker)

    def _pause(self, kind: BudgetKind) -> None:
        """Snapshot run state and emit the budget-exceeded event (R4.5, R4.3/4.4)."""
        self._retained = RetainedState(
            kind=kind,
            stage=self.fsm.current,
            active_file_markers=tuple(self.active_file_markers),
            patch_diffs=tuple(self.patch_diffs),
            file_iterations=self.budget.file_iterations,
            error_recoveries=self.budget.error_recoveries,
        )
        self._emit_budget_exceeded(kind)

    def _emit_budget_exceeded(self, kind: BudgetKind) -> None:
        """Emit a budget-exceeded approval event requiring confirmation (R4.3/4.4).

        The event is an :class:`ApprovalEvent`: it carries a prompt naming the
        ceiling that fired and, by virtue of being an approval row, requires the
        developer to confirm (approve) before the run continues.
        """
        ceiling = (
            self.budget.FILE_CEILING
            if kind is BudgetKind.FILE
            else self.budget.ERROR_CEILING
        )
        count = (
            self.budget.file_iterations
            if kind is BudgetKind.FILE
            else self.budget.error_recoveries
        )
        prompt = (
            f"execution budget exceeded: {kind.value} ceiling of {ceiling} reached "
            f"(count={count}); confirm to continue"
        )
        event = ApprovalEvent(
            seq=self.next_seq(),
            run_id=self.run_id,
            ts=datetime.now(timezone.utc).isoformat(),
            prompt=prompt,
        )
        self.events.append(event)
        if self.emit is not None:
            self.emit(event)
