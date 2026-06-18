"""Unit tests for the ``Model_Allocator`` (task 3.4, R1.2–R1.6, R1.10).

Example-based coverage of tier selection, window sizing, the R1.6 Local SLM
fallback with a structured reason, and the R1.10 fallback guard that aborts
the run (identifying init vs allocation failure) rather than returning an
invalid context window. The exhaustive cross-input properties live in the
dedicated property tests (tasks 3.6–3.9).
"""

from __future__ import annotations

import pytest

from zocai_gateway.hardware_probe import HardwareProfile
from zocai_gateway.model_allocator import (
    FALLBACK_REASON_UNAVAILABLE,
    Allocation,
    AllocationAborted,
    AllocationError,
    AllocationErrorKind,
    ContextAllocationError,
    ModelAllocator,
    TierInitError,
)
from zocai_gateway.model_interface import ModelInterface, ModelTier

# Per-tier window bounds (R1.3–R1.5); None upper bound means "at least".
_TIER_BOUNDS: dict[ModelTier, tuple[int, int | None]] = {
    ModelTier.LOCAL_SLM: (2_000, 4_000),
    ModelTier.EDGE: (8_000, 128_000),
    ModelTier.CLOUD: (1_000_000, None),
}

_AMPLE_HW = HardwareProfile(gpu_memory_gb=24.0, system_memory_gb=64.0)
_THIN_HW = HardwareProfile(gpu_memory_gb=None, system_memory_gb=4.0)


def _assert_window_in_bounds(alloc: Allocation) -> None:
    low, high = _TIER_BOUNDS[alloc.tier]
    assert alloc.context_window >= low
    if high is not None:
        assert alloc.context_window <= high


# --- tier selection + window sizing (R1.2–R1.5) ---------------------------


def test_high_complexity_low_latency_selects_cloud() -> None:
    alloc = ModelAllocator().select(complexity=0.95, latency_ms=20.0, hw=_AMPLE_HW)
    assert alloc.tier is ModelTier.CLOUD
    assert alloc.context_window >= 1_000_000
    assert alloc.fallback_reason is None
    _assert_window_in_bounds(alloc)


def test_mid_complexity_ample_memory_selects_edge() -> None:
    alloc = ModelAllocator().select(complexity=0.5, latency_ms=50.0, hw=_AMPLE_HW)
    assert alloc.tier is ModelTier.EDGE
    _assert_window_in_bounds(alloc)


def test_low_complexity_selects_local_slm() -> None:
    alloc = ModelAllocator().select(complexity=0.05, latency_ms=10.0, hw=_AMPLE_HW)
    assert alloc.tier is ModelTier.LOCAL_SLM
    _assert_window_in_bounds(alloc)


def test_high_latency_pulls_down_to_local_slm() -> None:
    # Even high complexity with ample memory stays local when unreachable.
    alloc = ModelAllocator().select(complexity=0.95, latency_ms=5_000.0, hw=_AMPLE_HW)
    assert alloc.tier is ModelTier.LOCAL_SLM
    _assert_window_in_bounds(alloc)


def test_thin_memory_blocks_edge() -> None:
    # Mid complexity but insufficient memory -> Local SLM, not Edge.
    alloc = ModelAllocator().select(complexity=0.5, latency_ms=20.0, hw=_THIN_HW)
    assert alloc.tier is ModelTier.LOCAL_SLM
    _assert_window_in_bounds(alloc)


def test_selection_always_yields_a_valid_tier_and_window() -> None:
    alloc = ModelAllocator().select(complexity=0.5, latency_ms=100.0, hw=_AMPLE_HW)
    assert alloc.tier in set(ModelTier)
    _assert_window_in_bounds(alloc)


# --- R1.6 fallback --------------------------------------------------------


def test_missing_hardware_forces_local_slm_fallback() -> None:
    alloc = ModelAllocator().select(complexity=0.95, latency_ms=20.0, hw=None)
    assert alloc.tier is ModelTier.LOCAL_SLM
    assert alloc.fallback_reason == FALLBACK_REASON_UNAVAILABLE
    _assert_window_in_bounds(alloc)


def test_missing_latency_forces_local_slm_fallback() -> None:
    alloc = ModelAllocator().select(complexity=0.95, latency_ms=None, hw=_AMPLE_HW)
    assert alloc.tier is ModelTier.LOCAL_SLM
    assert alloc.fallback_reason == FALLBACK_REASON_UNAVAILABLE
    _assert_window_in_bounds(alloc)


def test_explicit_fallback_returns_operational_local_allocation() -> None:
    alloc = ModelAllocator().fallback_to_local_slm()
    assert alloc.tier is ModelTier.LOCAL_SLM
    assert alloc.fallback_reason == FALLBACK_REASON_UNAVAILABLE
    _assert_window_in_bounds(alloc)


# --- R1.10 fallback guard -------------------------------------------------


def test_init_failure_aborts_run_and_emits_init_error() -> None:
    errors: list[AllocationError] = []

    def failing_bring_up(tier: ModelTier) -> ModelInterface:
        raise TierInitError(tier, "device unavailable")

    allocator = ModelAllocator(bring_up=failing_bring_up, error_sink=errors.append)

    with pytest.raises(AllocationAborted) as excinfo:
        allocator.select(complexity=0.95, latency_ms=None, hw=None)

    assert excinfo.value.kind is AllocationErrorKind.INITIALIZATION
    assert len(errors) == 1
    assert errors[0].kind is AllocationErrorKind.INITIALIZATION
    assert errors[0].tier is ModelTier.LOCAL_SLM
    # The error indication is also retained on the allocator.
    assert allocator.allocation_errors == errors


def test_context_allocation_failure_aborts_run_and_emits_allocation_error() -> None:
    errors: list[AllocationError] = []

    def failing_bring_up(tier: ModelTier) -> ModelInterface:
        raise ContextAllocationError(tier, "no free context")

    allocator = ModelAllocator(bring_up=failing_bring_up, error_sink=errors.append)

    with pytest.raises(AllocationAborted) as excinfo:
        allocator.fallback_to_local_slm()

    assert excinfo.value.kind is AllocationErrorKind.ALLOCATION
    assert len(errors) == 1
    assert errors[0].kind is AllocationErrorKind.ALLOCATION


def test_guard_distinguishes_init_from_allocation_failure() -> None:
    init_allocator = ModelAllocator(
        bring_up=lambda tier: (_ for _ in ()).throw(TierInitError(tier))
    )
    alloc_allocator = ModelAllocator(
        bring_up=lambda tier: (_ for _ in ()).throw(ContextAllocationError(tier))
    )

    with pytest.raises(AllocationAborted) as init_exc:
        init_allocator.fallback_to_local_slm()
    with pytest.raises(AllocationAborted) as alloc_exc:
        alloc_allocator.fallback_to_local_slm()

    assert init_exc.value.kind is AllocationErrorKind.INITIALIZATION
    assert alloc_exc.value.kind is AllocationErrorKind.ALLOCATION


def test_successful_bring_up_does_not_emit_errors() -> None:
    allocator = ModelAllocator()
    alloc = allocator.fallback_to_local_slm()
    assert alloc.tier is ModelTier.LOCAL_SLM
    assert allocator.allocation_errors == []
