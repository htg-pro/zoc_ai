"""Regression: `generate_text_stream` forwards an optional stop sequence (R11.4).

The completions endpoint calls the model with ≥1 stop sequence. This pins that
``generate_text_stream`` places ``stop`` in the OpenAI-compatible request
payload when provided, and leaves existing callers' payloads unchanged when it
is omitted (backward-compatible signature change).
"""

from __future__ import annotations

from typing import Any

import zocai_gateway.model_runtime as mr
from zocai_gateway.mode_router import AgentRunRequest


def _request() -> AgentRunRequest:
    return AgentRunRequest(
        prompt="p",
        mode="ask",
        provider="openai",
        model="gpt-4o-mini",
        base_url="http://localhost:1234",
        api_key="k",
    )


def _capture_payload(monkeypatch) -> dict[str, Any]:
    captured: dict[str, Any] = {}

    def fake_stream(url, headers, payload, timeout):
        captured["payload"] = payload
        return iter([{"choices": [{"delta": {"content": "x"}}]}])

    monkeypatch.setattr(mr, "_stream_json_lines", fake_stream)
    return captured


def test_stop_is_forwarded_into_the_openai_payload(monkeypatch) -> None:
    captured = _capture_payload(monkeypatch)
    mr.generate_text_stream(_request(), stop=["\n\n", "```"])
    assert captured["payload"]["stop"] == ["\n\n", "```"]


def test_stop_absent_leaves_the_payload_without_a_stop_key(monkeypatch) -> None:
    captured = _capture_payload(monkeypatch)
    mr.generate_text_stream(_request())
    assert "stop" not in captured["payload"]
