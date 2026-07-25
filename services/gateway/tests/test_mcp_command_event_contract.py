"""CommandEvent mcpServerId twin-compatibility + drift guard (Part 4, R12.2-R12.4)."""

from __future__ import annotations

from pathlib import Path

from shared_schema.agent_events import AgentEventModel, CommandEvent

_TS_TWIN = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "shared-types"
    / "typescript"
    / "src"
    / "agent-events.ts"
)


def test_command_event_accepts_with_and_without_mcp_server_id() -> None:
    with_field = CommandEvent(seq=1, run_id="r", ts="t", command="mcp::s::x", mcp_server_id="s")
    assert with_field.mcp_server_id == "s"
    assert with_field.model_dump(by_alias=True)["mcpServerId"] == "s"

    omitted = AgentEventModel.model_validate(
        {"type": "command", "seq": 2, "runId": "r", "ts": "t", "command": "c"}
    )
    assert isinstance(omitted.root, CommandEvent)
    assert omitted.root.mcp_server_id is None

    via_alias = AgentEventModel.model_validate(
        {"type": "command", "seq": 3, "runId": "r", "ts": "t", "command": "c", "mcpServerId": "srv"}
    )
    assert isinstance(via_alias.root, CommandEvent)
    assert via_alias.root.mcp_server_id == "srv"


def test_typescript_twin_declares_mcp_server_id() -> None:
    assert "mcpServerId?: string | null;" in _TS_TWIN.read_text(encoding="utf-8")
