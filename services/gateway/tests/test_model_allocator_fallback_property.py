"""Property test for the operational Local SLM fallback (task 3.8).

Property 3: Missing hardware or latency forces an operational Local SLM
fallback.

*For any* input where the hardware profile is absent (``hw is None``) or the
latency value is absent (``latency_ms is None``), the :class:`ModelAllocator`
selects the Local SLM tier, sets a non-null structured ``fallback_reason``
(``FALLBACK_REASON_UNAVAILABLE``), and remains operational by returning a
context window inside the Local SLM bounds (R1.3: ``[2_000, 4_000]`` tokens)
rather than raising.

Tag: Feature: zocai-ecosystem-rebuild, Property 3
Validates: Requirements 1.6
"""

from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st

from zocai_gateway.hardware_probe import HardwareProfile
from zocai_gateway.model_allocator import (
    FALLBACK_REASON_UNAVAILABLE,
    ModelAllocator,
)
from zocai_gateway.model_interface import ModelTier

# Local SLM context-window bounds in tokens (R1.3). An "operational" fallback
# must land inside these bounds.
_LOCAL_SLM_MIN_TOKENS = 2_000
_LOCAL_SLM_MAX_TOKENS = 4_000


def _memory_readings() -> st.SearchStrategy[float | None]:
    """A per-resource memory reading: undetectable (``None``) or positive GB."""
    return st.one_of(
        st.none(),
        st.floats(
            min_value=0.0,
            max_value=2_048.0,
            allow_nan=False,
            allow_infinity=False,
        ),
    )


def _hardware_profiles() -> st.SearchStrategy[HardwareProfile]:
    """Present hardware profiles spanning thin to ample GPU/system memory."""
    return st.builds(
        HardwareProfile,
        gpu_memory_gb=_memory_readings(),
        system_memory_gb=_memory_readings(),
    )


def _latencies() -> st.SearchStrategy[float]:
    """Present latency readings spanning fast to unreachable round-trips."""
    return st.floats(
        min_value=0.0,
        max_value=100_000.0,
        allow_nan=False,
        allow_infinity=False,
    )


@st.composite
def _missing_signal_inputs(
    draw: st.DrawFn,
) -> tuple[float, float | None, HardwareProfile | None]:
    """Build (complexity, latency_ms, hw) where hw OR latency is absent.

    Complexity is drawn across (and beyond) the normalized 0.0-1.0 range — it
    is irrelevant on the fallback path, so the property must hold regardless of
    its value. At least one of hardware/latency is forced to ``None`` so the
    R1.6 fallback condition always holds.
    """
    complexity = draw(
        st.floats(min_value=-1.0, max_value=2.0, allow_nan=False, allow_infinity=False)
    )
    hw = draw(st.one_of(st.none(), _hardware_profiles()))
    latency = draw(st.one_of(st.none(), _latencies()))

    # Guarantee the fallback precondition: if both happen to be present, drop
    # one of them so hw OR latency is always absent.
    if hw is not None and latency is not None:
        if draw(st.booleans()):
            hw = None
        else:
            latency = None

    return complexity, latency, hw


@settings(max_examples=200, deadline=None)
@given(_missing_signal_inputs())
def test_missing_hardware_or_latency_forces_operational_local_slm_fallback(
    inputs: tuple[float, float | None, HardwareProfile | None],
) -> None:
    """Property 3 / R1.6.

    Tag: Feature: zocai-ecosystem-rebuild, Property 3
    Validates: Requirements 1.6
    """
    complexity, latency_ms, hw = inputs
    # Precondition under test: hardware or latency is unavailable.
    assert hw is None or latency_ms is None

    alloc = ModelAllocator().select(complexity=complexity, latency_ms=latency_ms, hw=hw)

    # Selects exactly the Local SLM tier (R1.6).
    assert alloc.tier is ModelTier.LOCAL_SLM
    # Records a non-null, structured fallback reason (R1.6).
    assert alloc.fallback_reason is not None
    assert alloc.fallback_reason == FALLBACK_REASON_UNAVAILABLE
    # Remains operational: an in-bounds Local SLM context window (R1.3).
    assert _LOCAL_SLM_MIN_TOKENS <= alloc.context_window <= _LOCAL_SLM_MAX_TOKENS
