"""Unit tests for the model-runtime tool-calling surface (task 9.5).

_Requirements: 8.1, 8.3, 8.4, 8.8_

HTTP is faked by monkeypatching ``model_runtime._post_json`` so no network is
touched; the tests assert the OpenAI/Anthropic request payloads, the normalized
``ModelToolResponse`` parsing (tool_calls + finish_reason/stop_reason), and the
prompted-tool fallback on a capability error and for a non-native provider.
"""

from __future__ import annotations

import pytest
from zocai_gateway.mode_router import AgentRunRequest, Mode
from zocai_gateway.model_runtime import (
    ModelRuntimeError,
    ToolSpec,
    generate_with_tools,
)

_TOOLS = [
    ToolSpec(
        name="write_file",
        description="write a file",
        parameters={"type": "object", "properties": {"path": {"type": "string"}}},
    ),
    ToolSpec(
        name="read_file",
        description="read a file",
        parameters={"type": "object", "properties": {"path": {"type": "string"}}},
    ),
]


def _request(provider: str, **extra: object) -> AgentRunRequest:
    return AgentRunRequest(
        prompt="do the task",
        mode=Mode.AGENT,
        provider=provider,
        model="model-x",
        **extra,  # type: ignore[arg-type]
    )


def test_openai_tools_payload_and_tool_call_parsing(monkeypatch) -> None:
    captured: dict = {}

    def fake_post_json(url, headers, payload, timeout):
        captured["url"] = url
        captured["payload"] = payload
        return {
            "choices": [
                {
                    "message": {
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "type": "function",
                                "function": {
                                    "name": "write_file",
                                    "arguments": '{"path": "a.py", "content": "x"}',
                                },
                            }
                        ],
                    },
                    "finish_reason": "tool_calls",
                }
            ]
        }

    monkeypatch.setattr("zocai_gateway.model_runtime._post_json", fake_post_json)
    response = generate_with_tools(
        _request("edge", base_url="http://edge.test"),
        system_prompt="system",
        tools=_TOOLS,
        tool_history=(),
    )

    assert captured["payload"]["tool_choice"] == "auto"
    assert captured["payload"]["tools"][0]["type"] == "function"
    assert captured["payload"]["tools"][0]["function"]["name"] == "write_file"
    assert response.finish_reason == "tool_calls"
    assert len(response.tool_calls) == 1
    assert response.tool_calls[0].name == "write_file"
    assert response.tool_calls[0].arguments == {"path": "a.py", "content": "x"}


def test_openai_stop_finish_reason(monkeypatch) -> None:
    monkeypatch.setattr(
        "zocai_gateway.model_runtime._post_json",
        lambda *_a, **_k: {"choices": [{"message": {"content": "done"}, "finish_reason": "stop"}]},
    )
    response = generate_with_tools(
        _request("cloud", base_url="http://cloud.test"),
        system_prompt=None,
        tools=_TOOLS,
        tool_history=(),
    )
    assert response.finish_reason == "stop"
    assert response.tool_calls == ()
    assert response.text == "done"


def test_anthropic_tools_payload_and_tool_use_parsing(monkeypatch) -> None:
    captured: dict = {}

    def fake_post_json(url, headers, payload, timeout):
        captured["url"] = url
        captured["payload"] = payload
        return {
            "content": [
                {"type": "text", "text": "reasoning here"},
                {"type": "tool_use", "id": "tu_1", "name": "read_file", "input": {"path": "a.py"}},
            ],
            "stop_reason": "tool_use",
        }

    monkeypatch.setattr("zocai_gateway.model_runtime._post_json", fake_post_json)
    response = generate_with_tools(
        _request("anthropic", api_key="secret"),
        system_prompt="system",
        tools=_TOOLS,
        tool_history=(),
    )

    assert captured["url"].endswith("/messages")
    assert captured["payload"]["tools"][0]["name"] == "write_file"
    assert "input_schema" in captured["payload"]["tools"][0]
    assert captured["payload"]["system"] == "system"
    assert response.finish_reason == "tool_calls"
    assert response.tool_calls[0].name == "read_file"
    assert response.tool_calls[0].arguments == {"path": "a.py"}
    assert response.text == "reasoning here"


def test_anthropic_end_turn_maps_to_stop(monkeypatch) -> None:
    monkeypatch.setattr(
        "zocai_gateway.model_runtime._post_json",
        lambda *_a, **_k: {"content": [{"type": "text", "text": "all done"}], "stop_reason": "end_turn"},
    )
    response = generate_with_tools(
        _request("anthropic", api_key="secret"),
        system_prompt=None,
        tools=_TOOLS,
        tool_history=(),
    )
    assert response.finish_reason == "stop"
    assert response.tool_calls == ()
    assert response.text == "all done"


def test_prompted_fallback_on_capability_error(monkeypatch) -> None:
    calls = {"n": 0}

    def fake_post_json(url, headers, payload, timeout):
        calls["n"] += 1
        if calls["n"] == 1:
            # The native tool attempt fails with a capability error.
            raise ModelRuntimeError("tools are not supported by this model")
        # The prompted fallback then parses a single JSON tool block from text.
        return {
            "choices": [
                {
                    "message": {
                        "content": '{"tool": "write_file", "arguments": {"path": "a.py", "content": "x"}}'
                    }
                }
            ]
        }

    monkeypatch.setattr("zocai_gateway.model_runtime._post_json", fake_post_json)
    response = generate_with_tools(
        _request("llamacpp", base_url="http://local.test"),
        system_prompt="system",
        tools=_TOOLS,
        tool_history=(),
    )
    assert calls["n"] == 2  # native attempt + prompted fallback
    assert response.finish_reason == "tool_calls"
    assert response.tool_calls[0].name == "write_file"
    assert response.tool_calls[0].arguments == {"path": "a.py", "content": "x"}


def test_prompted_fallback_for_non_native_provider(monkeypatch) -> None:
    calls = {"n": 0}

    def fake_post_json(url, headers, payload, timeout):
        calls["n"] += 1
        return {"choices": [{"message": {"content": "All done, no tools needed."}}]}

    monkeypatch.setattr("zocai_gateway.model_runtime._post_json", fake_post_json)
    response = generate_with_tools(
        _request("groq", base_url="http://groq.test"),
        system_prompt="system",
        tools=_TOOLS,
        tool_history=(),
    )
    # A provider absent from PROVIDER_NATIVE_TOOLS goes straight to the prompted
    # fallback (no native attempt), and a text-only reply is a stop.
    assert calls["n"] == 1
    assert response.finish_reason == "stop"
    assert response.tool_calls == ()


def test_no_provider_returns_stop(monkeypatch) -> None:
    monkeypatch.setattr(
        "zocai_gateway.model_runtime._post_json",
        lambda *_a, **_k: pytest.fail("no HTTP call expected without a provider"),
    )
    response = generate_with_tools(
        AgentRunRequest(prompt="do", mode=Mode.AGENT),
        system_prompt="system",
        tools=_TOOLS,
        tool_history=(),
    )
    assert response.finish_reason == "stop"
    assert response.tool_calls == ()
