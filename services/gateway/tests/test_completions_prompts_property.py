"""Feature: editor-diagnostics-completions, Property 11: Prompt selection matches
model FIM capability.
Feature: editor-diagnostics-completions, Property 12: Model is always called with
the fixed completion parameters.

**Validates: Requirements 11.3, 13.1 (Property 11); 11.4, 13.2 (Property 12)**
"""

from __future__ import annotations

import asyncio
from typing import Any

from hypothesis import given, settings
from hypothesis import strategies as st
from zocai_gateway.mode_router import AgentRunRequest
from zocai_gateway.routes.completions import (
    COMPLETION_MAX_TOKENS,
    COMPLETION_TEMPERATURE,
    CompletionCache,
    CompletionRequest,
    build_fallback_prompt,
    build_fim_prompt,
    model_supports_fim,
    stream_completion_events,
)

# Models known to support FIM and models that do not (→ fallback).
_FIM_MODELS = ["codellama-7b", "starcoder2-3b", "deepseek-coder-6.7b", "qwen2.5-coder", "codestral-latest"]
_NON_FIM_MODELS = ["gpt-4o-mini", "claude-3-5-sonnet", "llama-3-8b", "mistral-small", ""]

_text = st.text(max_size=60)


def _drive(req: CompletionRequest) -> tuple[dict[str, Any], list[dict[str, str]]]:
    """Run the stream with a capturing fake model that emits no tokens."""
    captured: dict[str, Any] = {}

    def fake_generate(run: AgentRunRequest, *, on_token=None, stop=None, **_kw: Any) -> str | None:
        captured["run"] = run
        captured["stop"] = stop
        return ""  # empty completion — never cached, so every call reaches here

    async def run_it() -> list[dict[str, str]]:
        frames: list[dict[str, str]] = []
        async for frame in stream_completion_events(
            req, cache=CompletionCache(), generate_stream=fake_generate
        ):
            frames.append(frame)
        return frames

    frames = asyncio.run(run_it())
    return captured, frames


@settings(max_examples=200)
@given(
    prefix=_text,
    suffix=_text,
    language=st.text(max_size=15),
    model=st.sampled_from(_FIM_MODELS + _NON_FIM_MODELS),
)
def test_property_11_prompt_selection_matches_fim_capability(
    prefix: str, suffix: str, language: str, model: str
) -> None:
    req = CompletionRequest(
        prefix=prefix, suffix=suffix, language=language, filePath="/f", provider="p", model=model
    )
    captured, _frames = _drive(req)
    prompt = captured["run"].prompt

    if model_supports_fim("p", model):
        assert prompt == build_fim_prompt(prefix, suffix)
        assert prompt == f"<PRE>{prefix}<SUF>{suffix}<MID>"
    else:
        assert prompt == build_fallback_prompt(prefix, suffix, language)
        assert not prompt.startswith("<PRE>")


@settings(max_examples=200)
@given(
    prefix=_text,
    suffix=_text,
    language=st.text(max_size=15),
    model=st.sampled_from(_FIM_MODELS + _NON_FIM_MODELS),
)
def test_property_12_model_called_with_fixed_parameters(
    prefix: str, suffix: str, language: str, model: str
) -> None:
    req = CompletionRequest(
        prefix=prefix, suffix=suffix, language=language, filePath="/f", provider="p", model=model
    )
    captured, _frames = _drive(req)
    run: AgentRunRequest = captured["run"]

    # R11.4/R13.2: fixed on both the FIM and fallback paths.
    assert run.temperature == COMPLETION_TEMPERATURE == 0.1
    assert run.max_tokens == COMPLETION_MAX_TOKENS == 128
    # At least one stop sequence is passed.
    assert captured["stop"] is not None
    assert len(captured["stop"]) >= 1
