"""Property test for hot-swap upshift vs. Cloud-continue (task 11.3).

Feature: zocai-ecosystem-rebuild, Property 43: Upshift moves to the next higher
tier; Cloud continues running.

**Validates: Requirements 11.2, 11.6**

Design Property 43 (verbatim intent): *For any* hot-swap trigger, when the
active tier is below Cloud the loaded tier is the next higher tier, and when the
active tier is already Cloud the run continues running on the Cloud tier without
upshifting, pausing, or deferring to the developer.

Strategy
--------
We drive :meth:`HotSwapCoordinator.trigger` over the cross product of:

* an *arbitrary* active :class:`ModelTier` (Local SLM, Edge, or Cloud); and
* an *arbitrary* :class:`StateWrapper` (any FSM stage, any mix of active-file
  markers, patch diffs, and compilation logs).

The loader always succeeds in-time (a constant clock keeps the measured load
duration at zero, well under the 30 s deadline), so the only thing that varies
the outcome is the active tier. We then assert the strict ladder:

* ``LOCAL_SLM`` upshifts to ``EDGE`` and ``EDGE`` upshifts to ``CLOUD`` — the
  *next higher* tier — and the run resumes (``UPSHIFTED``, not paused) (R11.2);
* ``CLOUD`` (the highest tier) continues running on Cloud
  (``CONTINUED_ON_CLOUD``) without upshifting, pausing, or deferring (R11.6).
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from hypothesis import given, settings
from hypothesis import strategies as st

from zocai_gateway.hot_swap import (
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

# The strict tier ladder under test: below-Cloud tiers upshift, Cloud continues.
_TIERS = list(ModelTier)
_STAGES = list(Stage)


@st.composite
def _state_wrappers(draw: st.DrawFn) -> StateWrapper:
    """An arbitrary run-resumable :class:`StateWrapper`."""
    stage = draw(st.sampled_from(_STAGES))
    markers = draw(st.lists(st.text(max_size=32), max_size=5))
    diffs = draw(
        st.lists(
            st.builds(Diff, path=st.text(max_size=24), diff=st.text(max_size=48)),
            max_size=4,
        )
    )
    logs = draw(
        st.lists(
            st.builds(
                FailureRecord,
                command=st.text(max_size=24),
                exit_code=st.integers(min_value=-8, max_value=255),
                log=st.text(max_size=64),
            ),
            max_size=3,
        )
    )
    return StateWrapper(
        stage=stage,
        active_file_markers=markers,
        patch_diffs=diffs,
        compilation_logs=logs,
    )


def _ok_loader(tier: ModelTier) -> ModelInterface:
    """A loader that always succeeds; the coordinator does not bind the model to a tier."""
    return LocalSLM()


def _constant_clock() -> float:
    """A clock pinned at zero, so the measured load duration never overruns the deadline."""
    return 0.0


@given(active_tier=st.sampled_from(_TIERS), state=_state_wrappers())
@settings(max_examples=200)
def test_upshift_to_next_tier_or_continue_on_cloud(
    active_tier: ModelTier, state: StateWrapper
) -> None:
    """Property 43 (R11.2, R11.6): below-Cloud upshifts one tier; Cloud continues.

    Feature: zocai-ecosystem-rebuild, Property 43

    **Validates: Requirements 11.2, 11.6**
    """
    with tempfile.TemporaryDirectory() as tmp:
        store = StateWrapperStore(Path(tmp) / "cross_model_bus" / "state_wrapper.json")
        coord = HotSwapCoordinator(
            store=store,
            allocator=ModelAllocator(),
            loader=_ok_loader,
            clock=_constant_clock,
        )

        result = coord.trigger(state, active_tier)

        if active_tier is ModelTier.CLOUD:
            # R11.6: the highest tier keeps running on Cloud — no upshift, no
            # pause, no defer to the Developer.
            assert result.kind is HotSwapOutcomeKind.CONTINUED_ON_CLOUD
            assert result.active_tier is ModelTier.CLOUD
            assert result.paused is False
            assert result.new_tier is None
            assert next_higher_tier(active_tier) is None
        else:
            # R11.2: a below-Cloud tier upshifts to the NEXT higher tier and
            # resumes (not paused).
            expected = next_higher_tier(active_tier)
            assert expected is not None
            assert result.kind is HotSwapOutcomeKind.UPSHIFTED
            assert result.new_tier is expected
            assert result.active_tier is expected
            assert result.paused is False
            # The strict ladder: LOCAL_SLM -> EDGE, EDGE -> CLOUD.
            if active_tier is ModelTier.LOCAL_SLM:
                assert expected is ModelTier.EDGE
            else:
                assert active_tier is ModelTier.EDGE
                assert expected is ModelTier.CLOUD
