"""Integration: the completions endpoint's admission wiring and SSE streaming.

Covers R15.1/R15.4 (the route is served on the existing app behind
``require_admission`` with no extra listener — a loopback request is admitted, a
non-loopback tokenless request is rejected) and R12/R13.3 (end-to-end ordered
``token`` events then one ``done`` on both the FIM and fallback paths), driven
with a fake token generator so no real model is called.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi.testclient import TestClient
from zocai_gateway.app import create_app
from zocai_gateway.mode_router import AgentRunRequest
from zocai_gateway.routes import completions as comp
from zocai_gateway.settings import GatewaySettings

_BODY_FIM = {"prefix": "def ", "suffix": "", "language": "python", "filePath": "/f.py", "provider": "p", "model": "codellama-7b"}
_BODY_FALLBACK = {"prefix": "const x", "suffix": "", "language": "typescript", "filePath": "/f.ts", "provider": "p", "model": "gpt-4o-mini"}


def _parse_sse(body: str) -> list[tuple[str, str]]:
    """Parse ``(event, data)`` pairs from an SSE response body."""
    frames: list[tuple[str, str]] = []
    event: str | None = None
    for line in body.splitlines():
        if line.startswith("event:"):
            event = line[len("event:") :].strip()
        elif line.startswith("data:"):
            frames.append((event or "message", line[len("data:") :].strip()))
            event = None
    return frames


def _patch_fake_model(monkeypatch, tokens: list[str]) -> None:
    """Route `stream_completion_events` through the real core with a fake model."""

    def fake_model(run: AgentRunRequest, *, on_token=None, stop=None, **_kw: Any) -> str:
        for tok in tokens:
            if on_token is not None:
                on_token(tok)
        return "".join(tokens)

    def patched(req, *, cache):
        return comp.stream_completion_events(req, cache=cache, generate_stream=fake_model)

    monkeypatch.setattr("zocai_gateway.app.stream_completion_events", patched)


def test_loopback_request_is_admitted(monkeypatch) -> None:
    _patch_fake_model(monkeypatch, ["x"])
    with TestClient(create_app()) as client:  # default = loopback, no credential
        resp = client.post("/v1/completions", json=_BODY_FIM)
    assert resp.status_code == 200


def test_non_loopback_tokenless_request_is_rejected(monkeypatch) -> None:
    _patch_fake_model(monkeypatch, ["x"])
    settings = GatewaySettings(host="0.0.0.0", port=0, auth_token="secret")
    with TestClient(create_app(settings=settings)) as client:
        resp = client.post("/v1/completions", json=_BODY_FIM)  # no token presented
    assert resp.status_code == 401


def test_streams_ordered_tokens_then_done_on_fim_path(monkeypatch) -> None:
    _patch_fake_model(monkeypatch, ["foo", "(", "bar)"])
    with TestClient(create_app()) as client:
        resp = client.post("/v1/completions", json=_BODY_FIM)
        frames = _parse_sse(resp.text)

    token_texts = [json.loads(d)["text"] for e, d in frames if e == "token"]
    assert token_texts == ["foo", "(", "bar)"]  # R12.1/R12.2 ordered
    assert frames[-1][0] == "done"  # R12.3 distinct terminal, last
    assert sum(1 for e, _ in frames if e == "done") == 1


def test_streams_ordered_tokens_then_done_on_fallback_path(monkeypatch) -> None:
    _patch_fake_model(monkeypatch, ["= 1", ";"])
    with TestClient(create_app()) as client:
        resp = client.post("/v1/completions", json=_BODY_FALLBACK)  # non-FIM model
        frames = _parse_sse(resp.text)

    token_texts = [json.loads(d)["text"] for e, d in frames if e == "token"]
    assert token_texts == ["= 1", ";"]  # R13.3: same streaming transport
    assert frames[-1][0] == "done"
    assert sum(1 for e, _ in frames if e == "done") == 1


def test_empty_completion_streams_only_done(monkeypatch) -> None:
    _patch_fake_model(monkeypatch, [])  # model emits nothing
    with TestClient(create_app()) as client:
        resp = client.post("/v1/completions", json=_BODY_FIM)
        frames = _parse_sse(resp.text)
    assert [e for e, _ in frames if e == "token"] == []  # R12.4: no token events
    assert sum(1 for e, _ in frames if e == "done") == 1
