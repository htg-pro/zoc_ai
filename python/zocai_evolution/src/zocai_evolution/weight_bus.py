"""The shared-memory weight bus (Requirement 12.2).

Verified-session trajectories are collected through a shared-memory weight bus
so the distillation stage can later read the accumulated corpus. Phase 1 ships
the stable :class:`WeightBus` protocol and an in-process implementation guarded
by a lock; the cross-process shared-memory transport is a deployment concern
behind the same interface and is wired in a later phase. Capture, the gate, and
the distillation stub depend only on this protocol.
"""

from __future__ import annotations

import threading
from typing import Protocol, runtime_checkable

from .models import Trajectory

__all__ = ["InMemoryWeightBus", "WeightBus"]


@runtime_checkable
class WeightBus(Protocol):
    """Collects verified trajectories and reports how many have accumulated."""

    def publish(self, trajectory: Trajectory) -> None:
        """Publish a verified trajectory onto the bus (R12.2)."""
        ...

    def collected_count(self) -> int:
        """Return the number of trajectories collected so far."""
        ...


class InMemoryWeightBus:
    """A thread-safe in-process :class:`WeightBus` implementation.

    Publishing is serialized by a lock so concurrent runs (and the diary
    worker) can publish without racing the count. ``trajectories`` exposes a
    snapshot copy so callers cannot mutate the bus's internal store.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._trajectories: list[Trajectory] = []

    def publish(self, trajectory: Trajectory) -> None:
        with self._lock:
            self._trajectories.append(trajectory)

    def collected_count(self) -> int:
        with self._lock:
            return len(self._trajectories)

    def trajectories(self) -> tuple[Trajectory, ...]:
        """Return an immutable snapshot of the collected trajectories."""
        with self._lock:
            return tuple(self._trajectories)
