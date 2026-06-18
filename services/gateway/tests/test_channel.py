"""Unit + property tests for mode-scoped channel discipline (task 7.3).

These tests pin the two mirror-image disciplines from R6.6/R6.7 and the
suppression-iff-Ask invariant from R2.7:

- Agent Mode admits structured rows (through the contract gate) and rejects raw
  text token chunks; it never suppresses planning/to-do/tool-activity rows.
- Ask Mode admits raw text token chunks and suppresses every structured row,
  including the planning/to-do/tool-activity kinds R2.7 names.
- Suppression is active iff Ask Mode is active, as a pure function of the mode
  with no carry-over between runs.
"""

from __future__ import annotations

from collections.abc import Mapping

from hypothesis import given
from hypothesis import strategies as st
from shared_schema.agent_events import (
    DoneEvent,
    IntentEvent,
    ThinkingEvent,
)

from zocai_gateway.channel import (
    SUPPRESSED_IN_ASK_ROW_TYPES,
    AgentChannel,
    AskChannel,
    channel_for,
    suppresses_structured_rows,
)
from zocai_gateway.emit_gate import EmitGate
from zocai_gateway.mode_router import (
    AgentPath,
    AgentRunRequest,
    AskPath,
    Mode,
    ModeRouter,
)

# The eight contract row kinds (R6.3).
_ALL_ROW_TYPES = (
    "intent",
    "thinking",
    "read-files",
    "edit-file",
    "command",
    "summary",
    "approval",
    "done",
)


class _RecordingSink:
    """Captures wire events forwarded by the structured emit gate."""

    def __init__(self) -> None:
        self.events: list[Mapping[str, object]] = []

    def __call__(self, event: Mapping[str, object]) -> None:
        self.events.append(event)


class _RecordingText:
    """Captures raw text token chunks written to the Ask channel."""

    def __init__(self) -> None:
        self.chunks: list[str] = []

    def __call__(self, chunk: str) -> None:
        self.chunks.append(chunk)


def _intent_payload(seq: int = 0, run_id: str = "r1") -> dict[str, object]:
    return {
        "type": "intent",
        "seq": seq,
        "runId": run_id,
        "ts": "2024-01-01T00:00:00Z",
        "text": "do the thing",
        "modelTier": "local-slm",
        "contextWindowTokens": 4096,
    }


# ── Agent Mode: structured-only (R6.7) ──────────────────────────────────────

def test_agent_channel_admits_structured_rows_r6_7() -> None:
    sink = _RecordingSink()
    channel = AgentChannel(EmitGate(sink=sink))

    assert channel.emit_event(_intent_payload()) is True
    assert len(sink.events) == 1
    assert sink.events[0]["type"] == "intent"


def test_agent_channel_rejects_raw_text_r6_7() -> None:
    sink = _RecordingSink()
    channel = AgentChannel(EmitGate(sink=sink))

    assert channel.emit_text("hello") is False
    # Raw text never reaches any structured sink.
    assert sink.events == []


def test_agent_channel_does_not_suppress_structured_rows_r2_7() -> None:
    channel = AgentChannel(EmitGate(sink=_RecordingSink()))
    assert channel.suppresses_structured_rows is False


def test_agent_channel_emits_planning_todo_and_tool_rows() -> None:
    # Every R2.7-named row kind flows freely in Agent Mode.
    sink = _RecordingSink()
    channel = AgentChannel(EmitGate(sink=sink))

    assert channel.emit_event(_intent_payload(seq=0)) is True  # planning
    assert (
        channel.emit_event(
            ThinkingEvent(seq=1, run_id="r1", ts="t", text="reason").model_dump()
        )
        is True
    )  # planning
    assert (
        channel.emit_event(
            {"type": "summary", "seq": 2, "runId": "r1", "ts": "t", "text": "todo"}
        )
        is True
    )  # to-do
    assert (
        channel.emit_event(
            {"type": "command", "seq": 3, "runId": "r1", "ts": "t", "command": "ls"}
        )
        is True
    )  # tool activity
    assert [e["type"] for e in sink.events] == [
        "intent",
        "thinking",
        "summary",
        "command",
    ]


# ── Ask Mode: text-only (R6.6, R2.7) ────────────────────────────────────────

def test_ask_channel_admits_raw_text_r6_6() -> None:
    text = _RecordingText()
    channel = AskChannel(text)

    assert channel.emit_text("# Heading\n") is True
    assert channel.emit_text("body") is True
    assert text.chunks == ["# Heading\n", "body"]


