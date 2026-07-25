"""Default_Config registration, auto-approval, and fixed-tool coexistence (R17, R10.5)."""

from __future__ import annotations

import asyncio
import sys

from shared_schema.agent_events import ApprovalEvent
from zocai_gateway.context.mcp_host.host import MCPHost
from zocai_gateway.context.mcp_host.mcp_config import DEFAULT_CONFIG
from zocai_gateway.context.mcp_host.models import RawTool, ToolCallSuccess
from zocai_gateway.context.mcp_host.registry import McpToolRegistry, namespaced_name

_BUNDLED_TOOLS = {
    "web-search": ("web_search",),
    "docs": ("fetch_docs", "search_npm", "search_pypi"),
    "git-history": ("git_log", "git_blame", "git_show"),
}


class _FakeSession:
    def __init__(self, tools: tuple[str, ...]) -> None:
        self._tools = tools
        self.closed = False

    async def start(self) -> None:
        return None

    async def initialize(self, timeout: float) -> None:
        return None

    async def list_tools(self, timeout: float) -> list[RawTool]:
        return [RawTool(name=name) for name in self._tools]

    async def call_tool(self, bare_name, arguments, timeout):  # type: ignore[no-untyped-def]
        return {"result": {"ok": True}}

    async def aclose(self) -> None:
        self.closed = True


async def _never() -> str:
    raise AssertionError("auto-approved tools must not request approval")


def test_default_config_registration_autoapprove_and_coexistence() -> None:
    registry = McpToolRegistry()
    host = MCPHost(
        default_config=DEFAULT_CONFIG,
        registry=registry,
        session_factory=lambda d: _FakeSession(_BUNDLED_TOOLS[d.id]),  # type: ignore[arg-type]
    )
    asyncio.run(host.load())

    servers = {s["id"]: s for s in host.servers()}
    assert set(servers) == {"web-search", "docs", "git-history"}  # exactly the three (R17.1)
    assert all(s["status"] == "running" for s in servers.values())  # enabled + started
    assert "filesystem" not in servers  # R17.8: no filesystem MCP server

    # All bundled tools are aggregated under their servers.
    aggregated = {r.bare_name for r in registry.list()}
    assert aggregated == {
        "web_search",
        "fetch_docs",
        "search_npm",
        "search_pypi",
        "git_log",
        "git_blame",
        "git_show",
    }

    # Each bundled tool is auto-approved: proxying it emits no ApprovalEvent and
    # never asks for a decision (R17.2-R17.4).
    for server_id, tools in _BUNDLED_TOOLS.items():
        for tool in tools:
            events: list[object] = []
            outcome = asyncio.run(
                host.proxy_tool_call(
                    namespaced_name(server_id, tool),
                    {},
                    run_id="r",
                    emit=events.append,  # type: ignore[arg-type]
                    await_decision=_never,
                )
            )
            assert isinstance(outcome, ToolCallSuccess)
            assert not any(isinstance(e, ApprovalEvent) for e in events)

    # Coexistence (R10.5/R5.6): the generic surface never shadows the fixed
    # MCPGateway tool names (which live in a separate registry).
    generic_names = {r.namespaced_name for r in registry.list()}
    assert "mcp::web::search" not in generic_names
    assert "mcp::github" not in generic_names


def test_default_config_servers_start_as_real_stdio_children(tmp_path) -> None:
    async def run() -> None:
        host = MCPHost(workspace_root=tmp_path, registry=McpToolRegistry())
        try:
            await host.load()
            servers = {server["id"]: server for server in host.servers()}
            assert {server_id: server["status"] for server_id, server in servers.items()} == {
                "docs": "running",
                "git-history": "running",
                "web-search": "running",
            }
            assert servers["docs"]["command"] == sys.executable
            assert servers["docs"]["args"][:1] == ["-m"]
            assert {record.bare_name for record in host.registry.list()} == {
                "web_search",
                "fetch_docs",
                "search_npm",
                "search_pypi",
                "git_log",
                "git_blame",
                "git_show",
            }
        finally:
            await host.aclose()

    asyncio.run(run())
