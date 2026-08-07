"""Tests for the additive MCP seam on FullToolset (Part 4, R5)."""

from __future__ import annotations

import asyncio
import tempfile

from hypothesis import given, settings
from hypothesis import strategies as st
from zocai_gateway.context.mcp_host.models import (
    McpToolRecord,
    RawTool,
    ToolCallError,
    ToolCallErrorKind,
    ToolCallSuccess,
)
from zocai_gateway.context.mcp_host.registry import McpToolRegistry, namespaced_name, record_for
from zocai_gateway.toolsets import FullToolset

_server = st.text(st.characters(min_codepoint=97, max_codepoint=122), min_size=1, max_size=4)
_tool = st.text(st.characters(min_codepoint=97, max_codepoint=122), min_size=1, max_size=5)


class _RegistrySeam:
    """A minimal run-bound seam backed directly by a registry."""

    def __init__(self, registry: McpToolRegistry) -> None:
        self._registry = registry

    def list_tools(self) -> list[McpToolRecord]:
        return self._registry.list()

    async def proxy(self, namespaced: str, arguments):  # type: ignore[no-untyped-def]
        record = self._registry.get(namespaced)
        if record is None:
            return ToolCallError(None, namespaced, ToolCallErrorKind.UNAVAILABLE, "unknown")
        return ToolCallSuccess(record.server_id, record.bare_name, {"echo": dict(arguments)})


# Feature: mcp-host-and-servers, Property 14: Additive toolset exposure and synchronization
@settings(max_examples=150)
@given(servers=st.dictionaries(_server, st.lists(_tool, unique=True, max_size=4), max_size=4))
def test_additive_toolset_exposure(servers: dict[str, list[str]]) -> None:
    """Validates: Requirements 5.1, 5.2, 5.3, 5.4."""
    registry = McpToolRegistry()
    expected: set[str] = set()
    for server_id, tools in servers.items():
        registry.replace_server_tools(
            server_id,
            [record_for(server_id, RawTool(name=t, input_schema={"k": t})) for t in tools],
        )
        expected.update(namespaced_name(server_id, t) for t in tools)

    toolset = FullToolset(mcp=_RegistrySeam(registry))
    exposed = toolset.mcp_tools()
    assert {r.namespaced_name for r in exposed} == expected
    # Input schemas are preserved on the exposed records.
    for record in exposed:
        assert record.input_schema == {"k": record.bare_name}
    # Native capabilities remain present and independent of the MCP set.
    assert callable(toolset.write_file)
    assert callable(toolset.run_shell)
    assert callable(toolset.read_file)


def test_native_operations_unaffected_by_mcp() -> None:
    registry = McpToolRegistry()
    with tempfile.TemporaryDirectory() as tmp:
        toolset = FullToolset(tmp, mcp=_RegistrySeam(registry))
        toolset.write_file("note.txt", "hello")
        assert toolset.read_file("note.txt") == "hello"
        # Mutating the MCP set does not disturb native file operations.
        registry.replace_server_tools("s", [record_for("s", RawTool("x"))])
        assert toolset.read_file("note.txt") == "hello"
        assert len(toolset.mcp_tools()) == 1


def test_call_mcp_tool_without_host_is_unavailable() -> None:
    toolset = FullToolset()  # no mcp seam attached
    outcome = asyncio.run(toolset.call_mcp_tool("mcp::x::y", {}))
    assert isinstance(outcome, ToolCallError)
    assert outcome.kind is ToolCallErrorKind.UNAVAILABLE
