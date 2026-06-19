"""Unit tests for the gateway control + telemetry endpoints (task 7.1, R6.1).

These example-based tests pin the endpoint surface: the run/decision control
channel and the SSE telemetry channel are registered, wired to the
``ModeRouter``, and behave correctly for the happy path and the obvious error
case. The emit gate, FSM-ordered emission, and channel discipline (R6.2/6.4-6.7)
are exercised by task 7.2's tests, not here.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from zocai_gateway.app import create_app


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


def test_routes_are_registered() -> None:
    app = create_app()
    paths = {route.path for route in app.routes}  # type: ignore[attr-defined]
    assert "/v1/agent/run" in paths
    assert "/v1/agent/decision" in paths
    assert "/v1/agent/events" in paths


def test_health_still_ok(client: TestClient) -> None:
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_loopback_cors_preflight_is_allowed(client: TestClient) -> None:
    resp = client.options(
        "/v1/agent/run",
        headers={
            "Origin": "http://127.0.0.1:1420",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert resp.status_code == 200
    assert resp.headers["access-control-allow-origin"] == "http://127.0.0.1:1420"


def test_agent_run_ask_mode_returns_run_id(client: TestClient) -> None:
    resp = client.post("/v1/agent/run", json={"prompt": "explain", "mode": "ask"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["mode"] == "ask"
    assert body["accepted"] is True
    assert isinstance(body["runId"], str)
    assert body["runId"]


def test_agent_run_accepts_model_provider_payload() -> None:
    client = TestClient(create_app(drive=False))
    resp = client.post(
        "/v1/agent/run",
        json={
            "prompt": "explain",
            "mode": "ask",
            "provider": "anthropic",
            "model": "claude-3-5-sonnet-latest",
            "api_key": "test-key",
            "base_url": "https://api.anthropic.com/v1",
            "workspace_root": "/tmp/workspace",
        },
    )
    assert resp.status_code == 200
    assert resp.json()["mode"] == "ask"


def test_agent_run_agent_mode_returns_run_id(client: TestClient) -> None:
    resp = client.post("/v1/agent/run", json={"prompt": "build it", "mode": "agent"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["mode"] == "agent"
    assert body["runId"]


def test_agent_run_rejects_invalid_mode(client: TestClient) -> None:
    resp = client.post("/v1/agent/run", json={"prompt": "x", "mode": "bogus"})
    assert resp.status_code == 422


def test_decision_acknowledged_for_known_run(client: TestClient) -> None:
    run_id = client.post(
        "/v1/agent/run", json={"prompt": "build", "mode": "agent"}
    ).json()["runId"]
    resp = client.post(
        "/v1/agent/decision",
        json={"runId": run_id, "kind": "approval", "decision": "approve"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body == {
        "runId": run_id,
        "kind": "approval",
        "decision": "approve",
        "accepted": True,
    }


def test_decision_budget_continuation_for_known_run(client: TestClient) -> None:
    run_id = client.post(
        "/v1/agent/run", json={"prompt": "build", "mode": "agent"}
    ).json()["runId"]
    resp = client.post(
        "/v1/agent/decision",
        json={"runId": run_id, "kind": "budget-continuation", "decision": "continue"},
    )
    assert resp.status_code == 200
    assert resp.json()["decision"] == "continue"


def test_decision_unknown_run_is_404(client: TestClient) -> None:
    resp = client.post(
        "/v1/agent/decision",
        json={"runId": "does-not-exist", "kind": "approval", "decision": "reject"},
    )
    assert resp.status_code == 404


def test_events_endpoint_is_event_stream(client: TestClient) -> None:
    with client.stream("GET", "/v1/agent/events") as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        # Minimal generator (no run): a single ping frame then close.
        body = "".join(resp.iter_text())
    assert "event: ping" in body


def test_terminal_spawn_and_stream(client: TestClient) -> None:
    resp = client.post(
        "/v1/terminal",
        json={"cmd": "/bin/sh", "args": ["-lc", "printf hi"]},
    )
    assert resp.status_code == 201
    terminal_id = resp.json()["id"]
    with client.stream("GET", f"/v1/terminal/{terminal_id}/stream") as stream:
        assert stream.status_code == 200
        body = "".join(stream.iter_text())
    assert "hi" in body
    assert '"type": "exit"' in body


def test_run_has_emit_gate_feeding_its_queue() -> None:
    # The per-run emit gate (task 7.2) is the only producer on the run queue:
    # conforming events are enqueued in order, non-conforming ones are dropped
    # with a violation, and the stream (queue) stays usable.
    from zocai_gateway.app import RunRegistry
    from zocai_gateway.mode_router import AgentRunRequest, ModeRouter

    registry = RunRegistry()
    run = registry.create(ModeRouter().route(AgentRunRequest(prompt="go", mode="agent")))

    assert run.emit_gate.emit(
        {
            "type": "intent",
            "seq": 0,
            "runId": run.run_id,
            "ts": "t",
            "text": "x",
            "modelTier": "cloud",
            "contextWindowTokens": 128000,
        }
    ) is True
    assert run.emit_gate.emit({"type": "garbage"}) is False
    assert run.emit_gate.emit(
        {"type": "done", "seq": 1, "runId": run.run_id, "ts": "t", "ok": True}
    ) is True
    run.close()

    drained: list[dict[str, object] | None] = []
    while not run.queue.empty():
        drained.append(run.queue.get_nowait())

    # Only the two conforming events reached the queue, in production order,
    # followed by the close sentinel; the violation was recorded, not enqueued.
    assert [d["type"] for d in drained if d is not None] == ["intent", "done"]
    assert drained[-1] is None
    assert len(run.emit_gate.violations) == 1
    assert run.emit_gate.violations[0].event_type == "garbage"
