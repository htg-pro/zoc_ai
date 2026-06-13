"""End-to-end smoke tests against a real local LLM.

These tests exercise the orchestrator and a few slash commands against a
small model served by a llama.cpp server. They are
opt-in (see ``conftest.py``) so they don't run in normal CI.

When they DO run, failures are intentionally noisy: the goal of the suite
is to surface tool-call parsing problems, prompt regressions, and
streaming bugs that the scripted mock provider can't catch.
"""

from __future__ import annotations

import json

import pytest
from llama_studio_agent.agent.orchestrator import OrchestratorConfig
from llama_studio_agent.providers.base import ChatMessage, ChatRequest, ToolSchema
from shared_schema.models import SlashCommandName

__all__ = ["OrchestratorConfig"]

pytestmark = pytest.mark.asyncio


async def test_provider_basic_chat(smoke_state, smoke_provider_kind, smoke_model):
    """Provider can complete a trivial chat — sanity check before bigger tests."""

    provider = smoke_state.providers.get(smoke_provider_kind)
    resp = await provider.chat(
        ChatRequest(
            messages=[
                ChatMessage(role="system", content="You answer with one short word."),
                ChatMessage(role="user", content="Say the word: pong"),
            ],
            model=smoke_model,
            temperature=0.0,
        )
    )
    assert isinstance(resp.text, str), "provider returned non-string content"
    assert resp.text.strip(), (
        f"provider returned empty completion (raw={resp.raw!r}); "
        "this usually means the model name is wrong or the server is unhealthy"
    )


async def test_provider_streaming_yields_chunks(smoke_state, smoke_provider_kind, smoke_model):
    """Streaming must produce at least one delta and a final finish marker."""

    provider = smoke_state.providers.get(smoke_provider_kind)
    stream = await provider.stream(
        ChatRequest(
            messages=[
                ChatMessage(role="system", content="Reply with a short sentence."),
                ChatMessage(role="user", content="Count: one two three."),
            ],
            model=smoke_model,
            temperature=0.0,
        )
    )

    text_chunks: list[str] = []
    finished = False
    async for chunk in stream:
        if chunk.delta_text:
            text_chunks.append(chunk.delta_text)
        if chunk.finish:
            finished = True

    assert finished, "stream never emitted a finish marker"
    assert any(c.strip() for c in text_chunks), (
        f"stream produced no text deltas (chunks={text_chunks!r})"
    )


async def test_provider_tool_call_formatting(smoke_state, smoke_provider_kind, smoke_model):
    """Force a tool call and verify the provider parses it into ProviderToolCall.

    This is the single most common source of real-LLM bugs: small models
    emit tool calls with quirky JSON, wrong field names, or stringified
    arguments. When this test fails, the assertion message points at the
    raw payload so the bug is obvious.
    """

    provider = smoke_state.providers.get(smoke_provider_kind)
    tool = ToolSchema(
        name="echo",
        description="Echo the given text back verbatim. ALWAYS call this tool.",
        parameters={
            "type": "object",
            "properties": {"text": {"type": "string", "description": "text to echo"}},
            "required": ["text"],
        },
    )
    resp = await provider.chat(
        ChatRequest(
            messages=[
                ChatMessage(
                    role="system",
                    content=(
                        "You MUST call the `echo` tool with text='hello' on every"
                        " user message. Never reply with prose."
                    ),
                ),
                ChatMessage(role="user", content="hello"),
            ],
            model=smoke_model,
            tools=[tool],
            temperature=0.0,
        )
    )

    assert resp.tool_calls, (
        f"model did not emit a tool call (text={resp.text!r}, raw={json.dumps(resp.raw)[:500]}). "
        "Possible causes: provider didn't forward the `tools` field, the model"
        " doesn't support function calling, or the response parser missed the"
        " `tool_calls` key."
    )
    call = resp.tool_calls[0]
    assert call.name == "echo", f"expected tool name 'echo', got {call.name!r}"
    assert isinstance(call.arguments, dict), (
        f"tool arguments not parsed into a dict: {call.arguments!r} (type={type(call.arguments).__name__})"
    )


async def test_orchestrator_explain_runs_to_completion(smoke_state, smoke_session, smoke_orchestrator):
    """The `/explain` recipe should run end-to-end and produce a non-empty answer."""

    result = await smoke_state.commands.run(
        name=SlashCommandName.explain,
        args={"target": "src/math_utils.py"},
        orchestrator=smoke_orchestrator,
        session_id=smoke_session.id,
        workspace_root=smoke_session.workspace_root,
    )

    assert result.iterations >= 1
    assert result.final_text.strip(), (
        f"/explain produced empty final text after {result.iterations} iterations; "
        f"tool_calls={[(c.name, c.status.value) for c in result.tool_calls]}"
    )
    # At least one tool call should be a read of the file we asked about.
    read_calls = [c for c in result.tool_calls if c.name == "read_file"]
    assert read_calls, (
        "model never called read_file when asked to explain a specific file; "
        "likely prompt-formatting or tool-discovery regression"
    )


async def test_orchestrator_grok_uses_index(smoke_state, smoke_session, smoke_orchestrator):
    """The `/grok` recipe must consult `index_query` and produce text."""

    result = await smoke_state.commands.run(
        name=SlashCommandName.grok,
        args={"query": "What does the add function do?"},
        orchestrator=smoke_orchestrator,
        session_id=smoke_session.id,
        workspace_root=smoke_session.workspace_root,
    )

    assert result.final_text.strip(), "/grok returned no final text"
    names = {c.name for c in result.tool_calls}
    assert "index_query" in names or "read_file" in names, (
        f"/grok did not consult the workspace (tool calls: {sorted(names)})"
    )


async def test_orchestrator_max_iterations_is_respected(smoke_state, smoke_session, smoke_orchestrator):
    """Cap iterations tightly to confirm the orchestrator terminates cleanly."""

    result = await smoke_orchestrator.run(
        session_id=smoke_session.id,
        workspace_root=smoke_session.workspace_root,
        prompt="List the files in src/ using the list_dir tool, then summarise.",
        config=OrchestratorConfig(max_iterations=4, skip_planner=True),
    )
    assert result.iterations <= 4
    assert result.final_text or result.tool_calls, "no work was performed within the iteration budget"
