"""Domain models for the parametric evolution engine (Layer 5, Requirement 12).

The evolution engine is a standalone package (it must build and typecheck on
its own), so it owns minimal copies of the cross-layer value types it needs —
:class:`Stage`, :class:`Diff`, and :class:`CheckOutcome` — rather than importing
the gateway package. These mirror the gateway definitions field-for-field so a
trajectory recorded here is structurally identical to the run state the
Orchestrator produces.

A :class:`Trajectory` (R12.1) captures the ordered FSM stages, the applied
edits, and the RUN_CHECKS outcomes of a completed Agent-Mode run. A run is
*verified* — and therefore eligible for recording — only when it reached
``DONE`` with the final RUN_CHECKS returning a zero exit code.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

__all__ = [
    "CheckOutcome",
    "CompletedRun",
    "Diff",
    "Stage",
    "Trajectory",
]


class Stage(str, Enum):
    """A stage of the Agent-Mode FSM (mirrors ``zocai_gateway.stages.Stage``).

    Declaration order follows the canonical happy-path order (R3.2) so a
    recorded trajectory's stage list reads in execution order.
    """

    INTAKE = "intake"
    ANALYZE = "analyze"
    MAP_FILES = "map_files"
    READ_FILES = "read_files"
    PLAN_EDITS = "plan_edits"
    APPLY_EDITS = "apply_edits"
    RUN_CHECKS = "run_checks"
    SUMMARY = "summary"
    DONE = "done"
    HANDLE_ERROR = "handle_error"
    PAUSED = "paused"
    ERROR_CLOSED = "error_closed"


@dataclass(frozen=True, slots=True)
class Diff:
    """A single applied patch: the edited ``path`` and its unified ``diff`` text.

    Structurally identical to the gateway ``Diff`` so an edit recorded in a
    trajectory matches the patch diff produced during ``APPLY_EDITS``.
    """

    path: str
    diff: str


@dataclass(frozen=True, slots=True)
class CheckOutcome:
    """The outcome of a single RUN_CHECKS command: the ``command`` and its
    process ``exit_code``. A zero exit code means the check passed."""

    command: str
    exit_code: int

    @property
    def passed(self) -> bool:
        return self.exit_code == 0


@dataclass(frozen=True, slots=True)
class CompletedRun:
    """A finished Agent-Mode run handed to the evolution engine.

    ``reached_done`` records whether the FSM terminated at ``DONE`` (as opposed
    to ``ERROR_CLOSED`` or a pause). Only a run that reached ``DONE`` whose
    final RUN_CHECKS outcome has a zero exit code is *verified* (R12.1).
    """

    run_id: str
    stages: tuple[Stage, ...]
    applied_edits: tuple[Diff, ...]
    checks: tuple[CheckOutcome, ...]
    reached_done: bool

    @property
    def verified(self) -> bool:
        """``True`` iff the run reached ``DONE`` with the final RUN_CHECKS
        returning a zero exit code (R12.1)."""
        if not self.reached_done:
            return False
        if not self.checks:
            return False
        return self.checks[-1].exit_code == 0


@dataclass(frozen=True, slots=True)
class Trajectory:
    """A recorded run trajectory for later training use (R12.1).

    Carries the ordered FSM ``stages``, the ``applied_edits``, and the RUN_CHECKS
    ``checks`` outcomes. ``verified`` marks runs that reached ``DONE`` with a
    final zero-exit RUN_CHECKS; only verified trajectories are recorded.
    """

    run_id: str
    stages: tuple[Stage, ...]
    applied_edits: tuple[Diff, ...]
    checks: tuple[CheckOutcome, ...]
    verified: bool

    @classmethod
    def from_run(cls, run: CompletedRun) -> Trajectory:
        """Build a trajectory from a completed run, preserving stage order,
        applied edits, and RUN_CHECKS outcomes (R12.1)."""
        return cls(
            run_id=run.run_id,
            stages=tuple(run.stages),
            applied_edits=tuple(run.applied_edits),
            checks=tuple(run.checks),
            verified=run.verified,
        )
