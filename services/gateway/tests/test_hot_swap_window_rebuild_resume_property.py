"""Property test for hot-swap window rebuild and stage resume (task 11.2).

Feature: zocai-ecosystem-rebuild, Property 42: Hot-swap rebuilds the window to
the new tier and resumes from the recorded stage.

**Validates: Requirements 11.3, 11.4**

Design Property 42 (verbatim intent): *For any* hot-swap to a replacement
tier, the rebuilt prompt window size equals the allocator's context window for
that tier, and the FSM resumes from the stage recorded in the State_Wrapper.

Strategy
--------
We generate an *arbitrary* :class:`StateWrapper` — any FSM stage, any mix of
active-file markers, patch diffs, and captured compilation logs — paired with
an *arbitrary non-Cloud* active tier (Local SLM or Edge), the two tiers that
have a higher tier to upshift into (R11.2). The coordinator is wired with a
loader that always succeeds and a clock whose measured load duration sits well
inside :data:`HOT_SWAP_DEADLINE_SECONDS`, so every example takes the successful
upshift path.

For each example we assert the three Property-42 facts on the result:

* the rebuilt prompt window size equals ``allocator.window_for(new_tier)``
  (R11.3);
* the resumed FSM's ``current`` stage equals the stage recorded in the wrapper
  (R11.4);
* the preserved markers, diffs, and compilation logs equal the stored values
  (read back from the Tier 2 bus), confirming the rebuild seeds from the
  recorded state.

A fresh temporary store per example keeps each generated run isolated.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from hypothesis import given, settings
from hypothesis import strategies as st

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
from zocai_gateway.model_interface import Cloud, Edge, LocalSLM, ModelInterface, ModelTier
from zocai_gateway.stages import Stage

# The non-Cloud tiers: each has a strictly higher tier to upshift into (R11.2),
# so a triggered swap from one of them takes the successful upshift path.
_NON_CLOUD_TIERS = [ModelTier.LOCAL_SLM, ModelTier.EDGE]

# Construct the live stub model for whatever replacement tier is loaded.
_TIER_STUB = {
    ModelTier.LOCAL_SLM: LocalSLM,
    ModelTier.EDGE: Edge,
    ModelTier.CLOUD: Cloud,
}


def _loader(tier: ModelTier) -> ModelInterface:
    """An always-succeeding loader returning the replacement tier's stub (R11.2)."""
    return _TIER_STUB[tier]()


# Arbitrary run-resumable state. Stage spans every FSM stage so the resume must
# honor whichever stage was frozen; markers/diffs/logs are arbitrary so the
# rebuild must carry them through unchanged.
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


@given(
    state=_wrappers,
    active_tier=st.sampled_from(_NON_CLOUD_TIERS),
)
@settings(max_examples=200)
def test_hot_swap_rebuilds_window_and_resumes_stage(
    state: StateWrapper, active_tier: ModelTier
) -> None:
    """Property 42 (R11.3, R11.4): window sized to new tier, FSM resumes at stage.

    Feature: zocai-ecosystem-rebuild, Property 42

    **Validates: Requirements 11.3, 11.4**
    """
    allocator = ModelAllocator()
    with tempfile.TemporaryDirectory() as tmp:
        store = StateWrapperStore(Path(tmp) / "cross_model_bus" / "state_wrapper.json")
        coord = HotSwapCoordinator(
            store=store,
            allocator=allocator,
            loader=_loader,
            # A load measured well inside the deadline -> successful upshift.
            clock=_FakeClock(0.0, HOT_SWAP_DEADLINE_SECONDS / 2.0),
        )

        result = coord.trigger(state, active_tier)

        # The non-Cloud trigger took the upshift path to the next higher tier.
        new_tier = next_higher_tier(active_tier)
        assert new_tier is not None
        assert result.kind is HotSwapOutcomeKind.UPSHIFTED
        assert result.new_tier is new_tier

        # R11.3: the rebuilt window size equals the allocator's window for the
        # new tier.
        assert result.prompt_window is not None
        assert result.prompt_window.size == allocator.window_for(new_tier)

        # R11.4: a fresh FSM resumes from the stage recorded in the wrapper.
        assert result.fsm is not None
        assert result.fsm.current is state.stage

        # The rebuild seeded from the recorded state read back off the bus: the
        # preserved markers, diffs, and logs equal the stored values.
        assert result.prompt_window.stage == state.stage
        assert result.prompt_window.active_file_markers == state.active_file_markers
        assert result.prompt_window.patch_diffs == state.patch_diffs
        assert result.prompt_window.compilation_logs == state.compilation_logs


class _FakeClock:
    """A clock returning queued values on successive calls (start, then end)."""

    def __init__(self, *values: float) -> None:
        self._values = list(values)

    def __call__(self) -> float:
        return self._values.pop(0)
