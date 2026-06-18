"""Property test for hot-swap failed-load retain-and-pause (task 11.4).

Feature: zocai-ecosystem-rebuild, Property 44: A failed model load retains the
State_Wrapper and pauses the run with an error.

**Validates: Requirements 11.7**

Design Property 44 (verbatim intent): *For any* hot-swap trigger whose
replacement load fails — the loader raises, or its measured duration overruns
the 30 s deadline — the coordinator returns ``LOAD_FAILED``, keeps the run
paused, **retains** the State_Wrapper (the store still holds the saved state and
``load()`` returns exactly what was saved), and emits an error event naming the
failed load tier.

Strategy
--------
We drive :meth:`HotSwapCoordinator.trigger` over the cross product of:

* an *arbitrary* :class:`StateWrapper` (any FSM stage, any mix of active-file
  markers, patch diffs, and compilation logs); and
* an *arbitrary non-Cloud* active tier (Local SLM or Edge) — the tiers that
  have a higher tier to upshift into, so the trigger actually attempts a load
  (Cloud would short-circuit to continue-on-cloud, R11.6).

Each example also picks one of the two failure modes:

* **raise** — the loader raises, so the load fails outright; or
* **overrun** — the loader returns, but an injected clock reports a measured
  duration strictly greater than :data:`HOT_SWAP_DEADLINE_SECONDS`.

For each example we assert the four Property-44 facts:

* the outcome is ``LOAD_FAILED`` and the run is paused (R11.7);
* the wrapper is retained — the store file still exists and ``store.load()``
  returns a wrapper equal to the saved state (R11.7);
* an error event was emitted, and it names the failed load *target* tier
  (the next higher tier) (R11.7).

A fresh temporary store per example keeps each generated run isolated.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from hypothesis import given, settings
from hypothesis import strategies as st

from shared_schema.agent_events import AgentEvent

from zocai_gateway.hot_swap import (
    HOT_SWAP_DEADLINE_SECONDS,
    HotSwapCoordinator,
    HotSwapOutcomeKind,
    next_higher_tier,
)
from zocai_gateway.memory.state_wrapper import (
    Diff,
    FailureRecord,
    StateWrapper,
    StateWrapperStore,
)
from zocai_gateway.model_allocator import ModelAllocator
from zocai_gateway.model_interface import LocalSLM, ModelInterface, ModelTier
from zocai_gateway.stages import Stage

# The non-Cloud tiers: each has a strictly higher tier to upshift into (R11.2),
# so a triggered swap from one of them actually attempts a load whose failure we
# can observe. Cloud would short-circuit to continue-on-cloud (R11.6).
_NON_CLOUD_TIERS = [ModelTier.LOCAL_SLM, ModelTier.EDGE]


# Arbitrary run-resumable state spanning every FSM stage with arbitrary
# markers/diffs/logs, so retention must hold for any representable wrapper.
_diffs = st.builds(Diff, path=st.text(max_size=32), diff=st.text(max_size=64))
_logs = st.builds(
    FailureRecord,
    command=st.text(max_size=32),
    exit_code=st.integers(min_value=-256, max_value=256),
    log=st.text(max_size=128),
)
_wrappers = st.builds(
    StateWrapper,
    stage=st.sampled_from(list(Stage)),
    active_file_markers=st.lists(st.text(max_size=32), max_size=6),
    patch_diffs=st.lists(_diffs, max_size=6),
    compilation_logs=st.lists(_logs, max_size=6),
)


def _raising_loader(tier: ModelTier) -> ModelInterface:
    """A loader that always fails the load by raising (R11.7)."""
    raise RuntimeError(f"load failed for tier {tier.value}")


def _ok_loader(tier: ModelTier) -> ModelInterface:
    """A loader that returns a model; pair with an overrunning clock to fail the load."""
    return LocalSLM()


class _FakeClock:
    """A clock returning queued values on successive calls (start, then end)."""

    def __init__(self, *values: float) -> None:
        self._values = list(values)

    def __call__(self) -> float:
        return self._values.pop(0)


@given(
    state=_wrappers,
    active_tier=st.sampled_from(_NON_CLOUD_TIERS),
    failure_mode=st.sampled_from(["raise", "overrun"]),
)
@settings(max_examples=200)
def test_failed_load_retains_wrapper_and_pauses_with_error(
    state: StateWrapper, active_tier: ModelTier, failure_mode: str
) -> None:
    """Property 44 (R11.7): failed load retains wrapper, pauses, emits naming error.

    Feature: zocai-ecosystem-rebuild, Property 44

    **Validates: Requirements 11.7**
    """
    emitted: list[AgentEvent] = []

    if failure_mode == "raise":
        # The loader raises -> failed load regardless of timing.
        loader = _raising_loader
        clock = _FakeClock(0.0, 0.0)
    else:
        # The loader returns, but the measured duration overruns the 30 s
        # deadline -> failed load.
        loader = _ok_loader
        clock = _FakeClock(0.0, HOT_SWAP_DEADLINE_SECONDS + 1.0)

    with tempfile.TemporaryDirectory() as tmp:
        store = StateWrapperStore(Path(tmp) / "cross_model_bus" / "state_wrapper.json")
        coord = HotSwapCoordinator(
            store=store,
            allocator=ModelAllocator(),
            loader=loader,
            emit=emitted.append,
            clock=clock,
        )

        result = coord.trigger(state, active_tier)

        # The non-Cloud trigger attempted a load to the next higher tier.
        target = next_higher_tier(active_tier)
        assert target is not None

        # R11.7: the load failed -> LOAD_FAILED, the run stays paused, and the
        # active tier is unchanged (no upshift happened).
        assert result.kind is HotSwapOutcomeKind.LOAD_FAILED
        assert result.paused is True
        assert result.active_tier is active_tier
        assert result.new_tier is None
        assert result.failed_tier is target

        # R11.7: the wrapper is RETAINED, never deleted. The store still holds
        # the saved document and reading it back yields the saved state.
        assert store.exists()
        assert store.load() == state
        # The result also surfaces the retained wrapper.
        assert result.state == state

        # R11.7: an error event was emitted naming the failed load tier.
        assert result.error_event is not None
        assert result.error_event in emitted
        # The failed tier's value appears in the event so the Developer sees
        # which load failed.
        assert target.value in result.error_event.command
        assert result.error_event.error_tag is not None
        assert target.value in result.error_event.error_tag
