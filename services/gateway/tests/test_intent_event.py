"""Unit tests for recording tier/window/fallback on the first event (task 3.5).

These example-based tests pin the behavior task 3.5 owns: an ``Allocation`` is
mapped onto the run's first ``IntentEvent`` so ``modelTier``,
``contextWindowTokens``, and (when the R1.6 fallback fired) ``fallbackReason``
are carried as structured fields (R1.9, R1.6), and the allocator-aware stage
factory makes that ``IntentEvent`` the FSM's first emitted event while later
stages keep their default shape.

The exhaustive "first emitted event records tier and window" property
(Property 5) lives in its dedicated property-test task (3.10).
"""

from __future__ import annotations

from shared_schema.agent_events import AgentEventModel, IntentEvent, ThinkingEvent

from zocai_gateway.fsm import FSM
from zocai_gateway.intent_event import (
    DEFAULT_INTENT_TEXT,
    allocation_stage_event_factory,
    build_intent_event,
)
from zocai_gateway.model_allocator import FALLBACK_REASON_UNAVAILABLE, Allocation
from zocai_gateway.model_interface import ModelTier
from zocai_gateway.stages import Stage


def test_build_intent_event_records_tier_and_window() -> None:
    alloc = Allocation(tier=ModelTier.EDGE, context_window=128_000, fallback_reason=None)

    event = build_intent_event(alloc, seq=0, run_id="run-1", ts="2024-01-01T00:00:00+00:00")

    assert isinstance(event, IntentEvent)
    assert event.type == "intent"
    assert event.model_tier == "edge"
    assert event.context_window_tokens == 128_000
    assert event.fallback_reason is None
    assert event.text == DEFAULT_INTENT_TEXT


def test_build_intent_event_carries_fallback_reason() -> None:
    alloc = Allocation(
        tier=ModelTier.LOCAL_SLM,
        context_window=4_000,
        fallback_reason=FALLBACK_REASON_UNAVAILABLE,
    )

    event = build_intent_event(alloc, seq=0, run_id="run-2", ts="2024-01-01T00:00:00+00:00")

    assert event.model_tier == "local-slm"
    assert event.context_window_tokens == 4_000
    assert event.fallback_reason == FALLBACK_REASON_UNAVAILABLE


def test_each_tier_maps_to_its_contract_literal() -> None:
    cases = {
        ModelTier.LOCAL_SLM: "local-slm",
        ModelTier.EDGE: "edge",
        ModelTier.CLOUD: "cloud",
    }
    for tier, literal in cases.items():
        event = build_intent_event(
            Allocation(tier=tier, context_window=2_000, fallback_reason=None),
            seq=0,
            run_id="run",
            ts="2024-01-01T00:00:00+00:00",
        )
        assert event.model_tier == literal


def test_intent_event_validates_against_contract() -> None:
    alloc = Allocation(tier=ModelTier.CLOUD, context_window=1_000_000, fallback_reason=None)

    event = build_intent_event(alloc, seq=0, run_id="run-3", ts="2024-01-01T00:00:00+00:00")

    # The first event must conform to the shared Event_Contract emit gate (R6.2).
    AgentEventModel.model_validate(event.model_dump(by_alias=True))


def test_factory_makes_intent_the_first_emitted_event() -> None:
    alloc = Allocation(tier=ModelTier.EDGE, context_window=128_000, fallback_reason=None)
    factory = allocation_stage_event_factory(alloc)

    fsm = FSM(initial=Stage.INTAKE, run_id="run-4", stage_event_factory=factory)

    # The run's first emitted event carries the allocation (R1.9).
    first = fsm.events[0]
    assert isinstance(first, IntentEvent)
    assert first.model_tier == "edge"
    assert first.context_window_tokens == 128_000
    assert first.seq == 0


def test_factory_delegates_later_stages_to_default() -> None:
    alloc = Allocation(tier=ModelTier.LOCAL_SLM, context_window=4_000, fallback_reason=None)
    factory = allocation_stage_event_factory(alloc)

    fsm = FSM(initial=Stage.INTAKE, run_id="run-5", stage_event_factory=factory)
    fsm.advance()  # INTAKE -> ANALYZE

    assert isinstance(fsm.events[0], IntentEvent)
    assert isinstance(fsm.events[1], ThinkingEvent)
    assert fsm.events[1].text == Stage.ANALYZE.value


def test_factory_intake_detail_overrides_intent_text() -> None:
    alloc = Allocation(tier=ModelTier.CLOUD, context_window=1_000_000, fallback_reason=None)
    factory = allocation_stage_event_factory(alloc)

    event = factory(Stage.INTAKE, 0, "run-6", "2024-01-01T00:00:00+00:00", "summarize repo")

    assert isinstance(event, IntentEvent)
    assert event.text == "summarize repo"
