"""Property test for Ask text-only discipline + suppression-iff-Ask (task 7.7).

Feature: zocai-ecosystem-rebuild, Property 10: Ask Mode is text-only and
suppression is active iff Ask Mode is active.

**Validates: Requirements 2.7, 6.6**

Design Property 10 (verbatim intent): *For any* run mode, while Ask Mode is
active the SSE stream contains only raw text token chunks and zero structured
row events, and planning/to-do/tool-activity rows are suppressed; while Ask
Mode is inactive those rows are not suppressed. Suppression is enabled if and
only if Ask Mode is active, with no carry-over after Ask Mode becomes inactive.

Strategy
--------
The property exercises the real channel discipline (no mocks) built by
:func:`channel_for` per run:

* **Text-only + total suppression (R6.6, R2.7).** Over an arbitrary
  *interleaving* of structured row events and raw text chunks fed to a fresh
  :class:`AskChannel`, every structured row is suppressed (``emit_event``
  returns ``False`` and nothing reaches the structured contract gate), every
  text chunk is admitted (``emit_text`` returns ``True``), and the text sink
  receives exactly the text chunks in their original order. The planning /
  to-do / tool-activity rows named by R2.7 are confirmed withheld via the
  channel's ``suppressed`` log.

* **Suppression iff Ask, with no carry-over (R2.7).** Over an arbitrary
  *sequence of runs* with independently drawn modes, a fresh channel is built
  for each run via :func:`channel_for`; for every run the channel's
  ``suppresses_structured_rows`` equals exactly ``mode is Mode.ASK`` —
  independent of how many Ask or Agent runs preceded it — proving the iff and
  the absence of any sticky/carried-over suppression flag. The stateless
  predicate :func:`suppresses_structured_rows` agrees run-for-run.
"""

from __future__ import annotations

from collections.abc import Mapping

from hypothesis import given, settings
from hypothesis import strategies as st

from zocai_gateway.channel import (
    SUPPRESSED_IN_ASK_ROW_TYPES,
    AgentChannel,
    AskChannel,
    channel_for,
    suppresses_structured_rows,
)
from zocai_gateway.emit_gate import EmitGate
from zocai_gateway.mode_router import AgentPath, AskPath, Mode

# The eight defined contract row kinds (R6.3); the R2.7 categories are a subset.
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
    """Captures structured wire events forwarded to the SSE bus, in order."""

    def __init__(self) -> None:
        self.events: list[Mapping[str, object]] = []

    def __call__(self, event: Mapping[str, object]) -> None:
        self.events.append(event)


class _RecordingDiary:
    """Minimal DiaryMirror double recording appended events in order."""

    def __init__(self) -> None:
        self.appended: list[Mapping[str, object]] = []

    def append(self, event: Mapping[str, object]) -> int:
        self.appended.append(event)
        return len(self.appended) - 1


class _RecordingTextSink:
    """Captures raw markdown text token chunks written to the bus, in order."""

    def __init__(self) -> None:
        self.chunks: list[str] = []

    def __call__(self, chunk: str) -> None:
        self.chunks.append(chunk)


# ── Strategies ──────────────────────────────────────────────────────────────


@st.composite
def structured_rows(draw: st.DrawFn) -> dict[str, object]:
    """A structured row payload of one of the eight contract kinds.

    The ``type`` is drawn from the eight contract kinds, biased to include the
    planning / to-do / tool-activity kinds R2.7 names explicitly so the
    property exercises exactly the rows the requirement calls out.
    """
    kind = draw(
        st.one_of(
            st.sampled_from(sorted(SUPPRESSED_IN_ASK_ROW_TYPES)),
            st.sampled_from(VALID_TYPES),
        )
    )
    return {
        "type": kind,
        "seq": draw(st.integers(min_value=0, max_value=1_000_000)),
        "runId": draw(st.text(min_size=1, max_size=8)),
        "ts": _TS,
        "text": draw(st.text(max_size=12)),
    }


