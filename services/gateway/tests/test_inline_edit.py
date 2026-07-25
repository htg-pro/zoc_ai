"""Tests for the Cmd+K inline-edit route (Part 8.2)."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi.testclient import TestClient
from zocai_gateway.app import create_app
from zocai_gateway.mode_router import AgentRunRequest
from zocai_gateway.routes import inline as inl
from zocai_gateway.routes.inline import (
    InlineEditRequest,
    build_inline_edit_prompt,
    stream_inline_edit_events,
    strip_code_fences,
)
from zocai_gateway.settings import GatewaySettings


def _collect(request: InlineEditRequest, tokens: list[str]) -> list[dict[str, str]]:
    def fake(run: AgentRunRequest, *, on_token=None, stop=None, **_kw: Any) -> str:  # type: ignore[no-untyped-def]
        for tok in tokens:
            if on_token is not None:
                on_token(tok)
        return "".join(tokens)

    async def run() -> list[dict[str, str]]:
        return [frame async for frame in stream_inline_edit_events(request, generate_stream=fake)]

    return asyncio.run(run())


def test_prompt_is_replacement_only_and_includes_selection_and_instruction() -> None:
    prompt = build_inline_edit_prompt(
        InlineEditRequest(
            instruction="make it async", code="def f():\n    pass", language="python",
            prefix="import os", suffix="f()",
        )
    )
    assert "Return ONLY the replacement code" in prompt
    assert "make it async" in prompt
    assert "def f():\n    pass" in prompt
    assert "python" in prompt


def test_strip_code_fences() -> None:
    assert strip_code_fences("```python\nx = 1\n```") == "x = 1"
    assert strip_code_fences("```\na\nb\n```") == "a\nb"
    assert strip_code_fences("no fence here") == "no fence here"


def test_stream_emits_ordered_tokens_then_one_done() -> None:
    frames = _collect(InlineEditRequest(instruction="x", code="y"), ["def f():\n", "    return 1\n"])
    tokens = [json.loads(f["data"])["text"] for f in frames if f["event"] == "token"]
    assert tokens == ["def f():\n", "    return 1\n"]
    assert frames[-1]["event"] == "done"
    assert sum(1 for f in frames if f["event"] == "done") == 1


def test_done_carries_fence_stripped_replacement() -> None:
    frames = _collect(InlineEditRequest(instruction="x", code="y"), ["```py\n", "x = 1\n", "```"])
    done = next(f for f in frames if f["event"] == "done")
    assert json.loads(done["data"])["text"] == "x = 1"


def test_empty_stream_still_terminates_with_one_done() -> None:
    frames = _collect(InlineEditRequest(instruction="x", code="y"), [])
    assert [f for f in frames if f["event"] == "token"] == []
    assert sum(1 for f in frames if f["event"] == "done") == 1


def _patch_fake(monkeypatch, tokens: list[str]) -> None:
    def fake_model(run: AgentRunRequest, *, on_token=None, stop=None, **_kw: Any) -> str:  # type: ignore[no-untyped-def]
        for tok in tokens:
            if on_token is not None:
                on_token(tok)
        return "".join(tokens)

    def patched(req: InlineEditRequest):  # type: ignore[no-untyped-def]
        return inl.stream_inline_edit_events(req, generate_stream=fake_model)

    monkeypatch.setattr("zocai_gateway.app.stream_inline_edit_events", patched)


_BODY = {"instruction": "rename x to y", "code": "x = 1", "language": "python", "filePath": "/f.py"}


def test_loopback_request_is_admitted_and_streams(monkeypatch) -> None:
    _patch_fake(monkeypatch, ["y = 1"])
    with TestClient(create_app()) as client:
        resp = client.post("/v1/agent/inline-edit", json=_BODY)
    assert resp.status_code == 200
    assert "event: done" in resp.text


def test_non_loopback_tokenless_request_is_rejected(monkeypatch) -> None:
    _patch_fake(monkeypatch, ["y = 1"])
    settings = GatewaySettings(host="0.0.0.0", port=0, auth_token="secret")
    with TestClient(create_app(settings=settings)) as client:
        resp = client.post("/v1/agent/inline-edit", json=_BODY)
    assert resp.status_code == 401


def test_inline_edit_passes_instruction_as_system_prompt() -> None:
    captured: dict[str, object] = {}

    def fake_model(
        run: AgentRunRequest,
        *,
        on_token=None,
        **kwargs: Any,
    ) -> str:
        captured.update(kwargs)
        if on_token is not None:
            on_token("edited")
        return "edited"

    async def collect() -> list[dict[str, str]]:
        request = InlineEditRequest(instruction="simplify", code="x = x + 0")
        return [
            frame
            async for frame in stream_inline_edit_events(request, generate_stream=fake_model)
        ]

    frames = asyncio.run(collect())
    assert frames[-1]["event"] == "done"
    assert captured["system_prompt"] == inl.INLINE_EDIT_SYSTEM
