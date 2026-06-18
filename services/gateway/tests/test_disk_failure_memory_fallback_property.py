"""Property test for disk-failure memory fallback without loss (task 9.8).

Feature: zocai-ecosystem-rebuild, Property 40: Disk-write failure falls back to
memory without data loss.

**Validates: Requirements 10.1, 10.4**

Design Property 40 (verbatim intent): *For any* point at which a ``.zocai/``
write raises an exception, the Diary_Worker switches to memory-only tracking,
the runtime stays operational, and when disk capability is restored the buffered
entries are flushed in their original order before normal appends resume.

The behaviour under test lives in
:class:`zocai_gateway.memory.diary_worker.DiaryWorker`. The property is
exercised against the real worker (no mocks of its buffering/draining logic)
over arbitrary interleavings of appends and disk-failure windows. The only
injected seam is a *toggleable* ``_write`` that raises ``OSError`` while the
simulated ``.zocai/`` disk is "broken" and performs the genuine append
otherwise — exactly how a real ``.zocai/`` write would fail and recover.

For every generated schedule the test asserts the three halves of Property 40:

* **No loss during failure (R10.1).** Entries appended while the disk is broken
  are never written to disk yet; they stay buffered in memory and the on-disk
  log does not grow.
* **Runtime stays operational (R10.1).** ``append`` never raises during an
  outage, the worker reports ``memory_only`` while it holds buffered entries,
  and it keeps accepting new appends.
* **Ordered flush on recovery (R10.4).** Once disk capability is restored the
  buffered entries are flushed in their original FIFO order ahead of any later
  appends, leaving the complete log with no loss and no reordering.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Any

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from zocai_gateway.memory import DiaryWorker
from zocai_gateway.memory.diary_worker import DiaryEntry


def _read_indices(diary_path: Path) -> list[int]:
    """Return the FIFO ``n`` tags persisted on disk, in on-disk order."""
    if not diary_path.exists():
        return []
    text = diary_path.read_text(encoding="utf-8")
    records: list[dict[str, Any]] = [json.loads(line) for line in text.splitlines() if line]
    return [int(r["payload"]["n"]) for r in records]


class _Toggle:
    """A toggleable ``.zocai/`` disk: ``write`` raises while ``broken`` (R10.1)."""

    def __init__(self, real_write: Any) -> None:
        self.broken = False
        self._real_write = real_write

    def __call__(self, entry: DiaryEntry) -> None:
        if self.broken:
            raise OSError("disk is full")
        self._real_write(entry)


# A schedule is a sequence of phases. Each phase appends ``count`` entries while
# the simulated disk is either healthy or broken, letting Hypothesis explore the
# failure-injection point landing before, during, and after any append.
_PHASES = st.lists(
    st.tuples(
        st.booleans(),  # disk broken during this phase?
        st.integers(min_value=0, max_value=5),  # entries appended in this phase
    ),
    min_size=0,
    max_size=12,
)


@settings(
    max_examples=120,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow],
)
@given(phases=_PHASES)
def test_disk_failure_falls_back_to_memory_without_loss(
    phases: list[tuple[bool, int]],
) -> None:
    """Property 40: memory-only fallback loses nothing and flushes in order.

    Feature: zocai-ecosystem-rebuild, Property 40

    **Validates: Requirements 10.1, 10.4**
    """
    # A fresh directory + worker per example keeps the runs independent (no
    # function-scoped fixtures, which Hypothesis would not reset per input).
    with tempfile.TemporaryDirectory() as base:
        diary = Path(base) / "session_diary.jsonl"
        worker = DiaryWorker(diary)
        toggle = _Toggle(worker._write)
        # The worker is freshly constructed for this example, so replacing its
        # write seam directly is safe and needs no fixture teardown.
        worker._write = toggle  # type: ignore[method-assign]

        next_index = 0
        returned_seqs: list[int] = []
        # Indices we expect to already be persisted on disk, in FIFO order.
        expected_on_disk: list[int] = []
        # Indices accepted but still buffered in memory (a disk outage is
        # holding them, or they have not been drained yet).
        buffered: list[int] = []

        worker.start()
        try:
            for broken, count in phases:
                toggle.broken = broken

                for _ in range(count):
                    # R10.1 (operational): append must never raise, even
                    # mid-outage.
                    seq = worker.append(
                        {"runId": "r-1", "type": "command", "n": next_index}
                    )
                    returned_seqs.append(seq)
                    buffered.append(next_index)
                    next_index += 1

                # Force a deterministic drain attempt for this phase's disk
                # state, then observe the result once the consumer is idle.
                worker.flush(timeout=5.0)

                if toggle.broken:
                    # R10.1 (no loss during failure): whatever is buffered stays
                    # in memory; the on-disk log does not grow during the outage.
                    assert _read_indices(diary) == expected_on_disk
                    if buffered:
                        # Buffered work + a failed write ⇒ degraded but operational.
                        assert worker.memory_only is True
                        assert worker.pending_count == len(buffered)
                else:
                    # R10.4 (ordered flush on recovery): a healthy drain flushes
                    # the buffered entries in their original FIFO order, then
                    # resumes normal appends.
                    expected_on_disk.extend(buffered)
                    buffered.clear()
                    assert worker.memory_only is False
                    assert worker.pending_count == 0
                    assert _read_indices(diary) == expected_on_disk
        finally:
            # Restore disk capability and drain on stop so the final state is
            # observable regardless of the last phase.
            toggle.broken = False
            worker.stop(drain=True)

        all_indices = list(range(next_index))
        # Every append got a contiguous FIFO seq, and nothing was lost or
        # reordered: the complete log is exactly the emission order
        # (R10.1 + R10.4).
        assert returned_seqs == all_indices
        assert _read_indices(diary) == all_indices
