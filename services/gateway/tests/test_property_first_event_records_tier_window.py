"""Property test for the run's first event recording tier and window (task 3.10).

Feature: zocai-ecosystem-rebuild, Property 5: First emitted event records tier
and window.

**Validates: Requirements 1.9, 1.6**

Design Property 5 (verbatim intent): *For any* run, the first emitted event
carries the selected Model_Tier identifier and the allocated context window
size in tokens (and the fallback reason when one applies).

Strategy
--------
We drive the real seam this property owns — :func:`allocation_stage_event_factory`
adapting an :class:`Allocation` into the Agent-Mode :class:`FSM`'s stage-event
factory — across the full :class:`Allocation` input space:

* ``tier`` — any of the three :class:`ModelTier` members (``local-slm`` / ``edge``
  / ``cloud``),
* ``context_window`` — any positive token count (the allocated window size),
* ``fallback_reason`` — ``None`` for a normally scored selection, or a
  non-empty structured string when the R1.6 fallback fired.

The FSM starts at ``INTAKE`` (the run's first stage, R3.1) so its **first
emitted event** (``events[0]``) is produced by the allocator-aware factory. For
every drawn allocation we assert that first event is an ``IntentEvent`` whose
``model_tier`` / ``context_window_tokens`` mirror the allocation exactly, and
whose ``fallback_reason`` matches the allocation's (carried when present, R1.6).
"""

from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st

from shared_schema.agent_events import IntentEvent
from zocai_gateway.fsm import FSM
from zocai_gateway.intent_event import allocation_stage_event_factory
from zocai_gateway.model_allocator import Allocation
from zocai_gateway.model_interface import ModelTier
from zocai_gateway.stages import Stage

# The tier-enum -> contract-literal mapping the IntentEvent must record (R1.9).
# Kept independent of the implementation map so the property pins the contract.
_TIER_LITERAL: dict[ModelTier, str] = {
    ModelTier.LOCAL_SLM: "local-slm",
    ModelTier.EDGE: "edge",
    ModelTier.CLOUD: "cloud",
}


@st.composite
def _allocations(draw: st.DrawFn) -> Allocation:
    """An arbitrary allocation: any tier, positive window, optional reason.

    ``fallback_reason`` is ``None`` (normal selection) or a non-empty string
    (the R1.6 fallback fired), so the property exercises both the present and
    absent branches of the recorded reason.
    """
    tier = draw(st.sampled_from(list(ModelTier)))
    context_window = draw(st.integers(min_value=1, max_value=2_000_000))
    fallback_reason = draw(
        st.one_of(
            st.none(),
            st.text(min_size=1, max_size=64).filter(lambda s: s.strip() != ""),
        )
    )
    return Allocation(
        tier=tier,
        context_window=context_window,
        fallback_reason=fallback_reason,
    )


@settings(max_examples=200)
@given(allocation=_allocations())
def test_first_emitted_event_records_tier_and_window(allocation: Allocation) -> None:
    """Property 5: the FSM's first emitted event records the allocation.

    Feature: zocai-ecosystem-rebuild, Property 5

    **Validates: Requirements 1.9, 1.6**
    """
    factory = allocation_stage_event_factory(allocation)
    fsm = FSM(initial=Stage.INTAKE, run_id="run", stage_event_factory=factory)

    # The run's first emitted event is the allocator-aware intent event.
    first = fsm.events[0]
    assert isinstance(first, IntentEvent)
    assert first.seq == 0

    # It records the selected tier identifier and allocated window (R1.9)...
    assert first.model_tier == _TIER_LITERAL[allocation.tier]
    assert first.context_window_tokens == allocation.context_window

    # ...and carries the fallback reason exactly when one applies (R1.6).
    assert first.fallback_reason == allocation.fallback_reason
