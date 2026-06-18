"""The parametric evolution engine, Phase 1 (Requirement 12).

:class:`EvolutionEngine` is the entry point the Orchestrator drives when an
Agent-Mode run completes. It:

* records a trajectory for runs that reached ``DONE`` with a final zero-exit
  RUN_CHECKS, publishing it to the shared-memory weight bus (R12.1, R12.2);
* gates distillation on **both** ≥ 50 collected trajectories **and**
  operational recording (R12.3), so a failing recorder blocks distillation
  regardless of how many trajectories exist (R12.5);
* on a recording failure, excludes the trajectory, suspends distillation until
  recording recovers, keeps the runtime operational, and emits an error
  indication — regardless of the failure type and regardless of whether the
  error emit itself succeeds (R12.4, R12.6);
* keeps distillation stubbed behind a feature flag, with the NeMo backend
  (Phase 2) and weight feedback (Phase 3) deferred.
"""

from __future__ import annotations

from collections.abc import Callable

from .capture import TrajectoryCapture, WeightBusTrajectoryCapture
from .distillation import Distiller, DistillResult, StubDistiller
from .models import CompletedRun, Trajectory
from .weight_bus import InMemoryWeightBus, WeightBus

__all__ = ["ErrorEmitter", "EvolutionEngine"]

#: Sink for error indications. Implementations may themselves fail; the engine
#: tolerates that without taking the runtime down (R12.6).
ErrorEmitter = Callable[[str], None]


class EvolutionEngine:
    """Phase-1 trajectory capture + gated distillation stub (Requirement 12)."""

    def __init__(
        self,
        *,
        bus: WeightBus | None = None,
        capture: TrajectoryCapture | None = None,
        distiller: Distiller | None = None,
        error_emitter: ErrorEmitter | None = None,
    ) -> None:
        self._bus: WeightBus = bus if bus is not None else InMemoryWeightBus()
        self._capture: TrajectoryCapture = (
            capture if capture is not None else WeightBusTrajectoryCapture(self._bus)
        )
        self._distiller: Distiller = distiller if distiller is not None else StubDistiller()
        self._error_emitter = error_emitter
        # Recording starts operational; a failed record trips it until the next
        # successful record (R12.4 "until trajectory recording is operational again").
        self._recording_ok = True

    @property
    def bus(self) -> WeightBus:
        return self._bus

    @property
    def recording_operational(self) -> bool:
        """Whether trajectory recording is currently operational (R12.4, R12.5)."""
        return self._recording_ok

    def on_run_complete(self, run: CompletedRun) -> DistillResult | None:
        """Process a completed run: record a verified trajectory, then attempt
        gated distillation.

        Returns the :class:`DistillResult` when distillation runs (always a stub
        in Phase 1), or ``None`` when the run is unverified, recording failed,
        or the distillation gate is closed. Never raises for a recording
        failure — the runtime stays operational (R12.6).
        """
        trajectory = Trajectory.from_run(run)
        if not trajectory.verified:
            # R12.1: only runs that reached DONE with a final zero-exit
            # RUN_CHECKS are recorded.
            return None
        if not self._record(trajectory):
            # R12.4: the failed trajectory is excluded and distillation is
            # suspended until recording recovers.
            return None
        return self.try_distill()

    def try_distill(self) -> DistillResult | None:
        """Attempt distillation under the current recording-health state.

        Distillation runs iff ≥ 50 trajectories are collected and recording is
        operational (R12.3); a failing recorder keeps it suspended regardless of
        count (R12.5).
        """
        return self._distiller.maybe_distill(self._bus, self._recording_ok)

    # ── internals ────────────────────────────────────────────────────────────

    def _record(self, trajectory: Trajectory) -> bool:
        """Record a trajectory, updating recording health. Returns ``True`` on
        success. Any failure — of any type — is isolated (R12.4, R12.6)."""
        try:
            self._capture.record(trajectory)
        except Exception as exc:  # R12.6: any failure type is isolated
            self._recording_ok = False
            self._emit_error(
                f"trajectory recording failed for run {trajectory.run_id!r}; "
                f"distillation suspended until recording recovers: {exc!r}"
            )
            return False
        # A successful record means recording is operational again (R12.4).
        self._recording_ok = True
        return True

    def _emit_error(self, message: str) -> None:
        """Emit an error indication, tolerating an emitter that itself fails.

        R12.6: the runtime stays operational regardless of whether emitting the
        error indication succeeds.
        """
        emitter = self._error_emitter
        if emitter is None:
            return
        try:
            emitter(message)
        except Exception:  # R12.6: a failed emit must not crash the runtime
            return