def test_ask_channel_suppresses_structured_rows_r6_6() -> None:
    text = _RecordingText()
    channel = AskChannel(text)

    assert channel.emit_event(_intent_payload()) is False
    assert channel.emit_event(DoneEvent(seq=1, run_id="r1", ts="t", ok=True).model_dump()) is False
    # No structured row produced any text output.
    assert text.chunks == []
    assert channel.suppressed == ("intent", "done")


def test_ask_channel_suppresses_planning_todo_and_tool_rows_r2_7() -> None:
    channel = AskChannel(_RecordingText())

    for row_type in SUPPRESSED_IN_ASK_ROW_TYPES:
        assert channel.emit_event({"type": row_type}) is False

    assert set(channel.suppressed) == SUPPRESSED_IN_ASK_ROW_TYPES


def test_ask_channel_reports_suppression_active_r2_7() -> None:
    assert AskChannel(_RecordingText()).suppresses_structured_rows is True


def test_ask_channel_records_none_type_for_untyped_payload() -> None:
    channel = AskChannel(_RecordingText())
    assert channel.emit_event({"seq": 0}) is False
    assert channel.suppressed == (None,)


# ── Suppression iff Ask, no carry-over (R2.7) ───────────────────────────────

def test_suppression_predicate_is_iff_ask() -> None:
    assert suppresses_structured_rows(Mode.ASK) is True
    assert suppresses_structured_rows(Mode.AGENT) is False


def test_suppression_predicate_matches_channel_flag() -> None:
    text = _RecordingText()
    assert AskChannel(text).suppresses_structured_rows == suppresses_structured_rows(
        Mode.ASK
    )
    assert AgentChannel(
        EmitGate(sink=_RecordingSink())
    ).suppresses_structured_rows == suppresses_structured_rows(Mode.AGENT)


def test_no_carry_over_between_runs_r2_7() -> None:
    # An Ask run suppresses; a subsequent Agent run does not — suppression is a
    # function of the current mode alone, never a sticky flag.
    ask = AskChannel(_RecordingText())
    assert ask.suppresses_structured_rows is True
    assert ask.emit_event(_intent_payload()) is False

    agent = AgentChannel(EmitGate(sink=_RecordingSink()))
    assert agent.suppresses_structured_rows is False
    assert agent.emit_event(_intent_payload()) is True


# ── channel_for factory wiring on the execution paths ───────────────────────

def test_channel_for_ask_path_is_text_only() -> None:
    text = _RecordingText()
    channel = channel_for(AskPath(), gate=EmitGate(sink=_RecordingSink()), text_sink=text)

    assert isinstance(channel, AskChannel)
    assert channel.emit_text("hi") is True
    assert channel.emit_event(_intent_payload()) is False
    assert text.chunks == ["hi"]


def test_channel_for_agent_path_is_structured_only() -> None:
    sink = _RecordingSink()
    channel = channel_for(AgentPath(), gate=EmitGate(sink=sink), text_sink=_RecordingText())

    assert isinstance(channel, AgentChannel)
    assert channel.emit_event(_intent_payload()) is True
    assert channel.emit_text("hi") is False
    assert len(sink.events) == 1


def test_channel_for_matches_routed_path_mode() -> None:
    router = ModeRouter()
    for mode in (Mode.ASK, Mode.AGENT):
        path = router.route(AgentRunRequest(prompt="p", mode=mode))
        channel = channel_for(
            path, gate=EmitGate(sink=_RecordingSink()), text_sink=_RecordingText()
        )
        assert channel.mode is mode
        assert channel.suppresses_structured_rows is suppresses_structured_rows(mode)


# ── Property: clean partition + suppression iff Ask, over all row kinds ──────

@given(
    row_types=st.lists(st.sampled_from(_ALL_ROW_TYPES), max_size=12),
    texts=st.lists(st.text(max_size=20), max_size=12),
)
def test_property_agent_structured_only_ask_text_only(
    row_types: list[str], texts: list[str]
) -> None:
    """The two channels form a clean partition for any interleaving of inputs.

    Validates: Requirements 6.6, 6.7, 2.7
    """
    # Agent Mode: structured rows admitted (gate may still reject bare types,
    # but they are never *suppressed*), raw text always rejected.
    agent = AgentChannel(EmitGate(sink=_RecordingSink()))
    assert agent.suppresses_structured_rows is False
    for chunk in texts:
        assert agent.emit_text(chunk) is False

    # Ask Mode: every structured row suppressed, every raw chunk admitted.
    ask_text = _RecordingText()
    ask = AskChannel(ask_text)
    assert ask.suppresses_structured_rows is True
    for row_type in row_types:
        assert ask.emit_event({"type": row_type}) is False
    for chunk in texts:
        assert ask.emit_text(chunk) is True

    # Ask never emitted a structured row; Ask emitted exactly the text chunks.
    assert list(ask.suppressed) == row_types
    assert ask_text.chunks == texts
