"""Property test for non-conforming payload discard at the SSE emit gate (task 7.5).

Feature: zocai-ecosystem-rebuild, Property 27: Non-conforming payloads are
discarded and the stream stays open.

**Validates: Requirements 6.4**

Design Property 27 (verbatim intent): *For any* payload that does not conform to
the Event_Contract, the Gateway does not emit it, records a contract-violation
entry naming the non-conforming type, and keeps the stream open.

Strategy
--------
The property exercises the real :class:`EmitGate` against the real
``AgentEventModel`` contract (no mocks) using a recording sink and a recording
diary double. For every non-conforming payload drawn from a union of three
generators that cover the ways a payload can fail the Event_Contract:

* **Unknown discriminator** — a ``type`` that is a string but is none of the
  eight defined row kinds.
* **No discriminator** — a payload carrying no ``type`` field at all (down to
  the empty mapping).
* **Missing required fields** — a payload that names a valid row kind but omits
  one of that kind's required contract fields.

we assert the full R6.4 behaviour at once:

1. :meth:`EmitGate.emit` returns ``False`` (the payload is discarded).
2. The event is **not** forwarded to the sink (never reaches the SSE bus).
3. The diary is **not** mirrored for the discarded payload (R9.3 mirror only
   sees conforming events).
4. Exactly one new :class:`ContractViolation` is recorded, naming the offending
   ``type`` (the claimed string, or ``None`` when the payload carried no type).
5. The gate stays usable — a subsequent *conforming* event still emits, is
   forwarded and mirrored, and records no further violation — proving one bad
   payload cannot tear down the stream.
"""

from __future__ import annotations

from collections.abc import Mapping

from hypothesis import given, settings
from hypothesis import strategies as st
from zocai_gateway.emit_gate import EmitGate

# The eight defined row kinds (R6.3). Anything else is a non-conforming type.
VALID_TYPES = (
    "intent",
    "thinking",
    "plan",
    "plan-update",
    "map-files",
    "read-files",
    "edit-file",
    "command",
    "review",
    "summary",
    "approval",
    "done",
    "recovery-attempt",
    "budget",
    "test-results",
    "context-compressed",
)


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


# ── Conforming-payload strategy (the "subsequent good event") ───────────────

_TS = "2024-01-01T00:00:00Z"


@st.composite
def conforming_payloads(draw: st.DrawFn) -> dict[str, object]:
    """A payload that fully conforms to the Event_Contract for some row kind."""
    seq = draw(st.integers(min_value=0, max_value=1_000_000))
    run_id = draw(st.text(min_size=1, max_size=12))
    kind = draw(st.sampled_from(VALID_TYPES))
    base: dict[str, object] = {"type": kind, "seq": seq, "runId": run_id, "ts": _TS}

    if kind == "intent":
        base["text"] = draw(st.text(max_size=20))
        base["modelTier"] = draw(st.sampled_from(["local-slm", "edge", "cloud"]))
        base["contextWindowTokens"] = draw(st.integers(min_value=1, max_value=100_000))
    elif kind == "thinking":
        base["text"] = draw(st.text(max_size=20))
    elif kind == "plan":
        base["items"] = []
    elif kind == "plan-update":
        base["id"] = draw(st.text(min_size=1, max_size=12))
        base["status"] = draw(st.sampled_from(["pending", "active", "done"]))
    elif kind == "map-files":
        base["readList"] = draw(
            st.lists(st.text(min_size=1, max_size=8), max_size=8)
        )
        base["writeList"] = draw(
            st.lists(st.text(min_size=1, max_size=8), max_size=4)
        )
        base["rationale"] = draw(st.text(max_size=20))
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
    elif kind == "review":
        base["files"] = []
    elif kind == "summary":
        base["text"] = draw(st.text(max_size=20))
    elif kind == "approval":
        base["prompt"] = draw(st.text(max_size=20))
    elif kind == "done":
        base["ok"] = draw(st.booleans())
    elif kind == "recovery-attempt":
        base["attempt"] = draw(st.integers(min_value=1, max_value=10))
        base["failures"] = draw(st.lists(st.text(max_size=20), max_size=4))
    elif kind == "budget":
        base["tokensUsed"] = draw(st.integers(min_value=0, max_value=100_000))
        base["tokenLimit"] = draw(st.integers(min_value=0, max_value=100_000))
        base["iterations"] = draw(st.integers(min_value=0, max_value=100))
        base["recoveries"] = draw(st.integers(min_value=0, max_value=100))
    elif kind == "test-results":
        base["status"] = draw(st.sampled_from(["pass", "fail"]))
        base["command"] = draw(st.text(min_size=1, max_size=12))
        base["source"] = draw(st.text(min_size=1, max_size=12))
        base["passed"] = draw(st.integers(min_value=0, max_value=100))
        base["failed"] = draw(st.integers(min_value=0, max_value=100))
        base["exitCode"] = draw(st.integers(min_value=-10, max_value=10))
    elif kind == "context-compressed":
        original = draw(st.integers(min_value=1, max_value=100_000))
        compressed = draw(st.integers(min_value=0, max_value=original))
        base["originalTokens"] = original
        base["compressedTokens"] = compressed
        base["compressionRatio"] = compressed / original
    return base


