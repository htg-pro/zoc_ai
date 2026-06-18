"""Property test for isolated trajectory-recording failures (task 13.5).

Feature: zocai-ecosystem-rebuild, Property 48: Trajectory recording failures are
isolated and the runtime stays operational.

**Validates: Requirements 12.4, 12.6**

Design Property 48 (verbatim intent): *For any* trajectory whose recording fails
— regardless of the failure type and regardless of whether emitting the error
indication for that failure succeeds — that trajectory is excluded, distillation
does not run until recording is operational again, and the runtime stays
operational.

The behaviour under test lives in
:meth:`zocai_evolution.engine.EvolutionEngine.on_run_complete`. The property is
exercised against the real engine (no mocks of its recording-health/gate logic)
over arbitrary failure exception types and an ``error_emitter`` that may itself
raise. The only injected seams are a *controllable* :class:`TrajectoryCapture`
whose ``record`` raises a chosen exception while "broken" and publishes for real
otherwise — exactly how a real recorder would fail then recover — and an error
emitter that may itself blow up.

For every generated input the test asserts the four halves of Property 48:

* **Runtime stays operational (R12.6).** ``on_run_complete`` never propagates an
  exception, no matter the recording failure type and no matter whether the
  error emit itself raises.
* **Trajectory excluded (R12.4).** A failed record adds nothing to the bus and
  trips ``recording_operational`` to ``False``.
* **Distillation suspended while failing (R12.4).** No distillation runs while
  recording is failing, even with a full (>=50) backlog already collected.
* **Recovery (R12.4).** A subsequent successful record restores
  ``recording_operational`` and re-admits trajectories, re-opening the gate when
  the backlog is large enough.
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
    TrajectoryRecordingError,
)

_HAPPY_STAGES = (
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


def _make_verified_run(run_id: str) -> CompletedRun:
    """A run that reached DONE with a final zero-exit RUN_CHECKS (R12.1)."""
    return CompletedRun(
        run_id=run_id,
        stages=_HAPPY_STAGES,
        applied_edits=(Diff(path="a.py", diff="@@ -1 +1 @@"),),
        checks=(CheckOutcome(command="pytest", exit_code=0),),
        reached_done=True,
    )


class _WeirdError(Exception):
    """A non-standard failure type the engine has never heard of (R12.6)."""


# Varied recording-failure exception types — the engine must isolate *any*
# Exception subclass, including the package's own TrajectoryRecordingError and a
# bespoke one (R12.6 "regardless of the type").
_EXC_TYPES = (
    RuntimeError,
    ValueError,
    OSError,
    MemoryError,
    KeyError,
    TypeError,
    ArithmeticError,
    TrajectoryRecordingError,
    _WeirdError,
)

_FAILURES = st.builds(
    lambda exc_type, msg: exc_type(msg),
    st.sampled_from(_EXC_TYPES),
    st.text(max_size=24),
)


class _ControllableCapture:
    """A capture that raises ``self.exc`` while broken, else publishes for real."""

    def __init__(self, bus: InMemoryWeightBus, exc: BaseException) -> None:
        self._bus = bus
        self.exc: BaseException | None = exc

    def record(self, trajectory: Trajectory) -> None:
        if self.exc is not None:
            raise self.exc
        self._bus.publish(trajectory)


def _seed(bus: InMemoryWeightBus, count: int) -> None:
    for i in range(count):
        bus.publish(Trajectory.from_run(_make_verified_run(f"seed-{i}")))


@settings(max_examples=200, deadline=None)
@given(
    failure=_FAILURES,
    emitter_raises=st.booleans(),
    emitter_exc=_FAILURES,
    seed_count=st.sampled_from(
        [0, 1, TRAJECTORY_THRESHOLD - 1, TRAJECTORY_THRESHOLD, TRAJECTORY_THRESHOLD + 3]
    ),
)
def test_recording_failures_are_isolated_and_runtime_stays_operational(
    failure: BaseException,
    emitter_raises: bool,
    emitter_exc: BaseException,
    seed_count: int,
) -> None:
    """Property 48: a recording failure of any type — even with a failing error
    emitter — is isolated; the runtime stays up and recovers on the next record.

    Feature: zocai-ecosystem-rebuild, Property 48

    **Validates: Requirements 12.4, 12.6**
    """
    bus = InMemoryWeightBus()
    _seed(bus, seed_count)
    count_before = bus.collected_count()
    assert count_before == seed_count

    capture = _ControllableCapture(bus, failure)

    emitted: list[str] = []
    if emitter_raises:
        def emitter(_message: str) -> None:
            raise emitter_exc
    else:
        def emitter(message: str) -> None:
            emitted.append(message)

    engine = EvolutionEngine(bus=bus, capture=capture, error_emitter=emitter)

    # R12.6: on_run_complete must never propagate, regardless of the recording
    # failure type or whether the error emit itself raises.
    result = engine.on_run_complete(_make_verified_run("r-fail"))

    # A failed record yields no distillation result this call (R12.4).
    assert result is None
    # R12.4: recording is suspended after a failure.
    assert engine.recording_operational is False
    # R12.4: the offending trajectory is excluded — the bus did not grow.
    assert bus.collected_count() == count_before
    # R12.4: distillation does not run while recording is failing, even with a
    # full backlog already collected.
    assert engine.try_distill() is None
    # When the emitter is healthy, exactly one error indication was emitted; a
    # raising emitter is tolerated silently (R12.6).
    if not emitter_raises:
        assert len(emitted) == 1

    # ── Recovery: the next successful record restores recording (R12.4). ──
    capture.exc = None
    recovery = engine.on_run_complete(_make_verified_run("r-ok"))

    assert engine.recording_operational is True
    # The recovered trajectory is admitted to the bus.
    assert bus.collected_count() == count_before + 1
    # The gate re-opens iff the (now larger) backlog meets the threshold.
    if bus.collected_count() >= TRAJECTORY_THRESHOLD:
        assert recovery is not None
        assert recovery.applied is True
    else:
        assert recovery is None
