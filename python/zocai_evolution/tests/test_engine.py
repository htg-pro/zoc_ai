"""Unit tests for the Phase-1 evolution engine (Requirement 12).

These are example/edge-case tests. The dedicated property tests for Properties
45-48 live in tasks 13.2-13.5.
"""

from __future__ import annotations

import pytest
from zocai_evolution import (
    TRAJECTORY_THRESHOLD,
    CheckOutcome,
    CompletedRun,
    Diff,
    EvolutionEngine,
    InMemoryWeightBus,
    Stage,
    StubDistiller,
    Trajectory,
    TrajectoryRecordingError,
    WeightBusTrajectoryCapture,
    gate_open,
)
from zocai_evolution.capture import TrajectoryCapture

HAPPY_STAGES = (
    Stage.INTAKE,
    Stage.ANALYZE,
    Stage.MAP_FILES,
    Stage.READ_FILES,
    Stage.PLAN_EDITS,
    Stage.APPLY_EDITS,
    Stage.RUN_CHECKS,
    Stage.SUMMARY,
    Stage.DONE,
)


def make_run(
    *,
    run_id: str = "r-1",
    reached_done: bool = True,
    final_exit: int = 0,
    edits: tuple[Diff, ...] = (Diff(path="a.py", diff="@@ -1 +1 @@"),),
) -> CompletedRun:
    return CompletedRun(
        run_id=run_id,
        stages=HAPPY_STAGES,
        applied_edits=edits,
        checks=(CheckOutcome(command="pytest", exit_code=final_exit),),
        reached_done=reached_done,
    )


# ── R12.1 / R12.2: verified-run recording ──────────────────────────────────


def test_verified_run_records_trajectory_to_bus() -> None:
    engine = EvolutionEngine()
    engine.on_run_complete(make_run())
    assert engine.bus.collected_count() == 1


def test_trajectory_preserves_stage_order_edits_and_checks() -> None:
    run = make_run()
    traj = Trajectory.from_run(run)
    assert traj.stages == HAPPY_STAGES
    assert traj.applied_edits == run.applied_edits
    assert traj.checks == run.checks
    assert traj.verified is True


def test_unverified_run_not_recorded_when_did_not_reach_done() -> None:
    engine = EvolutionEngine()
    engine.on_run_complete(make_run(reached_done=False))
    assert engine.bus.collected_count() == 0


def test_unverified_run_not_recorded_when_final_check_nonzero() -> None:
    engine = EvolutionEngine()
    engine.on_run_complete(make_run(final_exit=1))
    assert engine.bus.collected_count() == 0


def test_run_with_no_checks_is_unverified() -> None:
    run = CompletedRun(
        run_id="r-x",
        stages=HAPPY_STAGES,
        applied_edits=(),
        checks=(),
        reached_done=True,
    )
    assert run.verified is False


# ── R12.3 / R12.5: distillation gate ────────────────────────────────────────


def test_gate_open_requires_both_threshold_and_recording() -> None:
    assert gate_open(TRAJECTORY_THRESHOLD, True) is True
    assert gate_open(TRAJECTORY_THRESHOLD - 1, True) is False
    assert gate_open(TRAJECTORY_THRESHOLD, False) is False
    assert gate_open(TRAJECTORY_THRESHOLD + 100, False) is False


def test_distillation_runs_only_at_threshold_with_recording_ok() -> None:
    engine = EvolutionEngine()
    result = None
    for i in range(TRAJECTORY_THRESHOLD):
        result = engine.on_run_complete(make_run(run_id=f"r-{i}"))
    # The run that crosses the threshold triggers the stub distillation.
    assert result is not None
    assert result.applied is True
    assert result.stub is True
    assert result.trajectory_count == TRAJECTORY_THRESHOLD


def test_no_distillation_below_threshold() -> None:
    engine = EvolutionEngine()
    result = engine.on_run_complete(make_run())
    assert result is None


def test_feature_flag_disables_distillation() -> None:
    engine = EvolutionEngine(distiller=StubDistiller(enabled=False))
    for i in range(TRAJECTORY_THRESHOLD + 5):
        result = engine.on_run_complete(make_run(run_id=f"r-{i}"))
    assert result is None


# ── R12.4 / R12.6: isolated recording failure ───────────────────────────────


class _FailingCapture:
    """A capture whose record always fails, simulating a broken recorder."""

    def record(self, trajectory: Trajectory) -> None:
        raise RuntimeError("shared-memory segment unavailable")


def test_recording_failure_excludes_trajectory_and_stays_operational() -> None:
    emitted: list[str] = []
    engine = EvolutionEngine(
        capture=_FailingCapture(),
        error_emitter=emitted.append,
    )
    # Does not raise — runtime stays operational (R12.6).
    result = engine.on_run_complete(make_run())
    assert result is None
    assert engine.recording_operational is False  # R12.4 suspended
    assert engine.bus.collected_count() == 0  # excluded
    assert len(emitted) == 1  # error indication emitted (R12.4)


def test_failing_recorder_blocks_distillation_despite_full_backlog() -> None:
    # Pre-load 50 trajectories directly onto the bus, then fail recording.
    bus = InMemoryWeightBus()
    for i in range(TRAJECTORY_THRESHOLD):
        bus.publish(Trajectory.from_run(make_run(run_id=f"seed-{i}")))
    engine = EvolutionEngine(bus=bus, capture=_FailingCapture())
    result = engine.on_run_complete(make_run())
    # R12.5: a failing recorder blocks distillation regardless of count.
    assert result is None
    assert engine.recording_operational is False


def test_error_emit_failure_does_not_crash_runtime() -> None:
    def boom(_message: str) -> None:
        raise OSError("error sink is also down")

    engine = EvolutionEngine(capture=_FailingCapture(), error_emitter=boom)
    # R12.6: emit failure is tolerated; no exception escapes.
    result = engine.on_run_complete(make_run())
    assert result is None
    assert engine.recording_operational is False


def test_recording_recovers_after_failure() -> None:
    class _FlakyCapture:
        def __init__(self) -> None:
            self.fail_next = True
            self._bus = InMemoryWeightBus()

        def record(self, trajectory: Trajectory) -> None:
            if self.fail_next:
                raise TrajectoryRecordingError("transient")
            self._bus.publish(trajectory)

    bus = InMemoryWeightBus()
    capture = WeightBusTrajectoryCapture(bus)

    # Use a real bus-backed capture but force one failure via a wrapper.
    flaky = _FlakyCapture()
    engine = EvolutionEngine(bus=bus, capture=flaky)
    engine.on_run_complete(make_run())
    assert engine.recording_operational is False
    flaky.fail_next = False
    engine.on_run_complete(make_run())
    assert engine.recording_operational is True
    # Sanity: a real capture works end to end too.
    capture.record(Trajectory.from_run(make_run()))
    assert bus.collected_count() >= 1


def test_capture_wraps_publish_failure() -> None:
    class _ExplodingBus:
        def publish(self, trajectory: Trajectory) -> None:
            raise ValueError("nope")

        def collected_count(self) -> int:
            return 0

    capture: TrajectoryCapture = WeightBusTrajectoryCapture(_ExplodingBus())
    with pytest.raises(TrajectoryRecordingError):
        capture.record(Trajectory.from_run(make_run()))
