"""Tests for the MCP config port + Default_Config (Part 4, R1, R17)."""

from __future__ import annotations

import json
import sys

from hypothesis import given, settings
from hypothesis import strategies as st
from zocai_gateway.context.mcp_host.mcp_config import (
    DEFAULT_CONFIG,
    build_mcp_config,
    detect_transport,
    eligible_to_start,
    normalize_server,
    parse_config,
)

_ids = st.sampled_from(["srv-a", "srv-b", "srv-c", "srv-d"])
_tool = st.text(st.characters(min_codepoint=97, max_codepoint=122), min_size=1, max_size=6)


def _valid_stdio() -> st.SearchStrategy[dict[str, object]]:
    return st.fixed_dictionaries(
        {"command": st.text(min_size=1, max_size=8)},
        optional={
            "args": st.lists(st.text(max_size=5), max_size=3),
            "autoApprove": st.lists(_tool, max_size=3),
            "disabled": st.booleans(),
        },
    )


def _doc(mcp_servers: dict[str, object]) -> str:
    return json.dumps({"mcpServers": mcp_servers})


# Feature: mcp-host-and-servers, Property 1: Config merge precedence and scope
@settings(max_examples=150)
@given(
    user_map=st.dictionaries(_ids, _valid_stdio(), max_size=4),
    workspace_map=st.dictionaries(_ids, _valid_stdio(), max_size=4),
)
def test_merge_precedence_and_scope(
    user_map: dict[str, object], workspace_map: dict[str, object]
) -> None:
    """Validates: Requirements 1.1, 1.2, 1.4, 1.7, 1.11."""
    user_text, ws_text = _doc(user_map), _doc(workspace_map)
    built = build_mcp_config((), user_text, ws_text)

    user_defs = {d.id: d for d in parse_config(user_text, "user")}
    ws_defs = {d.id: d for d in parse_config(ws_text, "workspace")}

    assert set(built) == set(user_defs) | set(ws_defs)
    for sid, definition in built.items():
        if sid in ws_defs:
            # Workspace replaces the complete user definition (no field blend).
            assert definition == ws_defs[sid]
            assert definition.scope == "workspace"
        else:
            assert definition == user_defs[sid]
            assert definition.scope == "user"
    # Recomputing from the same documents (reload) is deterministic.
    assert build_mcp_config((), user_text, ws_text) == built


def _mixed_entry() -> st.SearchStrategy[tuple[str, object]]:
    return st.one_of(
        _valid_stdio().map(lambda r: ("valid", r)),
        st.fixed_dictionaries({"url": st.text(min_size=1, max_size=8), "type": st.just("sse")}).map(
            lambda r: ("valid", r)
        ),
        st.just(("invalid", {"command": ""})),  # stdio, empty command
        st.just(("invalid", {"args": ["x"]})),  # stdio, no command
        st.just(("invalid", {"type": "sse"})),  # sse, no url
        st.just(("invalid", 5)),  # non-object raw
    )


# Feature: mcp-host-and-servers, Property 2: Config validity filtering
@settings(max_examples=150)
@given(entries=st.dictionaries(_ids, _mixed_entry(), max_size=4))
def test_validity_filtering(entries: dict[str, tuple[str, object]]) -> None:
    """Validates: Requirements 1.8, 1.9, 1.10."""
    raw_map = {sid: raw for sid, (_, raw) in entries.items()}
    expected_valid = {sid for sid, (kind, _) in entries.items() if kind == "valid"}
    parsed = {d.id for d in parse_config(_doc(raw_map), "workspace")}
    assert parsed == expected_valid


def test_zero_yield_documents_produce_empty_config() -> None:
    assert parse_config("", "user") == []
    assert parse_config("not json", "user") == []
    assert parse_config("{}", "user") == []
    assert parse_config('{"mcpServers": 5}', "user") == []
    assert parse_config('{"mcpServers": {}}', "user") == []
    # JSONC comments are stripped before parsing.
    assert parse_config('{"mcpServers": {}} // trailing comment', "user") == []


# Feature: mcp-host-and-servers, Property 3: Disabled definitions are retained but never started
@settings(max_examples=150)
@given(
    entries=st.dictionaries(
        _ids,
        st.one_of(
            _valid_stdio(),
            st.fixed_dictionaries({"url": st.text(min_size=1, max_size=6), "type": st.just("sse")}),
        ),
        max_size=4,
    )
)
def test_disabled_retained_never_started(entries: dict[str, object]) -> None:
    """Validates: Requirements 1.5, 1.6."""
    built = build_mcp_config((), None, _doc(entries))
    eligible = {d.id for d in eligible_to_start(built)}
    for sid, definition in built.items():
        if definition.disabled or definition.transport != "stdio":
            assert sid not in eligible
        else:
            assert sid in eligible


def test_detect_transport_rules() -> None:
    assert detect_transport({"command": "x"}) == "stdio"
    assert detect_transport({"url": "u"}) == "sse"
    assert detect_transport({"type": "http", "url": "u"}) == "http"
    assert detect_transport({"transport": "streamable-http", "url": "u"}) == "http"
    assert detect_transport({"transport": "stdio", "url": "u"}) == "stdio"  # explicit wins
    assert detect_transport({}) == "stdio"


def test_normalize_server_validity() -> None:
    assert normalize_server("a", {"command": "run"}, "user") is not None
    assert normalize_server("a", {"command": ""}, "user") is None
    assert normalize_server("a", {"type": "sse"}, "user") is None
    ws = normalize_server("a", {"url": "http://x", "type": "http"}, "workspace")
    assert ws is not None and ws.transport == "http" and ws.url == "http://x"


def test_default_config_shape() -> None:
    by_id = {d.id: d for d in DEFAULT_CONFIG}
    assert set(by_id) == {"web-search", "docs", "git-history"}
    assert "filesystem" not in by_id  # R17.8: no filesystem MCP server
    for definition in DEFAULT_CONFIG:
        assert definition.transport == "stdio"
        assert definition.disabled is False
        assert definition.command == sys.executable
        assert definition.args[0] == "-m"
        assert definition.args[1].startswith("mcp_servers.")
    assert by_id["web-search"].auto_approve == ("web_search",)
    assert by_id["docs"].auto_approve == ("fetch_docs", "search_npm", "search_pypi")
    assert by_id["git-history"].auto_approve == ("git_log", "git_blame", "git_show")
