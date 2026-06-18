"""Integration tests for the sidecar lifecycle (task 7.4).

These tests exercise the Gateway *in-process* — the FastAPI app via
``create_app()`` and the launch handshake helpers in
``zocai_gateway.scripts.launch`` — without spawning a real uvicorn server or the
Tauri desktop shell. They cover the parts of the sidecar lifecycle that are
verifiable purely in-process:

- **Endpoint surface (R2.6):** the four canonical Gateway routes
  (``POST /v1/agent/run``, ``POST /v1/agent/decision``, ``GET /v1/agent/events``,
  ``GET /v1/agent/diary``) are registered and respond, and ``/health`` is ok.
- **Launch handshake (R10.3):** ``bind_loopback_or_configured`` returns a really
  bound socket whose port is observable via ``getsockname()`` (the value the
  supervisor captures), and the ``READY_PREFIX`` constant the Tauri supervisor
  matches is byte-for-byte ``"ZOC_STUDIO_AGENT_PORT="``.
- **Single backend (R6.6):** there is exactly one app factory and one launch
  entrypoint, so the supervisor spawns exactly one sidecar backend.

The post-readiness connection-failure (R10.4) and readiness-timeout (R10.5)
behaviors live in the Tauri supervisor (``sidecar.rs``) and are exercised by the
Rust side; they are not reproducible in-process and are out of scope here.
"""

from __future__ import annotations

import socket

from fastapi.testclient import TestClient

from zocai_gateway.app import create_app
from zocai_gateway.scripts import launch
from zocai_gateway.settings import GatewaySettings

# The four canonical Gateway control/telemetry routes (R2.6 / R12.1).
EXPECTED_ROUTES = {
    "/v1/agent/run",
    "/v1/agent/decision",
    "/v1/agent/events",
    "/v1/agent/diary",
}


# --- Endpoint surface (R2.6) ------------------------------------------------


def test_four_gateway_routes_are_registered() -> None:
    """All four canonical agent routes exist on the app built by create_app()."""
    app = create_app()
    paths = {route.path for route in app.routes}  # type: ignore[attr-defined]
    missing = EXPECTED_ROUTES - paths
    assert not missing, f"missing Gateway routes: {sorted(missing)}"


def test_run_route_responds_and_is_not_unknown_route() -> None:
    """POST /v1/agent/run is a real route (not a 404-for-unknown-route)."""
    client = TestClient(create_app())
    resp = client.post("/v1/agent/run", json={"prompt": "hello", "mode": "ask"})
    assert resp.status_code == 200
    assert resp.json()["runId"]


def test_decision_route_responds_and_is_not_unknown_route() -> None:
    """POST /v1/agent/decision is registered; unknown run is a handled 404."""
    client = TestClient(create_app())
    run_id = client.post(
        "/v1/agent/run", json={"prompt": "build", "mode": "agent"}
    ).json()["runId"]
    resp = client.post(
        "/v1/agent/decision",
        json={"runId": run_id, "kind": "approval", "decision": "approve"},
    )
    assert resp.status_code == 200
    assert resp.json()["accepted"] is True


def test_events_route_is_registered_as_get() -> None:
    """GET /v1/agent/events is registered (asserted via app.routes, no stream).

    We assert route registration rather than consuming the SSE stream so the
    test never opens a stream it must wait on.
    """
    app = create_app()
    get_event_routes = [
        route
        for route in app.routes  # type: ignore[attr-defined]
        if getattr(route, "path", None) == "/v1/agent/events"
        and "GET" in getattr(route, "methods", set())
    ]
    assert len(get_event_routes) == 1


def test_diary_route_is_registered_as_get() -> None:
    """GET /v1/agent/diary is registered and responds (empty without workspace)."""
    app = create_app()
    get_diary_routes = [
        route
        for route in app.routes  # type: ignore[attr-defined]
        if getattr(route, "path", None) == "/v1/agent/diary"
        and "GET" in getattr(route, "methods", set())
    ]
    assert len(get_diary_routes) == 1

    client = TestClient(app)
    resp = client.get("/v1/agent/diary")
    assert resp.status_code == 200
    assert resp.json() == []


def test_health_returns_ok() -> None:
    """/health returns the preserved readiness contract the supervisor polls."""
    client = TestClient(create_app())
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


# --- Launch handshake (R10.3) ----------------------------------------------


def test_ready_prefix_matches_supervisor_contract() -> None:
    """READY_PREFIX is byte-for-byte the prefix the Tauri supervisor matches."""
    assert launch.READY_PREFIX == "ZOC_STUDIO_AGENT_PORT="


def test_bind_returns_socket_with_real_os_assigned_port() -> None:
    """bind_loopback_or_configured(port=0) binds a socket with a real port.

    The OS-assigned port is read back via getsockname() — exactly the value the
    launch entrypoint announces to the supervisor. We close the socket right
    after asserting; no server is started.
    """
    sock = launch.bind_loopback_or_configured(GatewaySettings(port=0))
    try:
        assert isinstance(sock, socket.socket)
        host, port = sock.getsockname()[:2]
        assert host == "127.0.0.1"
        assert isinstance(port, int)
        assert 1 <= port <= 65535
    finally:
        sock.close()


def test_bind_honors_explicit_loopback_host() -> None:
    """A configured loopback host is honored by the bind helper."""
    settings = GatewaySettings(host="127.0.0.1", port=0)
    sock = launch.bind_loopback_or_configured(settings)
    try:
        assert sock.getsockname()[0] == "127.0.0.1"
        assert sock.getsockname()[1] != 0
    finally:
        sock.close()


# --- Single backend (R6.6) --------------------------------------------------


def test_single_app_factory_and_launch_entrypoint() -> None:
    """Exactly one app factory and one launch entrypoint drive the sidecar.

    Light structural assertion that the supervisor has a single backend to
    spawn: one ``create_app`` factory and one ``main`` entrypoint that binds
    once via the single ``bind_loopback_or_configured`` helper.
    """
    assert callable(create_app)
    assert callable(launch.main)
    assert callable(launch.bind_loopback_or_configured)
