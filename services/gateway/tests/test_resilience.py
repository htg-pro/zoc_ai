"""Tests for resilience and crash recovery (task 9.5, R10.1 / R10.3 / R10.4).

Two behaviours are exercised:

* **Diary_Worker disk-failure fallback (R10.1, R10.4).** When a ``.zocai/``
  write raises, the worker switches to an in-memory buffer and stays
  operational; when disk capability is restored it flushes the buffered entries
  *in their original FIFO order* and resumes normal appends — with no data loss
  and no reordering.
* **Orchestrator reconstruction (R10.3).** The active run state is rebuilt from
  the trailing entries of the Session_Diary, reproducing the persisted entries
  in their original order (backend half of design Property 41), tolerating a
  torn trailing line left by a connection drop.
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

import pytest

from zocai_gateway.memory import (
    DiaryWorker,
    reconstruct_run_state,
)
from zocai_gateway.memory.diary_worker import DiaryEntry
from zocai_gateway.stages import Stage


def _read_entries(diary_path: Path) -> list[dict[str, Any]]:
    if not diary_path.exists():
        return []
    text = diary_path.read_text(encoding="utf-8")
    return [json.loads(line) for line in text.splitlines() if line]


class _Toggle:
    """A toggleable disk: ``write`` raises while ``broken`` is set (R10.1)."""

    def __init__(self, real_write: Any) -> None:
        self.broken = False
        self._real_write = real_write

    def __call__(self, entry: DiaryEntry) -> None:
        if self.broken:
            raise OSError("disk is full")
        self._real_write(entry)


# ── R10.1 / R10.4: disk-failure memory-only fallback + ordered flush ─────────


def test_write_failure_falls_back_to_memory_and_stays_operational(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """R10.1: a raised ``.zocai/`` write degrades to memory; appends keep working."""
    diary = tmp_path / "session_diary.jsonl"
    worker = DiaryWorker(diary)
    toggle = _Toggle(worker._write)
    monkeypatch.setattr(worker, "_write", toggle)

    worker.start()
    try:
        # Heal-free zone: break the disk, then append. The runtime must keep
        # accepting appends without raising.
        toggle.broken = True
        for i in range(5):
            worker.append({"runId": "r-1", "type": "command", "n": i})
        worker.wait_until_idle(timeout=2.0)

        # Degraded: nothing on disk, everything buffered, runtime operational.
        assert worker.memory_only is True
        assert worker.pending_count == 5
        assert _read_entries(diary) == []
    finally:
        worker.stop()


def test_restored_disk_flushes_buffer_in_order_and_resumes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """R10.4: on recovery the buffer flushes in FIFO order, then appends resume."""
    diary = tmp_path / "session_diary.jsonl"
    fallbacks: list[BaseException] = []
    recoveries: list[int] = []
    worker = DiaryWorker(
        diary,
        on_fallback=fallbacks.append,
        on_recovery=lambda: recoveries.append(1),
    )
    toggle = _Toggle(worker._write)
    monkeypatch.setattr(worker, "_write", toggle)

    worker.start()
    try:
        # Break disk and buffer three entries.
        toggle.broken = True
        for i in range(3):
            worker.append({"runId": "r-1", "type": "command", "n": i})
        worker.wait_until_idle(timeout=2.0)
        assert worker.memory_only is True
        assert len(fallbacks) == 1  # fallback fired exactly once

        # Restore disk capability and ask the worker to flush.
        toggle.broken = False
        worker.flush(timeout=2.0)

        # Buffer flushed in original order, back to normal mode.
        assert worker.memory_only is False
        assert worker.pending_count == 0
        assert [e["payload"]["n"] for e in _read_entries(diary)] == [0, 1, 2]
        assert recoveries == [1]

        # Subsequent appends resume normal disk writes.
        worker.append({"runId": "r-1", "type": "command", "n": 3})
        worker.wait_until_idle(timeout=2.0)
        assert [e["payload"]["n"] for e in _read_entries(diary)] == [0, 1, 2, 3]
    finally:
        worker.stop()


def test_no_reordering_across_fallback_and_recovery(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """R9.4 holds across a fallback: entries written before/after stay in FIFO order."""
    diary = tmp_path / "session_diary.jsonl"
    worker = DiaryWorker(diary)
    toggle = _Toggle(worker._write)
    monkeypatch.setattr(worker, "_write", toggle)

    worker.start()
    try:
        # 0,1 written to disk normally.
        worker.append({"type": "command", "n": 0})
        worker.append({"type": "command", "n": 1})
        worker.wait_until_idle(timeout=2.0)

        # 2,3 buffered while disk is broken.
        toggle.broken = True
        worker.append({"type": "command", "n": 2})
        worker.append({"type": "command", "n": 3})
        worker.wait_until_idle(timeout=2.0)
        assert worker.memory_only is True

        # Recovery flushes 2,3 after 0,1 — never ahead of them.
        toggle.broken = False
        worker.append({"type": "command", "n": 4})  # triggers drain too
        worker.wait_until_idle(timeout=2.0)
    finally:
        worker.stop()

    assert [e["payload"]["n"] for e in _read_entries(diary)] == [0, 1, 2, 3, 4]


def test_recovery_triggered_by_next_append_without_explicit_flush(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A normal append after disk heals is enough to flush the buffer in order."""
    diary = tmp_path / "session_diary.jsonl"
    worker = DiaryWorker(diary)
    toggle = _Toggle(worker._write)
    monkeypatch.setattr(worker, "_write", toggle)

    worker.start()
    try:
        toggle.broken = True
        worker.append({"type": "command", "n": 0})
        worker.wait_until_idle(timeout=2.0)
        assert worker.memory_only is True

        toggle.broken = False
        worker.append({"type": "command", "n": 1})
        worker.wait_until_idle(timeout=2.0)
        assert worker.memory_only is False
    finally:
        worker.stop()

    assert [e["payload"]["n"] for e in _read_entries(diary)] == [0, 1]


