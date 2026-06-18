"""The SSE emit gate — contract validation, ordering, and diary mirroring (R6).

Every event produced by the FSM/Orchestrator passes through a single
:class:`EmitGate` before it can reach the SSE bus. The gate is the one place
that decides whether a payload is allowed onto the wire, and it enforces three
guarantees from Requirement 6:

* **Contract validation (R6.2, R6.4).** Each payload is validated against the
  shared Event_Contract via ``AgentEventModel.model_validate``. A conforming
  payload necessarily carries a valid ``type`` discriminator matching exactly
  one of the eight row kinds (R6.2). A *non-conforming* payload is **discarded**
  — it is never forwarded to the sink — a contract-violation entry naming the
  offending ``type`` is recorded, and the stream stays open so one bad payload
  cannot tear down a run (R6.4).

* **FSM production order (R6.5).** The gate forwards conforming events to the
  sink synchronously, in the exact order :meth:`EmitGate.emit` is called. The
  per-run SSE queue the sink writes to is FIFO, so the order events are produced
  by the FSM equals the order they are emitted over the bus end to end.

* **Non-blocking diary mirror (R9.3).** Each conforming event is also handed to
  the Tier 1 :class:`~zocai_gateway.memory.diary_worker.DiaryWorker`, whose
  ``append`` only enqueues and returns, so mirroring to disk never adds latency
  to SSE emission. The mirror is optional: a gate without a diary still emits.

This module owns the gate logic only; wiring it onto a concrete per-run
``asyncio`` queue lives in :mod:`zocai_gateway.app`.

Spec: .kiro/specs/zocai-ecosystem-rebuild/design.md — "Contract Validation (R6.4)"
Requirements: 6.2, 6.4, 6.5 (plus the R9.3 non-blocking diary mirror).
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Protocol

from pydantic import ValidationError
from shared_schema.agent_events import AgentEventModel

__all__ = [
    "ContractViolation",
    "DiaryMirror",
    "EmitGate",
    "EmitSink",
]

#: A sink that receives each *conforming* event as a wire-form mapping
#: (camelCase keys, ``type`` discriminator) in FSM production order (R6.5).
EmitSink = Callable[[Mapping[str, object]], None]


class DiaryMirror(Protocol):
    """The slice of the Tier 1 Diary_Worker the gate depends on (R9.3).

    Only ``append`` is needed: it must enqueue the event and return without
    waiting on disk, keeping emission non-blocking.
    """

    def append(self, event: Mapping[str, object]) -> int: ...


@dataclass(frozen=True, slots=True)
class ContractViolation:
    """A recorded rejection of a non-conforming payload (R6.4).

    Attributes:
        index: Monotonic index of this violation in the order detected, so the
            sequence of rejections is itself observable/assertable.
        event_type: The ``type`` discriminator the offending payload claimed,
            or ``None`` if it carried none. This is the "non-conforming event
            type" the requirement says to name in the violation entry.
    """

    index: int
    event_type: str | None


class EmitGate:
    """Single validation gate between event producers and the SSE bus (R6).

    Args:
        sink: Receives each conforming event, in call order, as a wire-form
            mapping. Typically enqueues onto the run's SSE queue.
        diary: Optional Tier 1 diary mirror. When provided, every conforming
            event is appended to it non-blockingly (R9.3); when ``None`` the
            gate emits without mirroring.
    """

    __slots__ = ("_sink", "_diary", "_violations")

    def __init__(self, sink: EmitSink, diary: DiaryMirror | None = None) -> None:
        self._sink = sink
        self._diary = diary
        self._violations: list[ContractViolation] = []

    @property
    def violations(self) -> tuple[ContractViolation, ...]:
        """The contract-violation entries recorded so far, in detection order."""
        return tuple(self._violations)

    def emit(self, payload: Mapping[str, object]) -> bool:
        """Validate ``payload`` and, if conforming, forward it to the sink.

        Returns ``True`` when the payload conformed to the Event_Contract and
        was emitted (and mirrored to the diary), ``False`` when it was
        discarded as non-conforming.

        A conforming payload is re-serialized from its validated model so the
        bytes on the wire are exactly the contract's canonical wire form
        (camelCase aliases, ``type`` discriminator) regardless of how the
        producer spelled the input. A non-conforming payload is discarded, a
        violation naming its ``type`` is recorded, and the stream stays open
        (R6.4) — this method never raises for a bad payload.
        """
        try:
            event = AgentEventModel.model_validate(payload)
        except ValidationError:
            self._record_violation(payload)
            return False

        # Canonical wire form: camelCase keys + the validated ``type``
        # discriminator (R6.2). by_alias keeps it identical to the TS contract.
        wire: dict[str, object] = event.root.model_dump(by_alias=True)

        # Forward in call order; the FIFO sink preserves FSM production order (R6.5).
        self._sink(wire)

        # Non-blocking Tier 1 mirror (R9.3): append only enqueues and returns.
        if self._diary is not None:
            self._diary.append(wire)
        return True

    def _record_violation(self, payload: Mapping[str, object]) -> None:
        """Record a contract-violation entry naming the non-conforming type (R6.4)."""
        raw_type = payload.get("type")
        event_type = raw_type if isinstance(raw_type, str) else None
        self._violations.append(
            ContractViolation(index=len(self._violations), event_type=event_type)
        )
