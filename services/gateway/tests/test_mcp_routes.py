"""Tests for the admitted MCP control routes (Part 4, R10, R11, R13)."""

from __future__ import annotations

import json

from fastapi import FastAPI
from fastapi.testclient import TestClient
from hypothesis import assume, given, settings
from hypothesis import strategies as st
from zocai_gateway.app import create_app
from zocai_gateway.auth import STATE_SETTINGS_KEY
from zocai_gateway.context.mcp_host.models import TestValidationFailure as ValidationFailureOutcome
from zocai_gateway.routes.mcp import create_mcp_router
from zocai_gateway.settings import GatewaySettings


class _SpyHost:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def servers(self) -> list[dict[str, object]]:
        self.calls.append("servers")
        return []

    async def reload(self) -> list[dict[str, object]]:
        self.calls.append("reload")
        return []

    async def test_candidate(self, candidate: dict[str, object]) -> ValidationFailureOutcome:
        self.calls.append("test")
        return ValidationFailureOutcome(reason="spy")


def _bare_app(settings_obj: GatewaySettings, host: _SpyHost) -> FastAPI:
    app = FastAPI()
    setattr(app.state, STATE_SETTINGS_KEY, settings_obj)

    async def _resolve() -> _SpyHost:
        return host

    app.include_router(create_mcp_router(_resolve))  # type: ignore[arg-type]
    return app


_ENDPOINTS = [
    ("GET", "/v1/mcp/servers", None),
    ("POST", "/v1/mcp/reload", None),
    ("POST", "/v1/mcp/test", {"id": "x", "command": "c"}),
]


# Feature: mcp-host-and-servers, Property 23: Rejected admission has no side effect
@settings(max_examples=100)
@given(
    endpoint=st.sampled_from(_ENDPOINTS),
    token=st.one_of(
        st.none(), st.text(st.characters(min_codepoint=33, max_codepoint=126), max_size=8)
    ),
)
def test_rejected_admission_has_no_side_effect(
    endpoint: tuple[str, str, dict[str, object] | None], token: str | None
) -> None:
    """Validates: Requirements 10.3."""
    assume(token != "secret")  # anything but the configured token must be rejected
    spy = _SpyHost()
    non_loopback = GatewaySettings(host="0.0.0.0", port=0, auth_token="secret")
    client = TestClient(_bare_app(non_loopback, spy))
    method, url, body = endpoint
    headers = {"X-Zoc-Studio-Token": token} if token else {}
    resp = client.request(method, url, json=body, headers=headers)
    assert resp.status_code == 401
    assert spy.calls == []  # handler never ran → no config/session/status/toolset side effect


def test_servers_admitted_on_loopback(tmp_path) -> None:
    # A workspace is now required for a real MCP host: servers are pinned to the
    # workspace root, so the host lives in the WorkspaceScope (no /nonexistent
    # sentinel). With a bound workspace the bundled servers are configured.
    with TestClient(create_app(workspace_root=tmp_path)) as client:  # loopback admits
        resp = client.get("/v1/mcp/servers")
    assert resp.status_code == 200
    servers = {s["id"]: s for s in resp.json()["servers"]}
    assert {"web-search", "docs", "git-history"} <= set(servers)
    # start_mcp defaults False, so bundled servers are configured but not started.
    assert all(s["status"] == "stopped" for s in servers.values())


def test_servers_returns_empty_without_workspace() -> None:
    """With no workspace open, /servers answers honestly empty — no sentinel host."""
    with TestClient(create_app()) as client:  # conftest isolates → no workspace
        resp = client.get("/v1/mcp/servers")
    assert resp.status_code == 200
    assert resp.json() == {"servers": []}


def test_reload_and_test_refuse_without_workspace() -> None:
    """Mutating MCP routes return a typed no_workspace 409 with no workspace open."""
    with TestClient(create_app()) as client:
        reload_resp = client.post("/v1/mcp/reload")
        test_resp = client.post("/v1/mcp/test", json={"id": "x", "command": "c"})
    for resp in (reload_resp, test_resp):
        assert resp.status_code == 409
        assert resp.json()["detail"]["code"] == "no_workspace"


def test_test_endpoint_invalid_and_unsupported(tmp_path) -> None:
    with TestClient(create_app(workspace_root=tmp_path)) as client:
        invalid = client.post("/v1/mcp/test", json={"id": "x"})  # no command → invalid
        unsupported = client.post(
            "/v1/mcp/test", json={"id": "y", "url": "http://x", "type": "sse"}
        )
    assert invalid.status_code == 200
    assert invalid.json()["outcome"] == "validation-failure"
    assert unsupported.json()["outcome"] == "unsupported"


def test_servers_route_exposes_complete_merged_user_and_workspace_config(tmp_path) -> None:
    user_path = tmp_path / "user-mcp.json"
    user_path.write_text(
        json.dumps(
            {
                "mcpServers": {
                    "shared": {"command": "from-user", "args": ["u"]},
                    "user-only": {"url": "https://example.test/sse", "type": "sse"},
                }
            }
        ),
        encoding="utf-8",
    )
    config_dir = tmp_path / ".zoc"
    config_dir.mkdir()
    (config_dir / "mcp.json").write_text(
        json.dumps(
            {
                "mcpServers": {
                    "shared": {
                        "command": "from-workspace",
                        "args": ["one", "two words"],
                        "env": {"TOKEN": "value"},
                        "disabled": True,
                    }
                }
            }
        ),
        encoding="utf-8",
    )

    with TestClient(create_app(workspace_root=tmp_path, mcp_user_config_path=user_path)) as client:
        response = client.get("/v1/mcp/servers")

    assert response.status_code == 200
    servers = {server["id"]: server for server in response.json()["servers"]}
    assert servers["shared"] == {
        "id": "shared",
        "transport": "stdio",
        "scope": "workspace",
        "command": "from-workspace",
        "args": ["one", "two words"],
        "env": {"TOKEN": "value"},
        "url": None,
        "disabled": True,
        "autoApprove": [],
        "status": "stopped",
        "errorReason": None,
    }
    assert servers["user-only"]["scope"] == "user"
    assert servers["user-only"]["url"] == "https://example.test/sse"
