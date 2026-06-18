"""Property test for the combined distillation gate (task 13.3).

Feature: zocai-ecosystem-rebuild, Property 46: Distillation triggers only when
the threshold is met and recording is operational.

**Validates: Requirements 12.3**

Design Property 46 (verbatim intent): *For any* collected trajectory count and
recording-health state, on-policy distillation is applied if and only if at
least 50 verified trajectories have been collected and trajectory recording is
currently operational.

The test sweeps the trajectory count across the three regions that matter for
the ``count >= TRAJECTORY_THRESHOLD`` boundary — strictly below 50, exactly 50,
and above 50 — crossed with both recording-health states, and asserts the
biconditional at every layer that implements the gate:

* :func:`gate_open` — the pure predicate.
* :meth:`StubDistiller.maybe_distill` — the feature-flagged distiller that runs
  iff the gate is open (and never when the flag is off).
* :meth:`EvolutionEngine.try_distill` — the engine entry point that drives the
  distiller under its current recording-health state.

In every case distillation triggers iff ``count >= 50 AND recording_ok`` and
never otherwise.
"""

from __future__ import annotations

from hypothesis import given
from hypothesis import strategies as st
from zocai_evolution import (
    TRAJECTORY_THRESHOLD,
    CheckOutcome,
    CompletedRun,
    EvolutionEngine,
    InMemoryWeightBus,
    Stage,
    StubDistiller,
    Trajectory,
    gate_open,
)

# ---------------------------------------------------------------------------
# Generators
# ---------------------------------------------------------------------------

# Sweep the count across the three regions around the threshold so Hypothesis
# always exercises below/at/above 50 (not just whatever a flat integer range
# happens to sample).
_counts = st.one_of(
    st.integers(min_value=0, max_value=TRAJECTORY_THRESHOLD - 1),
    st.just(TRAJECTORY_THRESHOLD),
    st.integers(min_value=TRAJECTORY_THRESHOLD + 1, max_value=TRAJECTORY_THRESHOLD + 100),
)


def _dummy_trajectory(i: int) -> Trajectory:
    """A minimal verified trajectory for padding the weight bus to a count."""
    return Trajectory(
        run_id=f"t-{i}",
        stages=(Stage.DONE,),
        applied_edits=(),
        checks=(CheckOutcome(command="pytest", exit_code=0),),
        verified=True,
    )


def _verified_run() -> CompletedRun:
    return CompletedRun(
        run_id="trip",
        stages=(Stage.RUN_CHECKS, Stage.DONE),
        applied_edits=(),
        checks=(CheckOutcome(command="pytest", exit_code=0),),
        reached_done=True,
    )


class _FailingCapture:
    """A capture whose record always fails, tripping recording-health to False."""

    def record(self, trajectory: Trajectory) -> None:
        raise RuntimeError("shared-memory segment unavailable")


def _bus_with(count: int) -> InMemoryWeightBus:
    bus = InMemoryWeightBus()
    for i in range(count):
        bus.publish(_dummy_trajectory(i))
    return bus


def _engine_with(count: int, recording_ok: bool) -> EvolutionEngine:
    """Build an engine with ``count`` trajectories on the bus and the requested
    recording-health state, without changing the count."""
    bus = _bus_with(count)
    if recording_ok:
        # Recording starts operational by default.
        return EvolutionEngine(bus=bus)
    # Trip recording-health to False via a failing record; this excludes its own
    # trajectory and leaves the pre-loaded count untouched (R12.4).
    engine = EvolutionEngine(bus=bus, capture=_FailingCapture())
    engine.on_run_complete(_verified_run())
    return engine


# ---------------------------------------------------------------------------
# Property 46
# ---------------------------------------------------------------------------


@given(collected_count=_counts, recording_ok=st.booleans())
def test_distillation_triggers_iff_threshold_met_and_recording_ok(
    collected_count: int, recording_ok: bool
) -> None:
    """Property 46 (R12.3): the gate is open iff count >= 50 AND recording_ok.

    Feature: zocai-ecosystem-rebuild, Property 46

    **Validates: Requirements 12.3**
    """
    expected_open = recording_ok and collected_count >= TRAJECTORY_THRESHOLD

    # 1. The pure gate predicate.
    assert gate_open(collected_count, recording_ok) is expected_open

    # 2. The feature-flagged distiller runs iff the gate is open.
    bus = _bus_with(collected_count)
    enabled_result = StubDistiller(enabled=True).maybe_distill(bus, recording_ok)
    assert (enabled_result is not None) is expected_open
    if enabled_result is not None:
        assert enabled_result.applied is True
        assert enabled_result.stub is True
        assert enabled_result.trajectory_count == collected_count

    # 3. With the feature flag off, distillation never triggers regardless.
    assert StubDistiller(enabled=False).maybe_distill(bus, recording_ok) is None

    # 4. The engine entry point honours the same biconditional under its own
    #    recording-health state.
    engine = _engine_with(collected_count, recording_ok)
    assert engine.recording_operational is recording_ok
    engine_result = engine.try_distill()
    assert (engine_result is not None) is expected_open


# ---------------------------------------------------------------------------
# Anchor examples on the boundary (below / at / above 50 x recording health)
# ---------------------------------------------------------------------------


def test_anchor_boundary_cases() -> None:
    """Property 46 anchors: the four corners around the threshold.

    Feature: zocai-ecosystem-rebuild, Property 46

    **Validates: Requirements 12.3**
    """
    # at threshold + recording ok -> open
    assert gate_open(TRAJECTORY_THRESHOLD, True) is True
    # just below threshold + recording ok -> closed
    assert gate_open(TRAJECTORY_THRESHOLD - 1, True) is False
    # well above threshold but recording failing -> closed (R12.5 corollary)
    assert gate_open(TRAJECTORY_THRESHOLD + 100, False) is False
    # below threshold and recording failing -> closed
    assert gate_open(TRAJECTORY_THRESHOLD - 1, False) is False
