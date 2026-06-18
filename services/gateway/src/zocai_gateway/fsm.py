"""The Agent-Mode 9-stage FSM (Requirement 3).

This module encodes the legal transition table for the 9-stage finite state
machine so that **illegal transitions are unconstructable** — every transition
goes through :meth:`FSM.transition_to`, which raises
:class:`IllegalTransitionError` for any move not present in :data:`LEGAL`
(design.md "Stage Order Invariant (R3.2)").

On entering any stage the FSM emits a stage event conforming to the
Event_Contract that names the entered stage (R3.3). Emission is decoupled
through an injected sink and a :class:`StageEventFactory` so the Orchestrator /
SSE gateway (later tasks) can supply allocator-aware, semantically richer
events while the FSM remains independently usable and testable.

The module also implements the two documented happy-path branches and the
terminal error path that this task owns:

- the empty-plan skip ``PLAN_EDITS -> RUN_CHECKS`` (R3.8) versus the
  edits path ``PLAN_EDITS -> APPLY_EDITS``;
- the ``RUN_CHECKS`` exit-code branch ``-> SUMMARY`` (R5.8) versus
  ``-> HANDLE_ERROR`` (R5.1), and the remediation return
  ``HANDLE_ERROR -> PLAN_EDITS`` (R5.5);
- the terminal ``ERROR_CLOSED`` state (R3.10), reached on an unrecoverable
  error at any non-terminal stage and **distinct from ``DONE``**. ``DONE`` is
  the normal-path terminal reached only after ``SUMMARY``; ``ERROR_CLOSED`` is
  an error-termination path and is therefore not part of :data:`LEGAL`
  (the only way to reach it is :meth:`FSM.fail`), which keeps the legal table
  exactly the canonical/happy-path-plus-documented-branches shape from the
  design and preserves the strict ordering of R3.2 on the normal path.

The ``PAUSED`` stage (budget/defer pauses, R4.3/4.4/5.7) is part of the stage
domain; entry into it is provided by :meth:`FSM.pause` as the seam the
Orchestrator budget and remediation work (tasks 5.4/5.5) drive. Like
``ERROR_CLOSED`` it is reached **outside** :data:`LEGAL`, so it does not relax
the strict normal-path ordering of R3.2.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Protocol

from shared_schema.agent_events import (
    AgentEvent,
    CommandEvent,
    DoneEvent,
    SummaryEvent,
    ThinkingEvent,
)

from zocai_gateway.stages import Stage

__all__ = [
    "LEGAL",
    "FSM",
    "StageEventFactory",
    "EmitSink",
    "IllegalTransitionError",
    "AmbiguousTransitionError",
    "default_stage_event_factory",
]


# ── Legal transition table (design.md "Stage Order Invariant (R3.2)") ───────
#
# The happy path advances strictly INTAKE → ANALYZE → MAP_FILES → READ_FILES
# → PLAN_EDITS → APPLY_EDITS → RUN_CHECKS → SUMMARY → DONE. The only legal
# deviations encoded here are the documented branches: the empty-plan skip
# PLAN_EDITS → RUN_CHECKS (R3.8), the RUN_CHECKS exit-code branch (R5.1/5.8),
# and the remediation return HANDLE_ERROR → PLAN_EDITS (R5.5). ``DONE`` has no
# successors. ``ERROR_CLOSED`` and ``PAUSED`` are deliberately absent: the
# error path is reached only via :meth:`FSM.fail` and the pause path is owned
# by the Orchestrator, so neither is a constructable "normal" transition.
LEGAL: dict[Stage, set[Stage]] = {
    Stage.INTAKE: {Stage.ANALYZE},
    Stage.ANALYZE: {Stage.MAP_FILES},
    Stage.MAP_FILES: {Stage.READ_FILES},
    Stage.READ_FILES: {Stage.PLAN_EDITS},
    Stage.PLAN_EDITS: {Stage.APPLY_EDITS, Stage.RUN_CHECKS},  # R3.8
    Stage.APPLY_EDITS: {Stage.RUN_CHECKS},
    Stage.RUN_CHECKS: {Stage.SUMMARY, Stage.HANDLE_ERROR},  # R5.1/5.8
    Stage.HANDLE_ERROR: {Stage.PLAN_EDITS},  # R5.5
    Stage.SUMMARY: {Stage.DONE},
    Stage.DONE: set(),
}

#: The two terminal stages. ``DONE`` is the normal-path terminal (R3.4);
#: ``ERROR_CLOSED`` is the error-termination terminal (R3.10).
_TERMINAL: frozenset[Stage] = frozenset({Stage.DONE, Stage.ERROR_CLOSED})


# ── Event emission seams ────────────────────────────────────────────────────


class StageEventFactory(Protocol):
    """Builds a contract-conforming stage event that names ``stage`` (R3.3).

    The Orchestrator / SSE gateway injects a factory that carries real
    allocator metadata and per-stage payloads; :func:`default_stage_event_factory`
    is the standalone default used when none is supplied.
    """

    def __call__(
        self,
        stage: Stage,
        seq: int,
        run_id: str,
        ts: str,
        detail: str | None = None,
    ) -> AgentEvent: ...


#: A sink that receives each emitted stage event in production order.
EmitSink = Callable[[AgentEvent], None]


def default_stage_event_factory(
    stage: Stage,
    seq: int,
    run_id: str,
    ts: str,
    detail: str | None = None,
) -> AgentEvent:
    """Build a minimal Event_Contract event that names ``stage`` (R3.3).

    The event is fully populated from data the FSM owns (stage, ``seq``,
    ``run_id``, ``ts``), so the FSM emits a conforming stage event without
    depending on the allocator or edit/command payloads owned by other tasks:

    - ``DONE`` → a normal ``done`` completion event (R3.4).
    - ``ERROR_CLOSED`` → a terminal error event carried as a ``command`` event
      with an ``error_tag`` — distinct from the normal ``done`` event (R3.10).
    - ``SUMMARY`` → a ``summary`` event.
    - every other stage → a collapsible ``thinking`` event whose text names the
      entered stage.
    """
    if stage is Stage.DONE:
        return DoneEvent(seq=seq, run_id=run_id, ts=ts, ok=True)
    if stage is Stage.ERROR_CLOSED:
        return CommandEvent(
            seq=seq,
            run_id=run_id,
            ts=ts,
            command=f"<stage:{stage.value}>",
            error_tag=detail if detail is not None else stage.value,
        )
    if stage is Stage.SUMMARY:
        return SummaryEvent(seq=seq, run_id=run_id, ts=ts, text=stage.value)
    return ThinkingEvent(seq=seq, run_id=run_id, ts=ts, text=stage.value)


# ── Errors ──────────────────────────────────────────────────────────────────


class IllegalTransitionError(RuntimeError):
    """Raised when a transition is not present in :data:`LEGAL` (R3.2).

    This is what makes illegal transitions unconstructable: there is no code
    path that moves the FSM to a stage it is not legally allowed to enter.
    """

    def __init__(self, source: Stage, target: Stage) -> None:
        super().__init__(f"illegal FSM transition: {source.value} -> {target.value}")
        self.source = source
        self.target = target


class AmbiguousTransitionError(RuntimeError):
    """Raised by :meth:`FSM.advance` when a stage has more than one legal target.

    The branching stages (``PLAN_EDITS``, ``RUN_CHECKS``) require an explicit
    decision (:meth:`FSM.plan_complete`, :meth:`FSM.run_checks_result`) rather
    than a blind advance.
    """

    def __init__(self, source: Stage, targets: frozenset[Stage]) -> None:
        listed = ", ".join(sorted(t.value for t in targets)) or "<none>"
        super().__init__(
            f"ambiguous advance from {source.value}; legal targets: {listed}"
        )
        self.source = source
        self.targets = targets


# ── The FSM ─────────────────────────────────────────────────────────────────


@dataclass(slots=True)
class FSM:
    """The Agent-Mode finite state machine (R3.1, R3.2, R3.3, R3.8, R3.10).

    The FSM starts in ``initial`` (the Mode_Router uses ``Stage.INTAKE``,
    R3.1), emits a conforming stage event on entering that stage (R3.3), and
    only ever moves between stages through the guarded methods below, so an
    illegal transition cannot be constructed.

    Args:
        initial: The stage the FSM starts in.
        run_id: The run identifier stamped on emitted stage events.
        emit: Optional sink receiving each emitted stage event in order. When
            ``None`` the FSM still records events in :attr:`events`.
        stage_event_factory: Builds the conforming stage event for a stage
            (R3.3). Defaults to :func:`default_stage_event_factory`.
    """

    initial: Stage = Stage.INTAKE
    run_id: str = "run"
    emit: EmitSink | None = None
    stage_event_factory: StageEventFactory = default_stage_event_factory
    current: Stage = field(init=False)
    events: list[AgentEvent] = field(init=False, default_factory=list)
    _seq: int = field(init=False, default=0)

    def __post_init__(self) -> None:
        self.current = self.initial
        # Entering the initial stage is a stage entry and must emit (R3.3).
        self._emit_entry(self.initial)

    # -- introspection ------------------------------------------------------

    @property
    def is_terminal(self) -> bool:
        """Whether the FSM has reached a terminal stage (``DONE``/``ERROR_CLOSED``)."""
        return self.current in _TERMINAL

    def legal_targets(self) -> frozenset[Stage]:
        """The set of stages the FSM may legally enter next from ``current``."""
        return frozenset(LEGAL.get(self.current, set()))

    def can_transition(self, target: Stage) -> bool:
        """Whether moving to ``target`` is a legal transition from ``current``."""
        return target in LEGAL.get(self.current, set())

    # -- transitions --------------------------------------------------------

    def transition_to(self, target: Stage) -> Stage:
        """Move to ``target`` if legal, emitting its stage event (R3.2, R3.3).

        Raises:
            IllegalTransitionError: If ``target`` is not a legal successor of
                the current stage. This guard is what makes illegal
                transitions unconstructable.
        """
        if target not in LEGAL.get(self.current, set()):
            raise IllegalTransitionError(self.current, target)
        self.current = target
        self._emit_entry(target)
        return self.current

    def advance(self) -> Stage:
        """Advance to the sole legal successor of a deterministic stage.

        Raises:
            AmbiguousTransitionError: If the current stage has zero or more
                than one legal target (e.g. ``PLAN_EDITS`` / ``RUN_CHECKS``);
                use the explicit branch methods for those.
        """
        targets = self.legal_targets()
        if len(targets) != 1:
            raise AmbiguousTransitionError(self.current, targets)
        (only,) = tuple(targets)
        return self.transition_to(only)

    def plan_complete(self, *, has_changes: bool) -> Stage:
        """Branch out of ``PLAN_EDITS`` on whether the edit plan has changes.

        A non-empty plan advances to ``APPLY_EDITS``; an empty plan skips file
        modification and advances directly to ``RUN_CHECKS`` (R3.8).

        Raises:
            IllegalTransitionError: If called outside ``PLAN_EDITS``.
        """
        if self.current is not Stage.PLAN_EDITS:
            raise IllegalTransitionError(
                self.current,
                Stage.APPLY_EDITS if has_changes else Stage.RUN_CHECKS,
            )
        return self.transition_to(Stage.APPLY_EDITS if has_changes else Stage.RUN_CHECKS)

    def run_checks_result(self, exit_code: int) -> Stage:
        """Branch out of ``RUN_CHECKS`` on the check command exit code.

        A zero exit code advances to ``SUMMARY`` (R5.8); a non-zero exit code
        transitions to ``HANDLE_ERROR`` (R5.1).

        Raises:
            IllegalTransitionError: If called outside ``RUN_CHECKS``.
        """
        if self.current is not Stage.RUN_CHECKS:
            raise IllegalTransitionError(
                self.current,
                Stage.SUMMARY if exit_code == 0 else Stage.HANDLE_ERROR,
            )
        return self.transition_to(Stage.SUMMARY if exit_code == 0 else Stage.HANDLE_ERROR)

    def remediate(self) -> Stage:
        """Return from ``HANDLE_ERROR`` to ``PLAN_EDITS`` for a remediation pass (R5.5).

        Raises:
            IllegalTransitionError: If called outside ``HANDLE_ERROR``.
        """
        return self.transition_to(Stage.PLAN_EDITS)

    def pause(self, reason: str | None = None) -> Stage:
        """Pause the run at the ``PAUSED`` stage (R4.3/4.4/5.7).

        Both the budget-ceiling pauses (task 5.4) and the remediation defer
        (task 5.5) move the FSM to ``PAUSED`` from a non-terminal stage and
        emit a conforming stage-entry event naming it (R3.3). Like
        ``ERROR_CLOSED``, ``PAUSED`` is reached **outside** :data:`LEGAL` — the
        only way in is this method — so encoding it here does not relax the
        strict normal-path ordering of R3.2; the pause/defer transitions are
        the Orchestrator/remediation seam the design assigns to tasks 5.4/5.5.

        A paused run is not terminal: the Orchestrator resumes it from the
        retained stage on developer confirmation (R4.6), so this method does
        not move the FSM into a terminal state.

        Raises:
            IllegalTransitionError: If the FSM is already terminal.
        """
        if self.is_terminal:
            raise IllegalTransitionError(self.current, Stage.PAUSED)
        self.current = Stage.PAUSED
        self._emit_entry(Stage.PAUSED, reason)
        return self.current

    def fail(self, reason: str) -> Stage:
        """Terminate the run via the ``ERROR_CLOSED`` error path (R3.10).

        An unrecoverable error at any non-terminal stage moves the FSM to the
        terminal ``ERROR_CLOSED`` state — distinct from ``DONE`` — and emits a
        terminal error event naming the failure. This path is intentionally
        outside :data:`LEGAL`, so it does not relax the normal-path ordering of
        R3.2.

        Raises:
            IllegalTransitionError: If the FSM is already terminal.
        """
        if self.is_terminal:
            raise IllegalTransitionError(self.current, Stage.ERROR_CLOSED)
        self.current = Stage.ERROR_CLOSED
        self._emit_entry(Stage.ERROR_CLOSED, reason)
        return self.current

    # -- emission -----------------------------------------------------------

    def _emit_entry(self, stage: Stage, detail: str | None = None) -> None:
        """Build and emit a conforming stage event for entering ``stage`` (R3.3)."""
        ts = datetime.now(timezone.utc).isoformat()
        event = self.stage_event_factory(stage, self._seq, self.run_id, ts, detail)
        self._seq += 1
        self.events.append(event)
        if self.emit is not None:
            self.emit(event)
