"""Trajectory capture (Requirements 12.1, 12.2, 12.4).

:class:`TrajectoryCapture` is the recording surface the evolution engine drives
when a verified run completes. The Phase-1 implementation,
:class:`WeightBusTrajectoryCapture`, records a trajectory by publishing it to a
:class:`~zocai_evolution.weight_bus.WeightBus`.

Recording can fail for any reason (a full or unavailable shared-memory segment,
a serialization error, an out-of-memory condition). Such failures surface as a
:class:`TrajectoryRecordingError` so the engine can exclude the trajectory,
suspend distillation, and keep the runtime operational (R12.4, R12.6) — the
engine treats *any* exception from :meth:`record` as a recording failure, so a
conforming capture is free to raise its own exception types too.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from .models import Trajectory
from .weight_bus import WeightBus

__all__ = [
    "TrajectoryCapture",
    "TrajectoryRecordingError",
    "WeightBusTrajectoryCapture",
]


class TrajectoryRecordingError(RuntimeError):
    """Raised when recording a trajectory fails (R12.4).

    The engine excludes the offending trajectory and suspends distillation
    until recording is operational again; it never lets this propagate far
    enough to take the runtime down (R12.6).
    """


@runtime_checkable
class TrajectoryCapture(Protocol):
    """Records a verified trajectory for later training use (R12.1)."""

    def record(self, trajectory: Trajectory) -> None:
        """Record ``trajectory``; raise on failure so the engine can exclude
        it and suspend distillation (R12.4)."""
        ...


class WeightBusTrajectoryCapture:
    """Records trajectories by publishing them to the shared-memory weight bus.

    A failure to publish is wrapped in :class:`TrajectoryRecordingError` so the
    engine's recording-health gate trips regardless of the underlying cause.
    """

    def __init__(self, bus: WeightBus) -> None:
        self._bus = bus

    def record(self, trajectory: Trajectory) -> None:
        try:
            self._bus.publish(trajectory)
        except Exception as exc:  # any publish failure is a recording failure (R12.4)
            raise TrajectoryRecordingError(
                f"failed to publish trajectory for run {trajectory.run_id!r}: {exc}"
            ) from exc
