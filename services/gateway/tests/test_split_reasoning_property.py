"""Property tests for total reasoning degradation (zoc-ai-agent-chat-overhaul).

Feature: zoc-ai-agent-chat-overhaul, Property 12 and Property 14.

These lock the rewritten ANALYZE path to the spec: ``split_reasoning`` is total
and round-trips (Property 12), and a model transport/provider failure closes the
run naming the provider while a merely-missing block does not (Property 14).
"""

from __future__ import annotations

import json
import re
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
from zocai_gateway.model_runtime import ModelRuntimeError
from zocai_gateway.reasoning import ReasoningSplit, split_reasoning
from zocai_gateway.run_pipeline import (
    ModelUnavailableError,
    RunContext,
    RunPipeline,
    RuntimeAgentBrain,
)
from zocai_gateway.stages import Stage

_THINK_TAGS = re.compile(r"</?think>", re.IGNORECASE)


def _clean(text: str) -> str:
    """Strip any think markup so a generated fragment cannot form its own block."""
    return _THINK_TAGS.sub("", text)


def _context() -> RunContext:
    return RunContext(
        allocation=Allocation(ModelTier.LOCAL_SLM, 4000),
        fragments=(),
        steering=SteeringPayload(),
        token_gate=TokenGateResult(fragments=(), dropped=(), token_count=0, window=4000),
        mcp_tools=(),
    )


# ── Property 12: reasoning splitting is total and round-trips ────────────────


@settings(max_examples=200)
@given(reasoning=st.text(max_size=120), body=st.text(max_size=120))
def test_split_reasoning_round_trips(reasoning: str, body: str) -> None:
    """Property 12: a wrapped reasoning block splits back into reasoning and body.

    Feature: zoc-ai-agent-chat-overhaul, Property 12

    **Validates: Requirements 6.1, 6.2, 6.3**
    """
    r = _clean(reasoning)
    b = _clean(body)
    split = split_reasoning(f"<think>{r}</think>{b}")
    assert isinstance(split, ReasoningSplit)
    assert split.had_block is True
    assert split.reasoning == r.strip()
    assert split.body == b.strip()


@settings(max_examples=200)
@given(text=st.text(max_size=200))
def test_split_reasoning_is_total(text: str) -> None:
    """Property 12: the split never raises, and no-block text is all body.

    Feature: zoc-ai-agent-chat-overhaul, Property 12

    **Validates: Requirements 6.2, 6.3**
    """
    split = split_reasoning(text)  # must not raise, for any string
    assert isinstance(split, ReasoningSplit)
    if "<think>" not in text.lower():
        # No opening tag at all ⇒ empty reasoning and the whole (stripped) input
        # as the body (R6.2), with the empty string mapping to ("", "") (R6.3).
        assert split.reasoning == ""
        assert split.body == text.strip()
        assert split.had_block is False


# ── Property 14: a model transport failure closes the run, naming the provider ─

_providers = st.text(alphabet="abcdefghijklmnopqrstuvwxyz0123456789-", min_size=1, max_size=16)


@settings(max_examples=100, deadline=None)
@given(provider=_providers, message=st.text(max_size=60))
def test_model_transport_failure_names_provider(provider: str, message: str) -> None:
    """Property 14: a transport failure raises ModelUnavailableError naming the provider.

    Feature: zoc-ai-agent-chat-overhaul, Property 14

    **Validates: Requirements 6.6**
    """
    request = AgentRunRequest(
        prompt="edit the parser",
        mode=Mode.AGENT,
        provider=provider,
        model="mock-model",
        base_url="http://model.test",
    )

    def boom(*_args: object, **_kwargs: object) -> str:
        raise ModelRuntimeError(message)

    with patch("zocai_gateway.run_pipeline.generate_text", boom):
        try:
            RuntimeAgentBrain().think(request, _context())
        except ModelUnavailableError as exc:
            assert exc.provider == provider
            assert provider in str(exc)
        else:  # pragma: no cover - assertion branch
            raise AssertionError("a transport failure must raise ModelUnavailableError")


@settings(max_examples=100, deadline=None)
@given(provider=_providers)
def test_model_transport_failure_closes_run(provider: str) -> None:
    """Property 14: the transport failure drives the whole run to ERROR_CLOSED.

    Feature: zoc-ai-agent-chat-overhaul, Property 14

    **Validates: Requirements 6.6**
    """

    def boom(*_args: object, **_kwargs: object) -> str:
        raise ModelRuntimeError("endpoint unreachable")

    with tempfile.TemporaryDirectory() as tmp:
        events: list[dict[str, object]] = []
        request = AgentRunRequest(
            prompt="edit the parser",
            mode=Mode.AGENT,
            provider=provider,
            model="mock-model",
            base_url="http://model.test",
        )
        with patch("zocai_gateway.run_pipeline.generate_text", boom):
            result = RunPipeline(
                request,
                "transport-failure",
                gate=EmitGate(sink=lambda event: events.append(dict(event))),
                text_sink=lambda _chunk: None,
                close=lambda: None,
                workspace_root=Path(tmp),
            ).run()
    assert result.stage is Stage.ERROR_CLOSED
    # The provider is named somewhere in the emitted terminal frames (R6.6).
    assert any(provider in json.dumps(event, default=str) for event in events)