# Tagged interleaving items: a structured row event, or a raw text chunk.
_EVENT = "event"
_TEXT = "text"


def interleavings() -> st.SearchStrategy[list[tuple[str, object]]]:
    """An arbitrary interleaving of structured rows and raw text chunks."""
    event_item = structured_rows().map(lambda p: (_EVENT, p))
    text_item = st.text(max_size=16).map(lambda c: (_TEXT, c))
    return st.lists(st.one_of(event_item, text_item), max_size=40)


# ── Property 10a: Ask is text-only and suppresses every structured row ───────


@settings(max_examples=200, deadline=None)
@given(stream=interleavings())
def test_ask_emits_only_text_and_suppresses_every_structured_row(
    stream: list[tuple[str, object]],
) -> None:
    """Ask Mode emits only text and suppresses every structured row (R6.6, R2.7).

    Feature: zocai-ecosystem-rebuild, Property 10

    **Validates: Requirements 2.7, 6.6**
    """
    # A fresh Ask channel for this run, built the way the gateway builds it.
    struct_sink = _RecordingSink()
    diary = _RecordingDiary()
    text_sink = _RecordingTextSink()
    channel = channel_for(
        AskPath(),
        gate=EmitGate(sink=struct_sink, diary=diary),
        text_sink=text_sink,
    )
    assert isinstance(channel, AskChannel)

    # Ask suppression is active for this channel (R2.7).
    assert channel.suppresses_structured_rows is True

    expected_text: list[str] = []
    expected_suppressed: list[str | None] = []
    for tag, item in stream:
        if tag == _EVENT:
            payload = item
            assert isinstance(payload, Mapping)
            # Every structured row is withheld: emit_event reports not admitted.
            assert channel.emit_event(payload) is False
            raw_type = payload.get("type")
            expected_suppressed.append(raw_type if isinstance(raw_type, str) else None)
        else:
            chunk = item
            assert isinstance(chunk, str)
            # Every raw text chunk is admitted onto the bus.
            assert channel.emit_text(chunk) is True
            expected_text.append(chunk)

    # Text-only: the text sink received exactly the text chunks, in order...
    assert text_sink.chunks == expected_text
    # ...and zero structured rows reached the contract gate / diary (R6.6).
    assert struct_sink.events == []
    assert diary.appended == []

    # Every structured row was suppressed, in order, including the R2.7 kinds.
    assert list(channel.suppressed) == expected_suppressed


# ── Property 10b: suppression iff Ask Mode, with no carry-over ───────────────


@settings(max_examples=200, deadline=None)
@given(modes=st.lists(st.sampled_from(list(Mode)), max_size=30))
def test_suppression_active_iff_ask_with_no_carry_over(modes: list[Mode]) -> None:
    """Suppression is active iff Ask Mode, run-for-run, with no carry-over (R2.7).

    Feature: zocai-ecosystem-rebuild, Property 10

    **Validates: Requirements 2.7, 6.6**
    """
    for mode in modes:
        # A fresh channel is built per run from its mode (channel_for), so no
        # suppression state can survive from any earlier run.
        path = AskPath() if mode is Mode.ASK else AgentPath()
        struct_sink = _RecordingSink()
        channel = channel_for(
            path,
            gate=EmitGate(sink=struct_sink, diary=_RecordingDiary()),
            text_sink=_RecordingTextSink(),
        )

        expected = mode is Mode.ASK
        # The channel's suppression equals exactly "Ask Mode is active" — the
        # iff — independent of how many Ask/Agent runs preceded this one.
        assert channel.suppresses_structured_rows is expected
        # The stateless predicate agrees with the channel for this mode.
        assert suppresses_structured_rows(mode) is expected
        # Structural mirror: Ask channels suppress, Agent channels do not.
        if expected:
            assert isinstance(channel, AskChannel)
        else:
            assert isinstance(channel, AgentChannel)
            # Agent Mode never emits raw text (R6.7) and never suppresses rows.
            assert channel.emit_text("x") is False
