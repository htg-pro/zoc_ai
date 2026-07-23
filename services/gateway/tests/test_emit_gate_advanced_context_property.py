"""Emit-gate conformance property for the two advanced context events."""

from __future__ import annotations

from collections.abc import Mapping

from hypothesis import given, settings
from hypothesis import strategies as st
from shared_schema.agent_events import (
    ContextCompressedEvent,
    DoneEvent,
    MapFilesEvent,
)
from zocai_gateway.emit_gate import EmitGate

_PATH = st.text(alphabet="abcxyz/._-0123456789", min_size=1, max_size=40)


@st.composite
def _payload_case(draw: st.DrawFn) -> tuple[dict[str, object], bool]:
    kind = draw(st.sampled_from(["map-files", "context-compressed"]))
    valid = draw(st.booleans())
    base = {
        "seq": draw(st.integers(min_value=0, max_value=1_000_000)),
        "runId": draw(st.text(min_size=1, max_size=20)),
        "ts": "2024-01-01T00:00:00Z",
    }
    if kind == "map-files":
        payload = MapFilesEvent(
            **base,
            readList=draw(st.lists(_PATH, max_size=8)),
            writeList=draw(st.lists(_PATH, max_size=12)),
            rationale=draw(st.text(max_size=100)),
        ).model_dump(mode="json", by_alias=True)
        if not valid:
            mutation = draw(
                st.sampled_from(["missing-read", "too-many-reads", "bad-rationale"])
            )
            if mutation == "missing-read":
                del payload["readList"]
            elif mutation == "too-many-reads":
                payload["readList"] = [f"{index}.py" for index in range(9)]
            else:
                payload["rationale"] = {"not": "a string"}
    else:
        original = draw(st.integers(min_value=1, max_value=1_000_000))
        compressed = draw(st.integers(min_value=0, max_value=original))
        payload = ContextCompressedEvent(
            **base,
            originalTokens=original,
            compressedTokens=compressed,
            compressionRatio=compressed / original,
        ).model_dump(mode="json", by_alias=True)
        if not valid:
            mutation = draw(
                st.sampled_from(
                    ["missing-original", "zero-original", "expanded", "bad-ratio"]
                )
            )
            if mutation == "missing-original":
                del payload["originalTokens"]
            elif mutation == "zero-original":
                payload["originalTokens"] = 0
            elif mutation == "expanded":
                payload["compressedTokens"] = original + 1
            else:
                payload["compressionRatio"] = 1.5
    return payload, valid


class _Sink:
    def __init__(self) -> None:
        self.events: list[Mapping[str, object]] = []

    def __call__(self, event: Mapping[str, object]) -> None:
        self.events.append(event)


@settings(max_examples=200, deadline=None)
@given(case=_payload_case())
def test_emit_gate_forwards_iff_new_event_conforms(
    case: tuple[dict[str, object], bool],
) -> None:
    """Feature: advanced-context-engine, Property 19: emit-gate conformance.

    **Validates: Requirements 11.4, 11.5, 17.3**
    """
    payload, conforms = case
    sink = _Sink()
    gate = EmitGate(sink=sink)

    assert gate.emit(payload) is conforms
    if conforms:
        assert len(sink.events) == 1
        assert sink.events[0]["type"] == payload["type"]
        assert gate.violations == ()
    else:
        assert sink.events == []
        assert len(gate.violations) == 1
        assert gate.violations[0].event_type == payload["type"]

        sentinel = DoneEvent(
            seq=999,
            run_id="still-open",
            ts="2024-01-01T00:00:00Z",
            ok=True,
        )
        assert gate.emit(sentinel.model_dump(by_alias=True)) is True
        assert [event["type"] for event in sink.events] == ["done"]
        assert len(gate.violations) == 1
