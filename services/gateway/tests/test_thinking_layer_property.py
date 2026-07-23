"""Property tests for the private Chain-of-Thought thinking layer (Epic 1).

Feature: agent-reasoning-engine, Properties 1-5.

These lock the built Thinking_Layer behavior (capability 1.1) to the
requirements: scratchpad extraction, fail-closed on malformed thinking,
thinking privacy, scratchpad injection into the planning prompt, and thinking
event fidelity.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from unittest.mock import patch

from hypothesis import given, settings
from hypothesis import strategies as st
from zocai_gateway.context.steering_compiler import SteeringPayload
from zocai_gateway.context.token_gate import TokenGateResult
from zocai_gateway.emit_gate import EmitGate
from zocai_gateway.mode_router import AgentRunRequest, Mode
from zocai_gateway.model_allocator import Allocation
from zocai_gateway.model_interface import ModelTier
from zocai_gateway.run_pipeline import (
    DefaultAgentBrain,
    RunContext,
    RunPipeline,
    _agent_system_prompt,
    _extract_thinking,
    _has_think_block,
    _structured_plan_system_prompt,
)

# ── helpers ──────────────────────────────────────────────────────────────────


def _context(scratchpad: str = "") -> RunContext:
    return RunContext(
        allocation=Allocation(ModelTier.LOCAL_SLM, 4000),
        fragments=(),
        steering=SteeringPayload(),
        token_gate=TokenGateResult(fragments=(), dropped=(), token_count=0, window=4000),
        mcp_tools=(),
        scratchpad=scratchpad,
    )


def _run_events_with_brain(brain: DefaultAgentBrain, root: Path) -> list[dict[str, object]]:
    events: list[dict[str, object]] = []
    RunPipeline(
        AgentRunRequest(prompt="do the task", mode=Mode.AGENT),
        "thinking-run",
        gate=EmitGate(sink=lambda event: events.append(dict(event))),
        text_sink=lambda _chunk: None,
        close=lambda: None,
        workspace_root=root,
        brain=brain,
    ).run()
    return events


def _clean(text: str) -> str:
    """Remove any think tags so a generated fragment cannot form its own block."""
    return text.replace("<think>", "").replace("</think>", "")


# ── Property 1: scratchpad extraction isolates the first think block ─────────


@st.composite
def _text_with_first_block(draw: st.DrawFn) -> tuple[str, str]:
    inner = _clean(draw(st.text(max_size=60)))
    prefix = _clean(draw(st.text(max_size=30)))
    suffix = _clean(draw(st.text(max_size=30)))
    later = ""
    if draw(st.booleans()):
        # A later block must be discarded: only the first block is extracted.
        later = f"<think>{_clean(draw(st.text(max_size=20)))}</think>"
    return f"{prefix}<think>{inner}</think>{suffix}{later}", inner.strip()


@settings(max_examples=200)
@given(_text_with_first_block())
def test_scratchpad_extraction_isolates_first_block(case: tuple[str, str]) -> None:
    """Property 1: extraction returns the first block content, discarding the rest.

    Feature: agent-reasoning-engine, Property 1

    **Validates: Requirements 1.3, 2.3**
    """
    text, expected = case
    assert _extract_thinking(text) == expected
    assert _has_think_block(text) is True


@settings(max_examples=200)
@given(st.text(max_size=80))
def test_scratchpad_extraction_empty_when_no_complete_block(text: str) -> None:
    """Property 1 (contrapositive): no complete block ⇒ empty extraction.

    Feature: agent-reasoning-engine, Property 1

    **Validates: Requirements 1.3, 2.3**
    """
    # Removing every closing tag guarantees no complete <think>...</think> block.
    without_close = text.replace("</think>", " ")
    assert _has_think_block(without_close) is False
    assert _extract_thinking(without_close) == ""


# ── Property 3: malformed thinking fails closed ──────────────────────────────

# A non-empty response that carries no complete block. The "noise:" prefix keeps
# it non-empty and stripping the closing tag guarantees no complete block
# (covers the unclosed-<think> and no-tag cases).
_malformed = st.text(max_size=60).map(lambda s: ("noise:" + s).replace("</think>", " "))


@settings(max_examples=200, deadline=None)
@given(response=_malformed)
def test_malformed_thinking_fails_closed(response: str) -> None:
    """Property 3: a non-empty malformed thinking response reaches ERROR_CLOSED.

    Feature: agent-reasoning-engine, Property 3

    **Validates: Requirements 2.4**
    """
    with tempfile.TemporaryDirectory() as tmp:
        events: list[dict[str, object]] = []
        request = AgentRunRequest(
            prompt="edit the parser",
            mode=Mode.AGENT,
            provider="mock",
            model="mock-model",
            base_url="http://model.test",
        )
        with patch("zocai_gateway.run_pipeline.generate_text", return_value=response):
            result = RunPipeline(
                request,
                "malformed-thinking",
                gate=EmitGate(sink=lambda event: events.append(dict(event))),
                text_sink=lambda _chunk: None,
                close=lambda: None,
                workspace_root=Path(tmp),
            ).run()
    assert result.stage.value == "error_closed"


# ── Property 2: raw thinking never leaks beyond the thinking row ─────────────

_SENTINEL = "ZZSCRATCHPADSENTINELZZ"


@settings(max_examples=100, deadline=None)
@given(body=st.text(max_size=40))
def test_raw_thinking_never_leaks(body: str) -> None:
    """Property 2: only the private thinking row carries the raw scratchpad.

    Feature: agent-reasoning-engine, Property 2

    **Validates: Requirements 2.1, 2.2**
    """
    scratchpad = _SENTINEL + body.replace(_SENTINEL, "")

    class _Brain(DefaultAgentBrain):
        def think(self, request: AgentRunRequest, context: RunContext) -> str:
            return scratchpad

    with tempfile.TemporaryDirectory() as tmp:
        events = _run_events_with_brain(_Brain(), Path(tmp))

    private = [
        event
        for event in events
        if event["type"] == "thinking" and event.get("gist") == "Private task analysis"
    ]
    assert private, "expected exactly one private thinking row"
    assert _SENTINEL in str(private[0]["text"])
    # The summary and every non-private event must be free of the raw scratchpad.
    for event in events:
        is_private = event["type"] == "thinking" and event.get("gist") == "Private task analysis"
        if is_private:
            continue
        assert _SENTINEL not in json.dumps(event, default=str)
        if event["type"] == "summary":
            assert _SENTINEL not in str(event["text"])


# ── Property 4: scratchpad is injected into the planning prompt ──────────────


@settings(max_examples=200)
@given(scratchpad=st.text(min_size=1, max_size=200).filter(lambda s: s.strip()))
def test_scratchpad_injected_into_planning_prompt(scratchpad: str) -> None:
    """Property 4: a non-empty scratchpad appears in the PLAN_EDITS prompt.

    Feature: agent-reasoning-engine, Property 4

    **Validates: Requirements 1.4**
    """
    context = _context(scratchpad=scratchpad)
    assert scratchpad in _structured_plan_system_prompt(context, include_schema=False)
    assert scratchpad in _agent_system_prompt(context)


# ── Property 5: thinking event fidelity ──────────────────────────────────────


@settings(max_examples=100, deadline=None)
@given(body=st.text(min_size=1, max_size=80).filter(lambda s: s.strip()))
def test_thinking_event_fidelity(body: str) -> None:
    """Property 5: the thinking row carries the scratchpad and precedes ANALYZE.

    Feature: agent-reasoning-engine, Property 5

    **Validates: Requirements 1.5, 1.6**
    """

    class _Brain(DefaultAgentBrain):
        def think(self, request: AgentRunRequest, context: RunContext) -> str:
            return body

    with tempfile.TemporaryDirectory() as tmp:
        events = _run_events_with_brain(_Brain(), Path(tmp))

    scratch_index = next(
        index
        for index, event in enumerate(events)
        if event["type"] == "thinking" and event.get("gist") == "Private task analysis"
    )
    analyze_index = next(
        index
        for index, event in enumerate(events)
        if event["type"] == "thinking" and event.get("text") == "analyze"
    )
    row = events[scratch_index]
    assert row["text"] == body
    assert row["collapsible"] is True
    assert int(row["elapsedMs"]) >= 0  # type: ignore[arg-type]
    assert scratch_index < analyze_index
