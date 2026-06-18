"""The Agent-Mode FSM stage domain (Requirement 3).

This module owns only the :class:`Stage` enum — the set of stages the
9-stage finite state machine can occupy. It is deliberately minimal so the
Mode_Router (task 4.1) can initialize an Agent path at :attr:`Stage.INTAKE`
without depending on the full transition table.

The legal transition table, stage-entry events, the empty-plan skip, and the
terminal ``ERROR_CLOSED`` path are implemented by the FSM (task 5.1), which
reuses this enum. The canonical happy-path order is fixed by R3.2:

    INTAKE → ANALYZE → MAP_FILES → READ_FILES → PLAN_EDITS → APPLY_EDITS
    → RUN_CHECKS → SUMMARY → DONE

``HANDLE_ERROR`` (R5.1) and ``ERROR_CLOSED`` (R3.10) are the off-happy-path
stages; they are part of the stage domain but their transitions are owned by
task 5.1. ``PAUSED`` (R4.3/4.4/5.7) is the budget/defer pause stage; it is
part of the stage domain but its transitions are owned by the Orchestrator
budget and remediation work (tasks 5.4/5.5).
"""

from __future__ import annotations

from enum import Enum

__all__ = ["Stage"]


class Stage(str, Enum):
    """A stage of the Agent-Mode FSM (R3.1, R3.2).

    Membership order matches the canonical happy-path order so callers can
    rely on declaration order; the actual legal transitions are enforced by
    the FSM (task 5.1), not by this enum.
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
    # Off-happy-path stages (transitions owned by task 5.1):
    HANDLE_ERROR = "handle_error"  # R5.1
    PAUSED = "paused"  # R4.3/4.4/5.7 budget + defer pauses (transitions owned by tasks 5.4/5.5)
    ERROR_CLOSED = "error_closed"  # R3.10 terminal error close (distinct from DONE)