# ── Non-conforming-payload strategies ───────────────────────────────────────

# The required contract fields per row kind whose removal makes a payload
# non-conforming (fields with defaults like ``collapsible`` are excluded).
_REQUIRED_BY_KIND: dict[str, tuple[str, ...]] = {
    "intent": ("type", "seq", "runId", "ts", "text", "modelTier", "contextWindowTokens"),
    "thinking": ("type", "seq", "runId", "ts", "text"),
    "plan": ("type", "seq", "runId", "ts", "items"),
    "plan-update": ("type", "seq", "runId", "ts", "id", "status"),
    "map-files": ("type", "seq", "runId", "ts", "readList", "writeList", "rationale"),
    "read-files": ("type", "seq", "runId", "ts", "files"),
    "edit-file": ("type", "seq", "runId", "ts", "path", "diff"),
    "command": ("type", "seq", "runId", "ts", "command"),
    "review": ("type", "seq", "runId", "ts", "files"),
    "summary": ("type", "seq", "runId", "ts", "text"),
    "approval": ("type", "seq", "runId", "ts", "prompt"),
    "done": ("type", "seq", "runId", "ts", "ok"),
    "recovery-attempt": ("type", "seq", "runId", "ts", "attempt", "failures"),
    "budget": (
        "type", "seq", "runId", "ts", "tokensUsed", "tokenLimit", "iterations", "recoveries"
    ),
    "test-results": (
        "type", "seq", "runId", "ts", "status", "command", "source", "passed", "failed", "exitCode"
    ),
    "context-compressed": (
        "type", "seq", "runId", "ts", "originalTokens", "compressedTokens", "compressionRatio"
    ),
}


@st.composite
def unknown_type_payloads(draw: st.DrawFn) -> dict[str, object]:
    """A payload whose ``type`` is a string but not one of the eight row kinds."""
    bad_type = draw(
        st.text(min_size=1, max_size=20).filter(lambda s: s not in VALID_TYPES)
    )
    return {
        "type": bad_type,
        "seq": draw(st.integers(min_value=0, max_value=1_000_000)),
        "runId": draw(st.text(min_size=1, max_size=12)),
        "ts": _TS,
    }


@st.composite
def missing_type_payloads(draw: st.DrawFn) -> dict[str, object]:
    """A payload carrying no ``type`` discriminator at all (down to empty)."""
    payload: dict[str, object] = {}
    if draw(st.booleans()):
        payload["seq"] = draw(st.integers(min_value=0, max_value=1_000_000))
    if draw(st.booleans()):
        payload["runId"] = draw(st.text(min_size=1, max_size=12))
    if draw(st.booleans()):
        payload["ts"] = _TS
    return payload


@st.composite
def missing_required_payloads(draw: st.DrawFn) -> dict[str, object]:
    """A payload naming a valid kind but omitting one required contract field."""
    full = draw(conforming_payloads())
    kind = full["type"]
    assert isinstance(kind, str)
    drop = draw(st.sampled_from(_REQUIRED_BY_KIND[kind]))
    del full[drop]
    return full


def non_conforming_payloads() -> st.SearchStrategy[dict[str, object]]:
    """Union of the three ways a payload can fail the Event_Contract."""
    return st.one_of(
        unknown_type_payloads(),
        missing_type_payloads(),
        missing_required_payloads(),
    )


@settings(max_examples=200, deadline=None)
@given(bad=non_conforming_payloads(), good=conforming_payloads())
def test_non_conforming_discarded_and_stream_stays_open(
    bad: dict[str, object],
    good: dict[str, object],
) -> None:
    """Property 27: non-conforming payloads are discarded; the stream stays open.

    Feature: zocai-ecosystem-rebuild, Property 27

    **Validates: Requirements 6.4**
    """
    sink = _RecordingSink()
    diary = _RecordingDiary()
    gate = EmitGate(sink=sink, diary=diary)

    # The non-conforming payload is discarded.
    assert gate.emit(bad) is False
    # It is never forwarded to the SSE sink...
    assert sink.events == []
    # ...nor mirrored to the diary (R9.3 mirror sees only conforming events).
    assert diary.appended == []

    # Exactly one violation is recorded, naming the offending type. A string
    # ``type`` is named verbatim; a payload with no (or non-string) type names None.
    assert len(gate.violations) == 1
    claimed = bad.get("type")
    expected_type = claimed if isinstance(claimed, str) else None
    assert gate.violations[0].event_type == expected_type
    assert gate.violations[0].index == 0

    # The gate stays usable: a subsequent conforming event still emits, is
    # forwarded and mirrored, and records no further violation.
    assert gate.emit(good) is True
    assert len(sink.events) == 1
    assert sink.events[0]["type"] == good["type"]
    assert diary.appended == sink.events
    assert len(gate.violations) == 1  # the good event added no violation
