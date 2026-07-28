"""Live local-model readiness probe at run start (zoc-ai-agent-chat-overhaul, task 7).

The structural readiness gate (`model_runtime.readiness`) refuses a request that
names no serving endpoint. On top of that, a locally-served llama.cpp endpoint
gets a *live* bounded ``/health`` probe before a run record is created, so a
server that is down or still loading (503) rejects the run **before**
``registry.create`` — while cloud providers keep the structural check and an
injected test brain skips the probe entirely.

**Validates: Requirements 5.2**
"""

from __future__ import annotations

from fastapi.testclient import TestClient
from zocai_gateway.app import create_app
from zocai_gateway.errors import ErrorCode
from zocai_gateway.model_runtime import probe_local_health
from zocai_gateway.run_pipeline import DefaultAgentBrain

_LOCAL = "http://127.0.0.1:8080"


def _ask(provider: str, base_url: str) -> dict[str, object]:
    return {
        "prompt": "explain",
        "mode": "ask",
        "provider": provider,
        "model": "qwen2.5-coder",
        "baseUrl": base_url,
    }


def test_unreachable_local_endpoint_rejects_before_registry_create() -> None:
    """A local 503/unreachable endpoint refuses the run and creates no record."""
    app = create_app(drive=False, model_health_probe=lambda _base: False)
    client = TestClient(app)
    registry = app.state.run_registry
    before = registry.count()

    resp = client.post("/v1/agent/run", json=_ask("llamacpp", _LOCAL))

    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == ErrorCode.MODEL_NOT_READY
    # No secret/host leak in the message; registry untouched (gate ran first).
    assert registry.count() == before


def test_healthy_local_endpoint_admits_the_run() -> None:
    """A healthy local endpoint passes the live probe and starts the run."""
    app = create_app(drive=False, model_health_probe=lambda _base: True)
    client = TestClient(app)

    resp = client.post("/v1/agent/run", json=_ask("llamacpp", _LOCAL))

    assert resp.status_code == 200
    assert resp.json()["runId"]


def test_cloud_provider_is_not_probed() -> None:
    """Cloud providers keep the structural check — the live probe never runs."""
    calls: list[str] = []

    def _probe(base_url: str) -> bool:
        calls.append(base_url)
        return False  # would reject if (wrongly) consulted for a cloud provider

    app = create_app(drive=False, model_health_probe=_probe)
    client = TestClient(app)

    resp = client.post("/v1/agent/run", json=_ask("openai", "https://api.openai.test/v1"))

    assert resp.status_code == 200  # structurally ready; cloud not probed
    assert calls == []


def test_injected_brain_skips_the_probe() -> None:
    """An injected test brain is a deterministic double and skips the live gate."""

    def _probe(_base: str) -> bool:
        raise AssertionError("probe must not run when a brain is injected")

    app = create_app(drive=False, brain=DefaultAgentBrain(), model_health_probe=_probe)
    client = TestClient(app)

    resp = client.post("/v1/agent/run", json=_ask("llamacpp", _LOCAL))

    assert resp.status_code == 200


def test_probe_local_health_unreachable_is_false() -> None:
    """The real probe returns False for an unreachable endpoint (never raises)."""
    # Nothing is listening on this port; the bounded probe fails fast.
    assert probe_local_health("http://127.0.0.1:1/", timeout=0.25) is False


def test_probe_local_health_empty_base_url_is_false() -> None:
    assert probe_local_health("", timeout=0.25) is False
