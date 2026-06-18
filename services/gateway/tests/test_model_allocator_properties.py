"""Property-based tests for the ``Model_Allocator`` window sizing (R1.3–R1.5).

Property 2: *Allocated context window is within the selected tier's bounds.*

Across the full input space (any complexity, any latency — including the
unmeasured ``None`` case — and any hardware profile, including a fully absent
one), whatever tier the allocator selects, the allocated context window must
fall inside that tier's required bounds:

* Local SLM in ``[2_000, 4_000]``   (R1.3)
* Edge in ``[8_000, 128_000]``      (R1.4)
* Cloud at ``>= 1_000_000``         (R1.5)

The dedicated single-valid-tier property (Property 1) lives in task 3.6; this
file covers only Property 2.

Feature: zocai-ecosystem-rebuild, Property 2: Allocated context window is
within the selected tier's bounds.
"""

from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st

from zocai_gateway.hardware_probe import HardwareProfile
from zocai_gateway.model_allocator import Allocation, ModelAllocator
from zocai_gateway.model_interface import ModelTier

# Per-tier window bounds in tokens (R1.3–R1.5). ``None`` upper bound means the
# tier only has a lower bound ("at least").
_TIER_BOUNDS: dict[ModelTier, tuple[int, int | None]] = {
    ModelTier.LOCAL_SLM: (2_000, 4_000),
    ModelTier.EDGE: (8_000, 128_000),
    ModelTier.CLOUD: (1_000_000, None),
}


def _assert_window_in_bounds(alloc: Allocation) -> None:
    """Assert the allocation's window sits within its tier's bounds."""
    assert alloc.tier in _TIER_BOUNDS
    low, high = _TIER_BOUNDS[alloc.tier]
    assert alloc.context_window >= low
    if high is not None:
        assert alloc.context_window <= high


# A memory reading: either undetected (``None``) or a non-negative gigabyte
# figure spanning thin handhelds through fat servers.
_memory_gb = st.one_of(
    st.none(),
    st.floats(min_value=0.0, max_value=2_048.0, allow_nan=False, allow_infinity=False),
)

# A hardware profile, or a fully absent profile (``None``) that forces the R1.6
# Local SLM fallback.
_hardware = st.one_of(
    st.none(),
    st.builds(HardwareProfile, gpu_memory_gb=_memory_gb, system_memory_gb=_memory_gb),
)

# Latency in ms: unmeasured (``None`` -> R1.6 fallback), or any reading
# including spurious negatives (the allocator clamps at zero) and very large
# round-trips that pull selection down to Local SLM.
_latency_ms = st.one_of(
    st.none(),
    st.floats(min_value=-50.0, max_value=60_000.0, allow_nan=False, allow_infinity=False),
)

# Task complexity normalized to [0.0, 1.0].
_complexity = st.floats(min_value=0.0, max_value=1.0, allow_nan=False, allow_infinity=False)


@settings(max_examples=200, deadline=None)
@given(complexity=_complexity, latency_ms=_latency_ms, hw=_hardware)
def test_allocated_window_within_selected_tier_bounds(
    complexity: float,
    latency_ms: float | None,
    hw: HardwareProfile | None,
) -> None:
    """Property 2: the allocated window is within the selected tier's bounds.

    *For any* combination of complexity, latency (measured or ``None``), and
    hardware profile (present or absent), the allocator selects some tier and
    sizes its context window strictly inside that tier's required range
    (R1.3–R1.5). The default bring-up always succeeds, so the guarded R1.6
    fallback returns a valid Local SLM allocation rather than aborting.

    **Validates: Requirements 1.3, 1.4, 1.5**
    """
    alloc = ModelAllocator().select(complexity=complexity, latency_ms=latency_ms, hw=hw)
    _assert_window_in_bounds(alloc)


@settings(max_examples=100, deadline=None)
@given(complexity=_complexity, latency_ms=_latency_ms, hw=_hardware)
def test_window_matches_window_for_helper(
    complexity: float,
    latency_ms: float | None,
    hw: HardwareProfile | None,
) -> None:
    """The selected allocation's window equals the allocator's per-tier sizing.

    Reinforces Property 2 by checking the window the allocator returns for a
    selection is exactly the bounded size it assigns that tier via
    ``window_for`` — the same sizing the hot-swap relies on (R1.3–R1.5).

    **Validates: Requirements 1.3, 1.4, 1.5**
    """
    allocator = ModelAllocator()
    alloc = allocator.select(complexity=complexity, latency_ms=latency_ms, hw=hw)
    assert alloc.context_window == allocator.window_for(alloc.tier)
    _assert_window_in_bounds(alloc)
