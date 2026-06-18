"""Record the allocator's tier/window/fallback in the run's first event (R1.9, R1.6).

The shared Event_Contract requires that the run's **first emitted event** — the
``IntentEvent`` — carry the tier the :class:`~zocai_gateway.model_allocator.ModelAllocator`
selected, the context-window size it allocated, and, when the R1.6 fallback
fired, the structured fallback reason (design.md "Model Routing", R1.9/R1.6).

This module is the seam that turns a completed
:class:`~zocai_gateway.model_allocator.Allocation` into that first event:

* :func:`build_intent_event` maps an ``Allocation`` (``tier``,
  ``context_window``, ``fallback_reason``) onto an ``IntentEvent`` whose
  ``model_tier`` / ``context_window_tokens`` / ``fallback_reason`` fields mirror
  it exactly.
* :func:`allocation_stage_event_factory` adapts that into a
  :class:`~zocai_gateway.fsm.StageEventFactory` so the Agent-Mode FSM's first
  stage entry (``INTAKE``, always the FSM's first emitted event) is the
  allocator-aware ``IntentEvent`` while every later stage keeps the default
  stage-event shape.

The tier strings are identical between the allocator's
:class:`~zocai_gateway.model_interface.ModelTier` enum and the contract's
``ModelTier`` literal, but the mapping is made explicit so the literal type is
preserved end to end (no ``str``-to-literal widening).
"""

from __future__ import annotations

from shared_schema.agent_events import AgentEvent, IntentEvent
from shared_schema.agent_events import ModelTier as ModelTierLiteral

from zocai_gateway.fsm import StageEventFactory, default_stage_event_factory
from zocai_gateway.model_allocator import Allocation
from zocai_gateway.model_interface import ModelTier
from zocai_gateway.stages import Stage

__all__ = [
    "DEFAULT_INTENT_TEXT",
    "build_intent_event",
    "allocation_stage_event_factory",
]

#: The intent text used when the caller does not supply a per-run prompt
#: summary. The allocator metadata (tier/window/fallback) is the point of this
#: first event; the text is a human-readable label for the row.
DEFAULT_INTENT_TEXT = "run accepted"

#: Explicit map from the allocator's tier enum to the contract's tier literal.
#: The values coincide, but going through this map keeps the literal type so
#: ``IntentEvent.model_tier`` type-checks without widening to ``str`` (R1.9).
_TIER_TO_LITERAL: dict[ModelTier, ModelTierLiteral] = {
    ModelTier.LOCAL_SLM: "local-slm",
    ModelTier.EDGE: "edge",
    ModelTier.CLOUD: "cloud",
}


def build_intent_event(
    allocation: Allocation,
    *,
    seq: int,
    run_id: str,
    ts: str,
    text: str = DEFAULT_INTENT_TEXT,
) -> IntentEvent:
    """Build the run's first ``IntentEvent`` from ``allocation`` (R1.9, R1.6).

    The selected ``Model_Tier`` identifier and the allocated context-window
    size are recorded as structured fields, and the fallback reason is carried
    when (and only when) the allocation took the R1.6 fallback — it is ``None``
    for a normally scored selection, matching the optional ``fallbackReason``
    on the contract.
    """
    return IntentEvent(
        seq=seq,
        run_id=run_id,
        ts=ts,
        text=text,
        model_tier=_TIER_TO_LITERAL[allocation.tier],
        context_window_tokens=allocation.context_window,
        fallback_reason=allocation.fallback_reason,
    )


def allocation_stage_event_factory(
    allocation: Allocation,
    *,
    intent_text: str = DEFAULT_INTENT_TEXT,
) -> StageEventFactory:
    """Adapt ``allocation`` into a FSM :class:`StageEventFactory` (R1.9, R1.6).

    The returned factory emits the allocator-aware :class:`IntentEvent` for the
    FSM's first stage entry (``INTAKE`` — the run's first emitted event) and
    delegates every later stage to :func:`default_stage_event_factory`, so the
    tier/window/fallback land on the first event exactly once while the rest of
    the stream is unchanged. A ``detail`` passed for the ``INTAKE`` entry
    overrides the intent text, letting the Orchestrator stamp a per-run prompt
    summary.
    """

    def factory(
        stage: Stage,
        seq: int,
        run_id: str,
        ts: str,
        detail: str | None = None,
    ) -> AgentEvent:
        if stage is Stage.INTAKE:
            return build_intent_event(
                allocation,
                seq=seq,
                run_id=run_id,
                ts=ts,
                text=detail if detail is not None else intent_text,
            )
        return default_stage_event_factory(stage, seq, run_id, ts, detail)

    return factory
