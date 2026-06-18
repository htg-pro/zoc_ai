"""Tests for the Tier 1 Diary_Worker (task 9.2, R9.3 + R9.4).

These cover the two task invariants:

* **R9.3 non-blocking append** — :meth:`DiaryWorker.append` returns without
  waiting on the disk write. A slow/blocked writer must not stall the producer.
* **R9.4 FIFO append order** — the single consumer writes entries in the exact
  order they were appended, even with concurrent producers.

Both example-based and property-based (Hypothesis) tests are included; the
property test exercises FIFO ordering across many randomized event sequences.
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from zocai_gateway.memory import DiaryWorker
from zocai_gateway.memory.diary_worker import DiaryEntry


def _read_entries(diary_path: Path) -> list[dict[str, Any]]:
    # A missing diary file legitimately means "no entries written yet" (the
    # worker creates the file lazily on its first append); treat it as empty.
    if not diary_path.exists():
        return []
    text = diary_path.read_text(encoding="utf-8")
    return [json.loads(line) for line in text.splitlines() if line]


def test_append_writes_entry_to_diary(tmp_path: Path) -> None:
    diary = tmp_path / "session_diary.jsonl"
    with DiaryWorker(diary) as worker:
        worker.append({"runId": "r-1", "type": "command", "ts": "t0"})
        worker.wait_until_idle(timeout=2.0)

    entries = _read_entries(diary)
    assert len(entries) == 1
    entry = entries[0]
    assert entry["seq"] == 0
    assert entry["runId"] == "r-1"
    assert entry["type"] == "command"
    assert entry["payload"] == {"runId": "r-1", "type": "command", "ts": "t0"}


def test_append_assigns_monotonic_fifo_seq(tmp_path: Path) -> None:
    diary = tmp_path / "session_diary.jsonl"
    with DiaryWorker(diary) as worker:
        seqs = [worker.append({"type": "message", "i": i}) for i in range(5)]
        worker.wait_until_idle(timeout=2.0)

    assert seqs == [0, 1, 2, 3, 4]
    entries = _read_entries(diary)
    assert [e["seq"] for e in entries] == [0, 1, 2, 3, 4]


def test_append_preserves_fifo_order_on_disk(tmp_path: Path) -> None:
    diary = tmp_path / "session_diary.jsonl"
    with DiaryWorker(diary) as worker:
        for i in range(50):
            worker.append({"type": "command", "n": i})
        worker.wait_until_idle(timeout=5.0)

    entries = _read_entries(diary)
    assert [e["payload"]["n"] for e in entries] == list(range(50))
    assert [e["seq"] for e in entries] == list(range(50))


def test_append_is_non_blocking_when_disk_write_is_slow(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """R9.3: ``append`` must return promptly even if the disk write blocks.

    We stall the worker's ``_write`` so the consumer thread is parked inside a
    write. ``append`` only touches the in-memory queue, so it must return well
    before the (artificially long) write would complete.
    """
    diary = tmp_path / "session_diary.jsonl"
    release = threading.Event()

    worker = DiaryWorker(diary)
    original_write = worker._write

    def _slow_write(entry: DiaryEntry) -> None:
        # Block the consumer for far longer than append should ever take.
        release.wait(timeout=5.0)
        original_write(entry)

    monkeypatch.setattr(worker, "_write", _slow_write)
    worker.start()
    try:
        # First append occupies the consumer inside the slow write.
        worker.append({"type": "command", "n": 0})
        time.sleep(0.05)  # let the consumer pick up entry 0 and block

        start = time.monotonic()
        worker.append({"type": "command", "n": 1})
        elapsed = time.monotonic() - start

        # Producer returned without waiting on the blocked disk write.
        assert elapsed < 0.5
        # And while the write is blocked, nothing has been flushed yet.
        assert _read_entries(diary) == []
    finally:
        release.set()
        worker.stop()

    # After releasing, both entries land in FIFO order.
    assert [e["payload"]["n"] for e in _read_entries(diary)] == [0, 1]


def test_concurrent_producers_keep_unique_ordered_seqs(tmp_path: Path) -> None:
    """Concurrent producers get unique, contiguous FIFO seqs and write in order."""
    diary = tmp_path / "session_diary.jsonl"
    per_thread = 100
    threads_count = 4

    with DiaryWorker(diary) as worker:

        def produce() -> None:
            for _ in range(per_thread):
                worker.append({"type": "message"})

        threads = [threading.Thread(target=produce) for _ in range(threads_count)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        worker.wait_until_idle(timeout=10.0)

    entries = _read_entries(diary)
    seqs = [e["seq"] for e in entries]
    assert len(seqs) == per_thread * threads_count
    # Single consumer writes in enqueue order, so on-disk seqs are ascending,
    # and every seq in the contiguous range appears exactly once.
    assert seqs == sorted(seqs)
    assert set(seqs) == set(range(per_thread * threads_count))


def test_stop_without_drain_skips_pending(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    diary = tmp_path / "session_diary.jsonl"
    release = threading.Event()
    worker = DiaryWorker(diary)
    original_write = worker._write

    def _slow_write(entry: DiaryEntry) -> None:
        release.wait(timeout=5.0)
        original_write(entry)

    monkeypatch.setattr(worker, "_write", _slow_write)
    worker.start()
    worker.append({"type": "command", "n": 0})
    time.sleep(0.05)  # consumer parks inside the slow write of entry 0
    worker.append({"type": "command", "n": 1})  # stays pending
    release.set()
    worker.stop(drain=False)

    # Entry 0 (already being written) lands; the pending entry 1 is dropped.
    entries = _read_entries(diary)
    assert [e["payload"]["n"] for e in entries] == [0]


@settings(max_examples=50, deadline=None)
@given(
    events=st.lists(
        st.fixed_dictionaries(
            {
                "type": st.sampled_from(["command", "message", "edit", "status"]),
                "n": st.integers(min_value=0, max_value=10_000),
            }
        ),
        min_size=0,
        max_size=40,
    )
)
def test_property_append_order_equals_fifo_emission_order(
    tmp_path_factory: pytest.TempPathFactory, events: list[dict[str, object]]
) -> None:
    """Property 28 (backend half) / R9.4.

    *For any* sequence of emitted events, the Diary_Worker appends them to the
    Session_Diary in the same first-in-first-out order they were emitted.

    **Validates: Requirements 9.4**
    """
    diary = tmp_path_factory.mktemp("diary") / "session_diary.jsonl"
    with DiaryWorker(diary) as worker:
        returned_seqs = [worker.append(event) for event in events]
        worker.wait_until_idle(timeout=10.0)

    entries = _read_entries(diary)
    # One entry per emission, in emission order.
    assert len(entries) == len(events)
    assert [e["seq"] for e in entries] == list(range(len(events)))
    assert returned_seqs == list(range(len(events)))
    # Payloads land in the exact FIFO order they were appended.
    assert [e["payload"] for e in entries] == events
