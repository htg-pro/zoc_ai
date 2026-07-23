"""Feature: editor-diagnostics-completions, Property 14: The SSE stream carries
ordered token events and exactly one distinct terminal.
Feature: editor-diagnostics-completions, Property 17: The endpoint fails quietly
to an empty, error-free stream.

**Validates: Requirements 12.1, 12.2, 12.3, 12.4, 13.3 (Property 14);
16.1, 16.2, 16.5 (Property 17)**
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from hypothesis import given, settings
from hypothesis import strategies as st
from zocai_gateway.mode_router import AgentRunRequest
from zocai_gateway.model_runtime import ModelRuntimeError
from zocai_gateway.routes.completions import (
    CompletionCache,
    CompletionRequest,
    stream_completion_events,
)


def _req() -> CompletionRequest:
    return CompletionRequest(
        prefix="a", suffix="b", language="python", filePath="/f.py", provider="p", model="m"
    )


def _run(generate) -> list[dict[str, str]]:
    async def go() -> list[dict[str, str]]:
        frames: list[dict[str, str]] = []
        async for frame in stream_completion_events(
            _req(), cache=CompletionCache(), generate_stream=generate
        ):
            frames.append(frame)
        return frames

    return asyncio.run(go())


def _token_texts(frames: list[dict[str, str]]) -> list[str]:
    return [json.loads(f["data"])["text"] for f in frames if f["event"] == "token"]


def _assert_one_terminal_last(frames: list[dict[str, str]]) -> None:
    done_indices = [i for i, f in enumerate(frames) if f["event"] == "done"]
    assert len(done_indices) == 1  # exactly one terminal
    assert done_indices[0] == len(frames) - 1  # and it is last
    # No error event is ever emitted.
    assert all(f["event"] in {"token", "done"} for f in frames)


@settings(max_examples=200)
@given(chunks=st.lists(st.text(min_size=1, max_size=8), max_size=25))
def test_property_14_ordered_tokens_then_one_terminal(chunks: list[str]) -> None:
    def generate(run: AgentRunRequest, *, on_token=None, stop=None, **_kw: Any) -> str:
        for chunk in chunks:
            if on_token is not None:
                on_token(chunk)
        return "".join(chunks)

    frames = _run(generate)

    # R12.1/R12.2: one token event per chunk, in emission order (no batching).
    assert _token_texts(frames) == chunks
    # R12.3/R12.4: exactly one distinct terminal, last; empty → zero tokens.
    _assert_one_terminal_last(frames)
    if not chunks:
        assert _token_texts(frames) == []


@settings(max_examples=100)
@given(data=st.data())
def test_property_17_fails_quietly_to_empty_error_free_stream(data: st.DataObject) -> None:
    outcome = data.draw(st.sampled_from(["none", "raise_before", "raise_after"]))

    if outcome == "none":
        # R16.1: no configured provider/model → generate_text_stream returns None.
        def generate(run: AgentRunRequest, *, on_token=None, stop=None, **_kw: Any) -> None:
            return None

        expected_tokens: list[str] = []
    elif outcome == "raise_before":
        # R16.2: error before the first token.
        def generate(run: AgentRunRequest, *, on_token=None, stop=None, **_kw: Any) -> str:
            raise ModelRuntimeError("boom before")

        expected_tokens = []
    else:
        # R16.5: error after one or more tokens — the pre-failure tokens remain.
        pre = data.draw(st.lists(st.text(min_size=1, max_size=6), min_size=1, max_size=5))

        def generate(run: AgentRunRequest, *, on_token=None, stop=None, **_kw: Any) -> str:
            for chunk in pre:
                if on_token is not None:
                    on_token(chunk)
            raise ModelRuntimeError("boom after")

        expected_tokens = pre

    frames = _run(generate)
    assert _token_texts(frames) == expected_tokens
    _assert_one_terminal_last(frames)
