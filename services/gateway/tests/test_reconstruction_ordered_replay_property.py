"""Property test for ordered reconstruction from the Session_Diary (task 9.9).

Feature: zocai-ecosystem-rebuild, Property 41: Reconstruction from the trailing
diary yields the persisted ordered state.

**Validates: Requirements 10.2, 10.3**

Design Property 41 (verbatim intent): *For any* Session_Diary, reconstructing
the Agent_Feed view and the active run state from the trailing entries
reproduces the persisted entries in their original order.

The reconstruction under test lives in
:mod:`zocai_gateway.memory.reconstruction` (``read_diary_entries`` /
``trailing_entries`` / ``reconstruct_run_state``). This property is exercised
against the real functions (no mocks) over arbitrary diaries that:

* contain **multiple interleaved runs** (so the active-run *selection* matters),
* carry well-formed entries written in FIFO ``seq`` order, and
* may be peppered with **malformed / blank lines** and end on a **torn
  trailing line** (a connection drop mid-append), all of which must be skipped.

It asserts the two halves of Property 41:

* **Faithful, ordered persisted state (R10.2/R10.3).** ``read_diary_entries``
  reproduces *exactly* the well-formed persisted entries in their original
  on-disk order — every malformed/blank/torn line skipped, every complete entry
  preserved.
* **Active-run trailing selection in FIFO order (R10.3).** reconstruction
  selects precisely the entries of the active run (the run of the last appended
  entry) and replays them in original ``seq`` (FIFO) order, dropping nothing
  well-formed and reordering nothing.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from zocai_gateway.memory import (
    StateWrapper,
    read_diary_entries,
    reconstruct_run_state,
    trailing_entries,
)

# Recognised event types plus an arbitrary one (``message``) so the generator
# spans the whole vocabulary reconstruction must tolerate. Selection/ordering
# is type-agnostic, so the exact type only needs to round-trip faithfully.
_EVENT_TYPES = [
    "intent",
    "thinking",
    "read-files",
    "edit-file",
    "command",
    "summary",
    "done",
    "message",
]

# Distinct, non-empty run ids so a diary can interleave several runs.
_RUN_ID = st.text(
    alphabet="abcdefghijklmnopqrstuvwxyz0123456789-", min_size=1, max_size=6
)

# Lines that must NEVER parse into a DiaryEntry: blank/whitespace, torn JSON,
# valid-JSON-but-wrong-shape (array / scalar / dict missing or non-int ``seq``).
# None contains a newline, so each stays a single on-disk line.
_MALFORMED_LINES = st.sampled_from(
    [
        "",
        "   ",
        "{not valid json",
        '{"seq": 1, "runId": "r", "type": "comm',  # torn mid-write
        "[1, 2, 3]",  # JSON array, not an object
        "null",  # JSON scalar
        "42",
        '{"runId": "r", "type": "intent"}',  # object, but no ``seq``
        '{"seq": "x", "payload": {}}',  # ``seq`` not an integer
        '{"seq": 0, "payload": "nope"}',  # ``payload`` not an object
    ]
)


@st.composite
def _diaries(draw: st.DrawFn) -> tuple[str, list[dict[str, object]]]:
    """Build a Session_Diary text plus the list of well-formed records it holds.

    Records are assigned a strictly ascending ``seq`` in append order (what the
    Diary_Worker does), drawn from a small pool of run ids so runs interleave.
    Malformed/blank lines are sprinkled between them and an optional torn line
    is tacked on the end — none of which appear in the returned record list, so
    the caller's expectations are computed from the persisted *well-formed*
    entries alone.
    """
    run_ids = draw(st.lists(_RUN_ID, min_size=1, max_size=4, unique=True))
    count = draw(st.integers(min_value=1, max_value=30))

    records: list[dict[str, object]] = []
    for seq in range(count):
        run_id = draw(st.sampled_from(run_ids))
        event_type = draw(st.sampled_from(_EVENT_TYPES))
        payload: dict[str, object] = {"type": event_type}
        if event_type == "edit-file":
            payload["path"] = draw(st.text(max_size=16))
            payload["diff"] = draw(st.text(max_size=32))
        records.append(
            {"seq": seq, "runId": run_id, "type": event_type, "ts": "t", "payload": payload}
        )

    # Each well-formed record becomes one JSON line (the Diary_Worker layout).
    lines = [json.dumps(rec, sort_keys=True) for rec in records]

    # Sprinkle malformed/blank lines at arbitrary positions; they must be
    # skipped without disturbing the order of the well-formed entries.
    noise = draw(st.lists(_MALFORMED_LINES, max_size=6))
    for bad in noise:
        idx = draw(st.integers(min_value=0, max_value=len(lines)))
        lines.insert(idx, bad)

    text = "\n".join(lines)
    if lines:
        text += "\n"
    # A connection drop can leave a torn final line with no trailing newline.
    if draw(st.booleans()):
        text += '{"seq": 999, "runId": "torn", "type": "edit-fi'

    return text, records


@settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
@given(diary=_diaries())
def test_reconstruction_yields_persisted_ordered_state(
    diary: tuple[str, list[dict[str, object]]],
) -> None:
    """Property 41: trailing active-run entries replay in persisted FIFO order.

    Feature: zocai-ecosystem-rebuild, Property 41

    **Validates: Requirements 10.2, 10.3**
    """
    text, records = diary
    # A fresh directory per example keeps each diary independent (and avoids a
    # function-scoped fixture being shared across generated inputs).
    with tempfile.TemporaryDirectory() as base:
        path = Path(base) / "session_diary.jsonl"
        path.write_text(text, encoding="utf-8")

        # ── Persisted ordered state (R10.2): every well-formed entry preserved
        # in original on-disk order; every malformed/blank/torn line skipped. ─
        read = read_diary_entries(path)
        assert [e.seq for e in read] == [rec["seq"] for rec in records]
        assert [e.run_id for e in read] == [rec["runId"] for rec in records]
        assert [e.type for e in read] == [rec["type"] for rec in records]
        assert [dict(e.payload) for e in read] == [rec["payload"] for rec in records]

        # The active run is the run of the last appended well-formed entry.
        active = records[-1]["runId"]
        expected = [rec for rec in records if rec["runId"] == active]

        # ``trailing_entries`` selects exactly the active run, ascending seq. ─
        trailing = trailing_entries(read, active)
        assert [e.seq for e in trailing] == [rec["seq"] for rec in expected]

        # ── Active run state reconstruction (R10.3). ─────────────────────────
        run = reconstruct_run_state(path)
        assert run is not None
        assert run.run_id == active

        # Only the active run's entries — nothing from the other interleaved
        # runs, nothing malformed — reproduced in original FIFO (seq) order.
        seqs = [e.seq for e in run.entries]
        assert seqs == [rec["seq"] for rec in expected]
        assert seqs == sorted(seqs), "entries must be in ascending FIFO seq order"

        # Each replayed entry is the persisted entry, unchanged.
        for entry, rec in zip(run.entries, expected, strict=True):
            assert entry.seq == rec["seq"]
            assert entry.run_id == rec["runId"]
            assert entry.type == rec["type"]
            assert dict(entry.payload) == rec["payload"]

        # The reconstruction also yields the model-agnostic resumable run state.
        assert isinstance(run.state, StateWrapper)


def test_reconstruction_selects_trailing_run_among_many_example(tmp_path: Path) -> None:
    """Anchor example: two interleaved runs, malformed + torn lines skipped.

    Feature: zocai-ecosystem-rebuild, Property 41

    **Validates: Requirements 10.2, 10.3**
    """
    path = tmp_path / "session_diary.jsonl"
    lines = [
        json.dumps({"seq": 0, "runId": "old", "type": "intent", "ts": "t", "payload": {"type": "intent"}}),
        "{ torn mid-write",  # malformed — skipped
        json.dumps({"seq": 1, "runId": "active", "type": "intent", "ts": "t", "payload": {"type": "intent"}}),
        json.dumps({"seq": 2, "runId": "old", "type": "done", "ts": "t", "payload": {"type": "done"}}),
        json.dumps({"seq": 3, "runId": "active", "type": "summary", "ts": "t", "payload": {"type": "summary"}}),
    ]
    # Trailing torn line from a connection drop.
    path.write_text("\n".join(lines) + "\n" + '{"seq": 4, "runId": "active"', encoding="utf-8")

    run = reconstruct_run_state(path)
    assert run is not None
    # ``active`` owns the last well-formed entry (seq 3), so it is the run rebuilt.
    assert run.run_id == "active"
    # Its entries, in original FIFO order, with the other run and noise dropped.
    assert [e.seq for e in run.entries] == [1, 3]
