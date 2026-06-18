"""Unit tests for the SSE emit gate (task 7.2, R6.2/6.4/6.5 + R9.3 mirror).

These example-based tests pin the gate's contract: conforming events are
forwarded to the sink (and mirrored to the diary) in call order, non-conforming
payloads are discarded with a violation entry naming the offending type while
the gate stays usable, and the wire form carries the validated ``type``
discriminator. The dedicated property tests for conformance, discard, and
end-to-end ordering live in tasks 7.4-7.6.
"""

from __future__ import annotations

from collections.abc import Mapping

from shared_schema.agent_events import DoneEvent, IntentEvent, ThinkingEvent

from zocai_gateway.emit_gate import EmitGate


class _RecordingSink:
    """Captures forwarded wire events in call order for assertions."""

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


def _intent_payload(seq: int, run_id: str = "r1") -> dict[str, object]:
    return {
        "type": "intent",
        "seq": seq,
        "runId": run_id,
        "ts": "2024-01-01T00:00:00Z",
        "text": "do the thing",
        "modelTier": "local-slm",
        "contextWindowTokens": 4096,
    }


def test_conforming_event_is_forwarded_and_returns_true() -> None:
    sink = _RecordingSink()
    gate = EmitGate(sink=sink)

    emitted = gate.emit(_intent_payload(0))

    assert emitted is True
    assert len(sink.events) == 1
    assert gate.violations == ()


def test_emitted_wire_form_carries_valid_discriminator_r6_2() -> None:
    # R6.2: every emitted Agent-Mode event carries a valid type discriminator
    # matching exactly one row kind, in canonical camelCase wire form.
    sink = _RecordingSink()
    gate = EmitGate(sink=sink)

    gate.emit(_intent_payload(0))

    wire = sink.events[0]
    assert wire["type"] == "intent"
    assert wire["runId"] == "r1"
    assert wire["modelTier"] == "local-slm"
    assert wire["contextWindowTokens"] == 4096


def test_accepts_snake_case_input_and_normalizes_to_wire_form() -> None:
    # Producers may construct events as models and dump by field name; the gate
    # validates and re-serializes to the canonical camelCase wire form.
    sink = _RecordingSink()
    gate = EmitGate(sink=sink)

    model = ThinkingEvent(seq=0, run_id="r1", ts="2024-01-01T00:00:00Z", text="ponder")
    assert gate.emit(model.model_dump()) is True

    wire = sink.events[0]
    assert wire["type"] == "thinking"
    assert wire["runId"] == "r1"
    assert wire["collapsible"] is True


def test_non_conforming_unknown_type_is_discarded_and_recorded_r6_4() -> None:
    sink = _RecordingSink()
    gate = EmitGate(sink=sink)

    emitted = gate.emit(
        {"type": "not-a-real-kind", "seq": 0, "runId": "r1", "ts": "t"}
    )

    assert emitted is False
    assert sink.events == []  # discarded: never forwarded (R6.4)
    assert len(gate.violations) == 1
    assert gate.violations[0].event_type == "not-a-real-kind"  # names the type


def test_missing_required_field_is_discarded_with_violation() -> None:
    sink = _RecordingSink()
    gate = EmitGate(sink=sink)

    # An "intent" missing the required allocator fields does not conform.
    emitted = gate.emit({"type": "intent", "seq": 0, "runId": "r1", "ts": "t"})

    assert emitted is False
    assert sink.events == []
    assert gate.violations[0].event_type == "intent"


def test_payload_without_type_records_none_event_type() -> None:
    sink = _RecordingSink()
    gate = EmitGate(sink=sink)

    assert gate.emit({"seq": 0, "runId": "r1", "ts": "t"}) is False
    assert gate.violations[0].event_type is None


def test_stream_stays_open_after_violation_r6_4() -> None:
    # A bad payload must not stop subsequent good ones from emitting.
    sink = _RecordingSink()
    gate = EmitGate(sink=sink)

    assert gate.emit({"type": "garbage"}) is False
    assert gate.emit(_intent_payload(0)) is True
    assert gate.emit({"type": "edit-file", "seq": 1, "runId": "r1"}) is False
    assert gate.emit(
        DoneEvent(seq=2, run_id="r1", ts="t", ok=True).model_dump()
    ) is True

    # Two conforming events made it through despite interleaved violations.
    assert [e["type"] for e in sink.events] == ["intent", "done"]
    assert len(gate.violations) == 2


def test_emission_preserves_call_order_r6_5() -> None:
    sink = _RecordingSink()
    gate = EmitGate(sink=sink)

    payloads = [_intent_payload(0)]
    payloads.append(
        ThinkingEvent(seq=1, run_id="r1", ts="t", text="a").model_dump()
    )
    payloads.append(
        ThinkingEvent(seq=2, run_id="r1", ts="t", text="b").model_dump()
    )
    payloads.append(DoneEvent(seq=3, run_id="r1", ts="t", ok=True).model_dump())

    for p in payloads:
        gate.emit(p)

    assert [e["seq"] for e in sink.events] == [0, 1, 2, 3]
    assert [e["type"] for e in sink.events] == [
        "intent",
        "thinking",
        "thinking",
        "done",
    ]


def test_violations_indexed_in_detection_order() -> None:
    gate = EmitGate(sink=_RecordingSink())

    gate.emit({"type": "x"})
    gate.emit({"type": "y"})

    assert [v.index for v in gate.violations] == [0, 1]
    assert [v.event_type for v in gate.violations] == ["x", "y"]


def test_conforming_event_is_mirrored_to_diary_r9_3() -> None:
    sink = _RecordingSink()
    diary = _RecordingDiary()
    gate = EmitGate(sink=sink, diary=diary)

    gate.emit(_intent_payload(0))

    assert len(diary.appended) == 1
    assert diary.appended[0]["type"] == "intent"
    # Diary receives the same canonical wire form as the SSE sink.
    assert diary.appended[0] == sink.events[0]


def test_discarded_event_is_not_mirrored_to_diary() -> None:
    sink = _RecordingSink()
    diary = _RecordingDiary()
    gate = EmitGate(sink=sink, diary=diary)

    assert gate.emit({"type": "bogus"}) is False
    assert diary.appended == []


def test_emit_returns_independent_dicts_per_sink_and_diary() -> None:
    # The wire mapping handed downstream should be a plain mapping with the
    # expected keys; mutating the input payload afterwards must not matter.
    sink = _RecordingSink()
    gate = EmitGate(sink=sink)

    payload = _intent_payload(0)
    gate.emit(payload)
    payload["text"] = "mutated"

    assert sink.events[0]["text"] == "do the thing"
