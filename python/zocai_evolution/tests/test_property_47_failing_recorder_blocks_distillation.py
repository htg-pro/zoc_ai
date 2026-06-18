"""Property 47: A failing recorder blocks distillation regardless of count.

Feature: zocai-ecosystem-rebuild, Property 47: A failing recorder blocks
distillation regardless of how many trajectories are collected.

Validates: Requirements 12.5

*For any* collected trajectory count, while trajectory recording is currently
failing no distillation is applied, even when at least 50 verified trajectories
have already been collected.

The test pre-seeds a real :class:`InMemoryWeightBus` with an arbitrary number of
verified trajectories (the strategy spans counts well above the 50-trajectory
distillation threshold) and then drives a real :class:`EvolutionEngine` whose
:class:`TrajectoryCapture` always fails. Because the recorder is broken, neither
``on_run_complete`` nor ``try_distill`` may ever distill — no matter how large
the pre-seeded backlog is.
"""

from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st
from zocai_evolution import (
    TRAJECTORY_THRESHOLD,
    CheckOutcome,
    CompletedRun,
    Diff,
    EvolutionEngine,
    InMemoryWeightBus,
    Stage,
    Trajectory,
)

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


def _verified_run(run_id: str) -> CompletedRun:
    """A run that reached DONE with a final zero-exit RUN_CHECKS (R12.1)."""
    return CompletedRun(
        run_id=run_id,
        stages=HAPPY_STAGES,
        applied_edits=(Diff(path="a.py", diff="@@ -1 +1 @@"),),
        checks=(CheckOutcome(command="pytest", exit_code=0),),
        reached_done=True,
    )


class _FailingCapture:
    """A trajectory recorder whose ``record`` always fails (broken recorder)."""

    def record(self, trajectory: Trajectory) -> None:
        raise RuntimeError("shared-memory segment unavailable")


def _seeded_bus(count: int) -> InMemoryWeightBus:
    """A weight bus pre-loaded with ``count`` verified trajectories."""
    bus = InMemoryWeightBus()
    for i in range(count):
        bus.publish(Trajectory.from_run(_verified_run(f"seed-{i}")))
    return bus


# A range that straddles the threshold and also samples values comfortably
# above it, so every example exercises a backlog that *would* satisfy the
# count side of the gate were recording healthy.
_preseeded_counts = st.one_of(
    st.integers(min_value=0, max_value=2 * TRAJECTORY_THRESHOLD),
    st.integers(min_value=TRAJECTORY_THRESHOLD, max_value=10 * TRAJECTORY_THRESHOLD),
)


@settings(max_examples=200)
@given(preseeded=_preseeded_counts)
def test_failing_recorder_blocks_distillation_regardless_of_count(
    preseeded: int,
) -> None:
    """A failing recorder suspends distillation for any pre-seeded backlog.

    Feature: zocai-ecosystem-rebuild, Property 47.
    Validates: Requirements 12.5.
    """
    bus = _seeded_bus(preseeded)
    assert bus.collected_count() == preseeded

    engine = EvolutionEngine(bus=bus, capture=_FailingCapture())

    # Completing a run trips the recorder; the failed trajectory is excluded
    # and distillation is suspended (R12.4) — and crucially never runs (R12.5).
    result = engine.on_run_complete(_verified_run("trigger"))
    assert result is None
    assert engine.recording_operational is False

    # The backlog is unchanged: the failed trajectory was excluded, so the
    # count side of the gate may still be satisfied (>= 50) ...
    assert bus.collected_count() == preseeded

    # ... yet a direct distillation attempt is still blocked, because recording
    # is currently failing (R12.5) — a healthy backlog never overrides a broken
    # recorder.
    assert engine.try_distill() is None
