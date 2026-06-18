"""Gated, feature-flagged distillation (Requirements 12.3, 12.5).

On-policy distillation runs across the gathered trajectories **only when both**
conditions hold: at least :data:`TRAJECTORY_THRESHOLD` (50) verified
trajectories have been collected **and** trajectory recording is currently
operational (R12.3). A failing recorder blocks distillation regardless of how
many trajectories are collected (R12.5) — a healthy backlog never overrides a
broken recorder.

Phase 1 keeps distillation **stubbed behind a feature flag**: the NeMo
distillation backend (Phase 2) and feeding distilled weights back into the
local tier models (Phase 3) are deferred. :class:`StubDistiller` evaluates the
gate and reports whether distillation *would* run, but performs no training —
every result it returns is marked ``stub=True``. When the feature flag is
disabled, distillation never runs even if the gate is otherwise satisfied.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from .weight_bus import WeightBus

__all__ = [
    "TRAJECTORY_THRESHOLD",
    "DistillResult",
    "Distiller",
    "StubDistiller",
    "gate_open",
]

#: Minimum verified trajectories required before distillation may run (R12.3).
TRAJECTORY_THRESHOLD = 50


def gate_open(collected_count: int, recording_ok: bool) -> bool:
    """Return ``True`` iff the distillation gate is open (R12.3, R12.5).

    The gate is open only when *both* at least :data:`TRAJECTORY_THRESHOLD`
    trajectories have been collected *and* recording is currently operational.
    A failing recorder (``recording_ok=False``) keeps the gate closed no matter
    how high ``collected_count`` is (R12.5).
    """
    return recording_ok and collected_count >= TRAJECTORY_THRESHOLD


@dataclass(frozen=True, slots=True)
class DistillResult:
    """The outcome of a distillation attempt.

    ``applied`` reflects the gate decision (R12.3): it is ``True`` only when the
    distiller actually ran across the corpus. ``stub`` is ``True`` whenever the
    Phase-1 stub backend handled the request, signalling that no real NeMo
    training occurred yet (Phase 2 deferred).
    """

    applied: bool
    stub: bool
    trajectory_count: int
    detail: str


@runtime_checkable
class Distiller(Protocol):
    """Applies on-policy distillation when the gate permits (R12.3, R12.5)."""

    def maybe_distill(self, bus: WeightBus, recording_ok: bool) -> DistillResult | None:
        """Run distillation iff the gate is open; otherwise return ``None``."""
        ...


class StubDistiller:
    """Feature-flagged Phase-1 distiller that evaluates the gate but never trains.

    When ``enabled`` (the feature flag) is ``False``, distillation is fully
    disabled and :meth:`maybe_distill` always returns ``None``. When enabled, it
    returns a stub :class:`DistillResult` exactly when the gate is open
    (R12.3) and ``None`` otherwise — including whenever recording is failing
    (R12.5).
    """

    def __init__(self, *, enabled: bool = True) -> None:
        self._enabled = enabled

    @property
    def enabled(self) -> bool:
        """Whether the distillation feature flag is on."""
        return self._enabled

    def maybe_distill(self, bus: WeightBus, recording_ok: bool) -> DistillResult | None:
        if not self._enabled:
            return None
        count = bus.collected_count()
        if not gate_open(count, recording_ok):
            return None
        return DistillResult(
            applied=True,
            stub=True,
            trajectory_count=count,
            detail=(
                "Phase 1 stub: gate open; NeMo distillation backend (Phase 2) and "
                "weight feedback (Phase 3) deferred"
            ),
        )
