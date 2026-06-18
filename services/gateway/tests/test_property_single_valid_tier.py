"""Property test for single valid tier selection (task 3.6).

Feature: zocai-ecosystem-rebuild, Property 1: Allocator always selects exactly
one valid tier.

**Validates: Requirements 1.2**

Design Property 1 (verbatim intent): *For any* task complexity score in
``[0.0, 1.0]``, any non-negative network latency, and any hardware profile
(present or absent), the ``Model_Allocator`` returns exactly one valid
``Model_Tier``.

Strategy
--------
We drive the real :class:`ModelAllocator` (with its default tier bring-up, so
the R1.6 Local SLM fallback is always operational) across the full input
space:

* ``complexity`` — floats constrained to ``[0.0, 1.0]`` (the normalized score),
* ``latency_ms`` — non-negative finite floats **or** ``None`` (an unmeasured
  reading that forces the R1.6 fallback),
* ``hw`` — a :class:`HardwareProfile` with each of GPU / system memory being a
  positive finite float or ``None``, and the whole profile optionally ``None``
  (probing failed entirely).

For every drawn input we assert the allocation names exactly one member of the
:class:`ModelTier` enum — never zero, never an out-of-domain value.
"""

from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st

from zocai_gateway.hardware_probe import HardwareProfile
from zocai_gateway.model_allocator import Allocation, ModelAllocator
from zocai_gateway.model_interface import ModelTier

_VALID_TIERS = frozenset(ModelTier)


# A detectable memory reading: positive, finite. ``None`` models "undetected".
_memory_gb = st.one_of(
    st.none(),
    st.floats(min_value=0.001, max_value=4_096.0, allow_nan=False, allow_infinity=False),
)


@st.composite
def _hardware_profiles(draw: st.DrawFn) -> HardwareProfile | None:
    """A hardware profile that may be absent, empty, or partially populated.

    Returning ``None`` models a fully failed probe (R1.6 trigger); a profile
    with both fields ``None`` models a constructed-but-empty reading.
    """
    if draw(st.booleans()):
        return None
    return HardwareProfile(
        gpu_memory_gb=draw(_memory_gb),
        system_memory_gb=draw(_memory_gb),
    )


# Complexity is the normalized [0.0, 1.0] score.
_complexity = st.floats(min_value=0.0, max_value=1.0, allow_nan=False, allow_infinity=False)

# Non-negative finite latency, or ``None`` when it could not be measured.
_latency_ms = st.one_of(
    st.none(),
    st.floats(min_value=0.0, max_value=600_000.0, allow_nan=False, allow_infinity=False),
)


@settings(max_examples=200)
@given(complexity=_complexity, latency_ms=_latency_ms, hw=_hardware_profiles())
def test_allocator_always_selects_exactly_one_valid_tier(
    complexity: float,
    latency_ms: float | None,
    hw: HardwareProfile | None,
) -> None:
    """Property 1: ``select`` yields exactly one valid ``ModelTier``.

    Feature: zocai-ecosystem-rebuild, Property 1

    **Validates: Requirements 1.2**
    """
    allocation = ModelAllocator().select(complexity=complexity, latency_ms=latency_ms, hw=hw)

    # The result is a single, well-formed allocation...
    assert isinstance(allocation, Allocation)
    # ...naming exactly one member of the tier enum (never zero, never foreign).
    assert isinstance(allocation.tier, ModelTier)
    assert allocation.tier in _VALID_TIERS
