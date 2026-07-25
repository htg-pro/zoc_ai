"""Tests for the MCP tool registry + namespacing (Part 4, R4, R5)."""

from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st
from zocai_gateway.context.mcp_host.models import McpToolRecord, RawTool
from zocai_gateway.context.mcp_host.registry import (
    McpToolRegistry,
    namespaced_name,
    record_for,
)

# Include ':' and '\\' so the escaping (injectivity) is genuinely exercised.
_seg = st.text(alphabet="ab:\\_-", min_size=1, max_size=6)


# Feature: mcp-host-and-servers, Property 10: Namespacing collision-freedom
@settings(max_examples=200)
@given(pairs=st.lists(st.tuples(_seg, _seg), unique=True, min_size=1, max_size=10))
def test_namespacing_is_injective(pairs: list[tuple[str, str]]) -> None:
    """Validates: Requirements 4.1, 4.2."""
    names = [namespaced_name(server_id, bare) for server_id, bare in pairs]
    assert len(set(names)) == len(names)


# Feature: mcp-host-and-servers, Property 11: Tool record preservation
@settings(max_examples=200)
@given(
    server_id=_seg,
    name=st.text(min_size=1, max_size=8),
    schema=st.dictionaries(st.text(max_size=4), st.integers(), max_size=3),
    description=st.one_of(st.none(), st.text(max_size=10)),
)
def test_record_preserves_fields(
    server_id: str, name: str, schema: dict[str, int], description: str | None
) -> None:
    """Validates: Requirements 4.3."""
    record = record_for(server_id, RawTool(name=name, input_schema=schema, description=description))
    assert record.server_id == server_id
    assert record.bare_name == name
    assert record.input_schema == schema
    assert record.description == description
    assert record.namespaced_name == namespaced_name(server_id, name)


def _rec(server_id: str, bare: str) -> McpToolRecord:
    return record_for(server_id, RawTool(name=bare))


def test_registry_replace_get_list() -> None:
    reg = McpToolRegistry()
    reg.replace_server_tools("s1", [_rec("s1", "a"), _rec("s1", "b")])
    assert {r.bare_name for r in reg.list()} == {"a", "b"}
    assert reg.get(namespaced_name("s1", "a")) is not None
    assert reg.get("mcp::nope::x") is None


def test_registry_per_server_isolation() -> None:
    reg = McpToolRegistry()
    reg.replace_server_tools("s1", [_rec("s1", "shared")])
    reg.replace_server_tools("s2", [_rec("s2", "shared")])  # same bare name, distinct owner
    assert len(reg.list()) == 2
    # Replacing s1 (incl. clearing to empty) leaves s2 untouched.
    reg.replace_server_tools("s1", [])
    assert {r.server_id for r in reg.list()} == {"s2"}
    reg.remove_server_tools("s2")
    assert reg.list() == []