def test_fallback_hook_exception_does_not_break_worker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A throwing observability hook must not take down the runtime (R10.1)."""
    diary = tmp_path / "session_diary.jsonl"

    def _boom(_exc: BaseException) -> None:
        raise RuntimeError("hook blew up")

    worker = DiaryWorker(diary, on_fallback=_boom)
    toggle = _Toggle(worker._write)
    monkeypatch.setattr(worker, "_write", toggle)

    worker.start()
    try:
        toggle.broken = True
        worker.append({"type": "command", "n": 0})
        worker.wait_until_idle(timeout=2.0)
        # Despite the throwing hook, the worker is still degraded-but-alive and
        # keeps accepting appends.
        assert worker.memory_only is True
        worker.append({"type": "command", "n": 1})
        worker.wait_until_idle(timeout=2.0)
        assert worker.pending_count == 2

        toggle.broken = False
        worker.flush(timeout=2.0)
    finally:
        worker.stop()

    assert [e["payload"]["n"] for e in _read_entries(diary)] == [0, 1]


def test_append_stays_non_blocking_during_disk_outage(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """R9.3 + R10.1: appends return promptly even while the disk is failing."""
    diary = tmp_path / "session_diary.jsonl"
    worker = DiaryWorker(diary)
    toggle = _Toggle(worker._write)
    monkeypatch.setattr(worker, "_write", toggle)

    worker.start()
    try:
        toggle.broken = True
        start = time.monotonic()
        for i in range(100):
            worker.append({"type": "command", "n": i})
        elapsed = time.monotonic() - start
        assert elapsed < 0.5
    finally:
        worker.stop()


# ── R10.3: Orchestrator reconstruction from the trailing diary ───────────────


def _write_diary(path: Path, records: list[dict[str, Any]]) -> None:
    lines = [json.dumps(r, sort_keys=True) for r in records]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def test_reconstruct_returns_none_for_missing_or_empty_diary(tmp_path: Path) -> None:
    assert reconstruct_run_state(tmp_path / "absent.jsonl") is None
    empty = tmp_path / "session_diary.jsonl"
    empty.write_text("", encoding="utf-8")
    assert reconstruct_run_state(empty) is None


def test_reconstruct_selects_active_run_and_preserves_order(tmp_path: Path) -> None:
    """R10.3: trailing entries of the active run are replayed in original order."""
    diary = tmp_path / "session_diary.jsonl"
    _write_diary(
        diary,
        [
            # An older, completed run that must be ignored.
            {"seq": 0, "runId": "old", "type": "intent", "ts": "t", "payload": {"type": "intent"}},
            {"seq": 1, "runId": "old", "type": "done", "ts": "t", "payload": {"type": "done"}},
            # The active run.
            {"seq": 2, "runId": "r-1", "type": "intent", "ts": "t", "payload": {"type": "intent"}},
            {
                "seq": 3,
                "runId": "r-1",
                "type": "read-files",
                "ts": "t",
                "payload": {"type": "read-files", "files": [{"path": "a.py"}, {"path": "b.py"}]},
            },
            {
                "seq": 4,
                "runId": "r-1",
                "type": "edit-file",
                "ts": "t",
                "payload": {"type": "edit-file", "path": "a.py", "diff": "@@ -1 +1 @@"},
            },
        ],
    )

    run = reconstruct_run_state(diary)
    assert run is not None
    assert run.run_id == "r-1"
    # Only the active run's entries, in original FIFO order.
    assert [e.seq for e in run.entries] == [2, 3, 4]
    # Derived resumable state.
    assert run.state.stage is Stage.APPLY_EDITS
    assert run.state.active_file_markers == ["a.py", "b.py"]
    assert [d.path for d in run.state.patch_diffs] == ["a.py"]
    assert run.state.patch_diffs[0].diff == "@@ -1 +1 @@"


def test_reconstruct_recovers_stage_from_thinking_and_command(tmp_path: Path) -> None:
    """Stage is read from thinking text and synthetic ``<stage:...>`` commands."""
    diary = tmp_path / "session_diary.jsonl"
    _write_diary(
        diary,
        [
            {
                "seq": 0,
                "runId": "r",
                "type": "thinking",
                "ts": "t",
                "payload": {"type": "thinking", "text": "plan_edits"},
            },
            {
                "seq": 1,
                "runId": "r",
                "type": "command",
                "ts": "t",
                "payload": {"type": "command", "command": "pytest", "exitCode": 1, "errorTag": "boom"},
            },
        ],
    )

    run = reconstruct_run_state(diary)
    assert run is not None
    # Last stage-bearing event is the real RUN_CHECKS command.
    assert run.state.stage is Stage.RUN_CHECKS
    assert len(run.state.compilation_logs) == 1
    rec = run.state.compilation_logs[0]
    assert rec.command == "pytest"
    assert rec.exit_code == 1
    assert rec.log == "boom"


def test_reconstruct_tolerates_torn_trailing_line(tmp_path: Path) -> None:
    """A partial final line from a connection drop is skipped, not fatal (R10.3)."""
    diary = tmp_path / "session_diary.jsonl"
    good = json.dumps(
        {"seq": 0, "runId": "r", "type": "intent", "ts": "t", "payload": {"type": "intent"}},
        sort_keys=True,
    )
    # Second line is a truncated/torn JSON object.
    diary.write_text(good + "\n" + '{"seq": 1, "runId": "r", "type": "comm', encoding="utf-8")

    run = reconstruct_run_state(diary)
    assert run is not None
    assert [e.seq for e in run.entries] == [0]
    assert run.state.stage is Stage.INTAKE


def test_reconstruct_round_trips_a_live_worker_diary(tmp_path: Path) -> None:
    """End to end: what the Diary_Worker persists is what reconstruction replays."""
    diary = tmp_path / "session_diary.jsonl"
    events: list[dict[str, Any]] = [
        {"runId": "r-9", "type": "intent", "text": "go"},
        {"runId": "r-9", "type": "read-files", "files": [{"path": "x.py"}]},
        {"runId": "r-9", "type": "edit-file", "path": "x.py", "diff": "d"},
        {"runId": "r-9", "type": "summary", "text": "done-ish"},
    ]
    with DiaryWorker(diary) as worker:
        for ev in events:
            worker.append(ev)
        worker.wait_until_idle(timeout=2.0)

    run = reconstruct_run_state(diary)
    assert run is not None
    assert run.run_id == "r-9"
    assert [dict(e.payload) for e in run.entries] == events
    assert run.state.stage is Stage.SUMMARY
    assert run.state.active_file_markers == ["x.py"]


def test_reconstruct_threaded_concurrent_diary_is_consistent(tmp_path: Path) -> None:
    """Concurrent producers still yield a diary that reconstructs to ordered state."""
    diary = tmp_path / "session_diary.jsonl"
    with DiaryWorker(diary) as worker:

        def produce(tag: int) -> None:
            for i in range(25):
                worker.append({"runId": "r-c", "type": "command", "tag": tag, "i": i})

        threads = [threading.Thread(target=produce, args=(t,)) for t in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        worker.wait_until_idle(timeout=5.0)

    run = reconstruct_run_state(diary)
    assert run is not None
    # 100 entries, replayed in ascending seq (FIFO) order.
    assert len(run.entries) == 100
    assert [e.seq for e in run.entries] == sorted(e.seq for e in run.entries)
