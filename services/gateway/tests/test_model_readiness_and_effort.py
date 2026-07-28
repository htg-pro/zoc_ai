"""Unit tests for model readiness and reasoning-effort mapping (tasks 6.1, 6.3).

Feature: zoc-ai-agent-chat-overhaul.

**Validates: Requirements 5.2, 17.2, 17.4**
"""

from __future__ import annotations

from zocai_gateway.mode_router import AgentRunRequest, Mode
from zocai_gateway.model_runtime import (
    _reasoning_effort_payload,
    readiness,
    reasoning_effort_capability,
)


def _req(provider: str, model: str, effort: str | None) -> AgentRunRequest:
    return AgentRunRequest(
        prompt="x", mode=Mode.AGENT, provider=provider, model=model, reasoning_effort=effort
    )


# ── readiness (R5.2) ─────────────────────────────────────────────────────────


def test_readiness_rejects_no_selection() -> None:
    result = readiness("", "", "")
    assert result.ready is False
    assert result.reason


def test_readiness_rejects_endpoint_backed_provider_without_base_url() -> None:
    result = readiness("openai", "gpt-4o", "")
    assert result.ready is False
    assert "endpoint" in (result.reason or "")


def test_readiness_accepts_openai_compatible_with_endpoint() -> None:
    assert readiness("llamacpp", "qwen2.5-coder", "http://127.0.0.1:8080").ready is True


def test_readiness_accepts_anthropic_without_base_url() -> None:
    # Anthropic uses its native endpoint; the key is checked at call time.
    assert readiness("anthropic", "claude-opus-4-6", None).ready is True


# ── reasoning-effort capability (R17.4) ──────────────────────────────────────


def test_capability_openai_reasoning_model() -> None:
    assert reasoning_effort_capability("openai", "gpt-5") == "openai"
    assert reasoning_effort_capability("openai", "o3-mini") == "openai"


def test_capability_openai_base_model_has_none() -> None:
    assert reasoning_effort_capability("openai", "gpt-4o") == "none"


def test_capability_anthropic_46_is_adaptive() -> None:
    assert reasoning_effort_capability("anthropic", "claude-opus-4-6") == "anthropic_adaptive"
    assert reasoning_effort_capability("anthropic", "claude-sonnet-4-8") == "anthropic_adaptive"


def test_capability_anthropic_older_thinking_is_budget() -> None:
    assert reasoning_effort_capability("anthropic", "claude-3-7-sonnet") == "anthropic_budget"
    assert reasoning_effort_capability("anthropic", "claude-sonnet-4-5") == "anthropic_budget"


def test_capability_anthropic_non_thinking_is_none() -> None:
    assert reasoning_effort_capability("anthropic", "claude-3-5-haiku") == "none"


# ── effort payload mapping (R17.2, R17.4) ────────────────────────────────────


def test_effort_openai_maps_to_reasoning_effort() -> None:
    assert _reasoning_effort_payload(_req("openai", "gpt-5", "high"), "openai", "gpt-5") == {
        "reasoning_effort": "high"
    }


def test_effort_anthropic_46_maps_to_output_config_effort() -> None:
    payload = _reasoning_effort_payload(
        _req("anthropic", "claude-opus-4-6", "medium"), "anthropic", "claude-opus-4-6"
    )
    assert payload == {
        "thinking": {"type": "adaptive"},
        "output_config": {"effort": "medium"},
    }


def test_effort_anthropic_older_maps_to_thinking_budget() -> None:
    payload = _reasoning_effort_payload(
        _req("anthropic", "claude-3-7-sonnet", "low"), "anthropic", "claude-3-7-sonnet"
    )
    assert payload["thinking"]["type"] == "enabled"
    assert payload["thinking"]["budget_tokens"] > 0
    assert "output_config" not in payload


def test_effort_omitted_for_unsupported_model() -> None:
    assert _reasoning_effort_payload(_req("openai", "gpt-4o", "high"), "openai", "gpt-4o") == {}


def test_effort_omitted_when_no_preference() -> None:
    assert _reasoning_effort_payload(_req("openai", "gpt-5", None), "openai", "gpt-5") == {}
