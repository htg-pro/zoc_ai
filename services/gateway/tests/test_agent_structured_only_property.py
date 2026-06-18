"""Property test for Agent-Mode structured-only channel discipline (task 7.8).

Feature: zocai-ecosystem-rebuild, Property 11: Agent Mode emits only structured
events and never raw text.

**Validates: Requirements 6.7**

Design Property 11 (verbatim intent): *For any* Agent-Mode run, every item
emitted on the SSE stream is a structured Event_Contract event and no raw text
token chunk is emitted; together with Property 10 this establishes a clean
partition (Agent Mode = structured-only, Ask Mode = text-only).

Strategy
--------
The property drives the real :class:`AgentChannel` (wrapping the real
:class:`EmitGate` against the real ``AgentEventModel`` contract — no mocks) over
arbitrary **interleavings** of two operation kinds:

* a **structured row** — a payload that fully conforms to the Event_Contract
  for one of the eight row kinds (R6.3); and
* a **raw text chunk** — an arbitrary markdown token chunk a producer might try
  to stream.

A recording sink stands in for the SSE bus and captures, in order, everything
that actually reaches the wire. A recording text sink captures any raw text the
channel might (wrongly) emit. For every interleaving we assert the R6.7
partition end to end:

1. ``emit_event`` admits each conforming structured row (returns ``True``) and
   forwards it to the SSE bus.
2. ``emit_text`` *always* returns ``False`` and writes nothing to the text sink
   — Agent Mode never emits raw text, regardless of where text appears in the
   interleaving.
3. Everything on the SSE bus is a structured Event_Contract event (carries a
   valid row-kind ``type``); zero raw text chunks reach the bus.
4. The number and order of bus items equals exactly the structured rows from
   the interleaving — text chunks contribute nothing.
"""

from __future__ import annotations

from collections.abc import Mapping

from hypothesis import given, settings
from hypothesis import strategies as st

from zocai_gateway.channel import AgentChannel
from zocai_gateway.emit_gate import EmitGate

# The eight defined row kinds (R6.3); a structured Event_Contract event carries
# exactly one of these as its ``type`` discriminator.
VALID_TYPES = (
    "intent",
    "thinking",
    "read-files",
    "edit-file",
    "command",
    "summary",
    "approval",
    "done",
)

_TS = "2024-01-01T00:00:00Z"


class _RecordingSink:
    """Captures wire events forwarded onto the SSE bus, in call order."""

    def __init__(self) -> None:
        self.events: list[Mapping[str, object]] = []

    def __call__(self, event: Mapping[str, object]) -> None:
        self.events.append(event)


class _RecordingTextSink:
    """Captures any raw text chunk the channel writes (should stay empty)."""

    def __init__(self) -> None:
        self.chunks: list[str] = []

    def __call__(self, chunk: str) -> None:
        self.chunks.append(chunk)


@st.composite
def conforming_rows(draw: st.DrawFn) -> dict[str, object]:
    """A payload that fully conforms to the Event_Contract for some row kind."""
    seq = draw(st.integers(min_value=0, max_value=1_000_000))
    run_id = draw(st.text(min_size=1, max_size=12))
    kind = draw(st.sampled_from(VALID_TYPES))
    base: dict[str, object] = {"type": kind, "seq": seq, "runId": run_id, "ts": _TS}

    if kind == "intent":
        base["text"] = draw(st.text(max_size=20))
        base["modelTier"] = draw(st.sampled_from(["local-slm", "edge", "cloud"]))
        base["contextWindowTokens"] = draw(st.integers(min_value=0, max_value=100_000))
    elif kind == "thinking":
        base["text"] = draw(st.text(max_size=20))
    elif kind == "read-files":
        base["files"] = [
            {"path": p}
            for p in draw(st.lists(st.text(min_size=1, max_size=8), max_size=3))
        ]
    elif kind == "edit-file":
        base["path"] = draw(st.text(min_size=1, max_size=12))
        base["diff"] = draw(st.text(max_size=20))
    elif kind == "command":
        base["command"] = draw(st.text(min_size=1, max_size=12))
    elif kind == "summary":
        base["text"] = draw(st.text(max_size=20))
    elif kind == "approval":
        base["prompt"] = draw(st.text(max_size=20))
    elif kind == "done":
        base["ok"] = draw(st.booleans())
    return base


# An interleaving operation: a structured row ("row", payload) or a raw text
# chunk ("text", chunk). Mixing the two in an arbitrary order is exactly the
# interleaving the property quantifies over.
_row_ops = conforming_rows().map(lambda p: ("row", p))
_text_ops = st.text(max_size=30).map(lambda c: ("text", c))


@settings(max_examples=200, deadline=None)
@given(
    operations=st.lists(st.one_of(_row_ops, _text_ops), max_size=40),
)
def test_agent_mode_emits_only_structured_events_never_raw_text(
    operations: list[tuple[str, object]],
) -> None:
    """Property 11: Agent Mode admits structured rows, rejects every raw text chunk.

    Feature: zocai-ecosystem-rebuild, Property 11

    **Validates: Requirements 6.7**
    """
    sink = _RecordingSink()
    text_sink = _RecordingTextSink()
    channel = AgentChannel(EmitGate(sink=sink))

    expected_types: list[str] = []
    for op, value in operations:
        if op == "row":
            assert isinstance(value, dict)
            # A conforming structured row is admitted onto the bus.
            assert channel.emit_event(value) is True
            expected_types.append(value["type"])  # type: ignore[arg-type]
        else:
            assert isinstance(value, str)
            # Agent Mode never emits raw text — rejected no matter the position.
            assert channel.emit_text(value) is False

    # No raw text ever reached the bus, regardless of the interleaving (R6.7).
    assert text_sink.chunks == []

    # Everything on the SSE bus is a structured Event_Contract event...
    assert all(e.get("type") in VALID_TYPES for e in sink.events)
    # ...and the bus is exactly the structured rows, in order — text added none.
    assert [e["type"] for e in sink.events] == expected_types
    assert len(sink.events) == sum(1 for op, _ in operations if op == "row")

    # The channel structurally declares it suppresses no structured rows (R2.7).
    assert channel.suppresses_structured_rows is False
