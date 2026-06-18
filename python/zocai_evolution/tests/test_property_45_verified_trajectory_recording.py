"""Property test for verified-run trajectory recording.

Feature: zocai-ecosystem-rebuild, Property 45

Property 45: Verified runs record a complete trajectory.

*For any* Agent-Mode run that reaches DONE with the final RUN_CHECKS exit code
zero, a trajectory containing the ordered FSM stages, applied edits, and
RUN_CHECKS outcomes is recorded and published to the weight bus. A run is
*verified* iff it reached DONE **and** its final RUN_CHECKS outcome has a zero
exit code; verified runs record exactly one complete trajectory (the collected
count increments by one and the published trajectory preserves the run's
ordered stages, applied edits, and checks), while unverified runs record
nothing.

**Validates: Requirements 12.1, 12.2**

The property drives :func:`EvolutionEngine.on_run_complete` over generated
:class:`CompletedRun` values (varying ``reached_done``, the final check's exit
code, and the stages/edits/checks payloads). It depends only on the public
engine + weight-bus surface; the default capture publishes to the supplied
:class:`InMemoryWeightBus`, whose ``trajectories()`` snapshot lets the test
confirm the recorded trajectory is structurally complete.
"""

from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st

from zocai_evolution import (
    CheckOutcome,
    CompletedRun,
    Diff,
    EvolutionEngine,
    InMemoryWeightBus,
    Stage,
)

# ── strategies ──────────────────────────────────────────────────────────────

_stages = st.lists(st.sampled_from(list(Stage)), max_size=12).map(tuple)

_edits = st.lists(
    st.builds(
        Diff,
        path=st.text(min_size=0, max_size=20),
        diff=st.text(min_size=0, max_size=40),
    ),
    max_size=6,
).map(tuple)

_checks = st.lists(
    st.builds(
        CheckOutcome,
        command=st.text(min_size=0, max_size=20),
        # Mix zero and non-zero exit codes so the final-check gate varies.
        exit_code=st.integers(min_value=-2, max_value=4),
    ),
    max_size=6,
).map(tuple)


@st.composite
def _completed_runs(draw: st.DrawFn) -> CompletedRun:
    return CompletedRun(
        run_id=draw(st.text(min_size=1, max_size=12)),
        stages=draw(_stages),
        applied_edits=draw(_edits),
        checks=draw(_checks),
        reached_done=draw(st.booleans()),
    )


# ── property ─────────────────────────────────────────────────────────────────


@settings(max_examples=200)
@given(run=_completed_runs())
def test_property_45_verified_runs_record_a_complete_trajectory(
    run: CompletedRun,
) -> None:
    bus = InMemoryWeightBus()
    engine = EvolutionEngine(bus=bus)

    before = bus.collected_count()
    engine.on_run_complete(run)
    after = bus.collected_count()

    # A run is verified iff it reached DONE with a non-empty checks list whose
    # final outcome has a zero exit code (R12.1).
    verified = run.reached_done and bool(run.checks) and run.checks[-1].exit_code == 0
    assert verified == run.verified  # model agrees with the domain definition

    if verified:
        # Exactly one complete trajectory is recorded and published (R12.1/R12.2).
        assert after == before + 1
        recorded = bus.trajectories()[-1]
        assert recorded.run_id == run.run_id
        assert recorded.stages == run.stages
        assert recorded.applied_edits == run.applied_edits
        assert recorded.checks == run.checks
        assert recorded.verified is True
    else:
        # Unverified runs record nothing.
        assert after == before
