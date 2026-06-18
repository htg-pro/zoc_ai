"""Property test for the fallback init/allocation guard (task 3.9).

Feature: zocai-ecosystem-rebuild, Property 4: Local SLM fallback
initialization or allocation failure prevents an invalid run.

**Validates: Requirements 1.10**

Design Property 4 (verbatim intent): *For any* fallback attempt where bringing
up the Local SLM tier fails — either because the tier cannot be **initialized**
(:class:`TierInitError`) or because its context window cannot be **allocated**
(:class:`ContextAllocationError`) — the :class:`ModelAllocator` must:

* raise :class:`AllocationAborted` (the run does not proceed),
* emit exactly one structured :class:`AllocationError` whose ``kind`` matches
  the failure category (``INITIALIZATION`` vs ``ALLOCATION``), and
* never return an :class:`Allocation` (no invalid / out-of-bounds window
  escapes the guard).

Strategy
--------
We drive the real :class:`ModelAllocator` through both entry points to the
guarded fallback — the direct :meth:`fallback_to_local_slm` call and the
``select`` path with a missing hardware/latency signal (the R1.6 trigger) —
injecting a ``bring_up`` that raises one of the two failure kinds. A drawn
``message`` exercises both the default and a custom error message. We capture
emitted errors through both the injected ``error_sink`` and the allocator's own
``allocation_errors`` ledger.
"""

from __future__ import annotations

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from zocai_gateway.hardware_probe import HardwareProfile
from zocai_gateway.model_allocator import (
    Allocation,
    AllocationAborted,
    AllocationError,
    AllocationErrorKind,
    ContextAllocationError,
    ModelAllocator,
    TierInitError,
)
from zocai_gateway.model_allocator import TierBringUp
from zocai_gateway.model_interface import ModelInterface, ModelTier

# Maps the injected failure to the exception it raises and the error ``kind``
# the guard must report (R1.10).
_FAILURE_CASES: dict[str, tuple[type[Exception], AllocationErrorKind]] = {
    "init": (TierInitError, AllocationErrorKind.INITIALIZATION),
    "alloc": (ContextAllocationError, AllocationErrorKind.ALLOCATION),
}


def _failing_bring_up(exc_type: type[Exception], message: str) -> TierBringUp:
    """A ``bring_up`` step that always fails bringing up the requested tier."""

    def bring_up(tier: ModelTier) -> ModelInterface:  # noqa: ARG001 - signature contract
        if message:
            raise exc_type(ModelTier.LOCAL_SLM, message)
        raise exc_type(ModelTier.LOCAL_SLM)

    return bring_up


@st.composite
def _guard_inputs(draw: st.DrawFn) -> tuple[str, str, bool]:
    """Draw (failure_case, message, via_select).

    * ``failure_case`` — which bring-up failure to inject (init vs allocation).
    * ``message`` — empty (default message) or a custom error string.
    * ``via_select`` — whether to reach the guard through ``select`` (R1.6
      trigger) or call ``fallback_to_local_slm`` directly.
    """
    failure_case = draw(st.sampled_from(sorted(_FAILURE_CASES)))
    message = draw(
        st.one_of(
            st.just(""),
            st.text(min_size=1, max_size=64),
        )
    )
    via_select = draw(st.booleans())
    return failure_case, message, via_select


@settings(max_examples=200, deadline=None)
@given(_guard_inputs())
def test_fallback_failure_aborts_run_and_emits_matching_error(
    inputs: tuple[str, str, bool],
) -> None:
    """Property 4 / R1.10.

    Feature: zocai-ecosystem-rebuild, Property 4

    **Validates: Requirements 1.10**
    """
    failure_case, message, via_select = inputs
    exc_type, expected_kind = _FAILURE_CASES[failure_case]

    # Collect errors through an explicit sink as well as the ledger.
    sunk: list[AllocationError] = []
    allocator = ModelAllocator(
        bring_up=_failing_bring_up(exc_type, message),
        error_sink=sunk.append,
    )

    result: Allocation | None = None
    with pytest.raises(AllocationAborted) as caught:
        if via_select:
            # R1.6 trigger: a missing signal routes into the guarded fallback.
            result = allocator.select(
                complexity=0.9,
                latency_ms=None,
                hw=HardwareProfile(gpu_memory_gb=None, system_memory_gb=None),
            )
        else:
            result = allocator.fallback_to_local_slm()

    # No invalid allocation ever escapes the guard.
    assert result is None

    # The abort carries the matching failure category and the Local SLM tier.
    assert caught.value.kind is expected_kind
    assert caught.value.tier is ModelTier.LOCAL_SLM

    # Exactly one structured error indication was emitted, identifying the
    # init-vs-allocation failure on the Local SLM tier (R1.10).
    assert len(allocator.allocation_errors) == 1
    emitted = allocator.allocation_errors[0]
    assert emitted.kind is expected_kind
    assert emitted.tier is ModelTier.LOCAL_SLM
    assert emitted.message  # a non-empty diagnostic message

    # The injected sink observed the very same error indication.
    assert sunk == allocator.allocation_errors
