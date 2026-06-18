"""Combined example test for the Layer 4 memory matrix invariants (task 9.10).

One example-based suite that pins the three memory-matrix rules together, the
way the runtime relies on them:

* **`.zocai/` confinement (R9.1)** — every store the ``MemoryMatrix`` owns
  resolves *under* the workspace ``.zocai/`` directory, and initialization
  never creates a file or directory outside that subtree.
* **Non-blocking append (R9.3)** — ``DiaryWorker.append`` returns without
  waiting on the Session_Diary disk write, so SSE emission latency is decoupled
  from disk latency even when the write itself is slow.
* **Idle-only Hermes (R9.7)** — ``HermesEvolution`` runs an evolution cycle only
  while no Agent_Mode run has been active for at least ``idle_seconds`` (and a
  run is in flight suppresses it), and reporting a run boundary never blocks on
  an in-progress cycle.

The fuller property/edge coverage lives in ``test_memory_matrix_init.py``,
``test_diary_worker.py`` and ``test_hermes_evolution.py``; this suite is the
worked example that demonstrates the three rules holding together.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from zocai_gateway.memory import (
    DiaryWorker,
    GepaResult,
    HermesEvolution,
    MemoryMatrix,
    Trace,
)
from zocai_gateway.memory.diary_worker import DiaryEntry


class _FakeClock:
    """A manually-advanced monotonic clock for deterministic idle timing."""

    def __init__(self, start: float = 0.0) -> None:
        self._now = start

    def __call__(self) -> float:
        return self._now

    def advance(self, seconds: float) -> None:
        self._now += seconds


# --------------------------------------------------------------------------- #
# R9.1 — every store is confined under ``.zocai/``
# --------------------------------------------------------------------------- #


def test_all_matrix_stores_are_confined_under_zocai(tmp_path: Path) -> None:
    matrix = MemoryMatrix(tmp_path)
    matrix.initialize()

    zocai = (tmp_path / ".zocai").resolve()
    assert matrix.zocai_dir == zocai

    # Every owned directory and sub-store resolves under ``.zocai/`` (R9.1).
    for path in (*matrix.directories(), *matrix.files()):
        resolved = path.resolve()
        assert resolved == zocai or zocai in resolved.parents, (
            f"{resolved} escaped the .zocai/ subtree"
        )


def test_initialize_creates_nothing_outside_zocai(tmp_path: Path) -> None:
    # A workspace that contains only a pre-existing sentinel file.
    (tmp_path / "keep.txt").write_text("untouched", encoding="utf-8")

    matrix = MemoryMatrix(tmp_path)
    matrix.initialize()

    # The only new top-level entry in the workspace root is ``.zocai/`` (R9.1):
    # initialization confines all of its writes to that subtree.
    top_level = {p.name for p in tmp_path.iterdir()}
    assert top_level == {"keep.txt", ".zocai"}
    assert (tmp_path / "keep.txt").read_text(encoding="utf-8") == "untouched"
    assert matrix.is_initialized() is True


# --------------------------------------------------------------------------- #
# R9.3 — append is non-blocking even when the disk write is slow
# --------------------------------------------------------------------------- #


def test_append_returns_promptly_with_a_slow_write(tmp_path: Path) -> None:
    """R9.3: ``append`` must return promptly even while ``_write`` is blocked.

    We park the single consumer inside an artificially slow ``_write`` and time
    a producer-side ``append``. Because ``append`` only assigns a FIFO ``seq``
    and enqueues, it must return well before the (5 s) write would finish.
    """
    matrix = MemoryMatrix(tmp_path)
    matrix.initialize()

    release = threading.Event()
    worker = DiaryWorker(matrix.session_diary_path)
    original_write = worker._write

    def _slow_write(entry: DiaryEntry) -> None:
        # Block the consumer far longer than append should ever take.
        release.wait(timeout=5.0)
        original_write(entry)

    worker._write = _slow_write  # type: ignore[method-assign]
    worker.start()
    try:
        # First append occupies the consumer inside the slow write.
        worker.append({"runId": "r-1", "type": "command", "n": 0})
        time.sleep(0.05)  # let the consumer pick up entry 0 and block on it

        start = time.monotonic()
        seq = worker.append({"runId": "r-1", "type": "command", "n": 1})
        elapsed = time.monotonic() - start

        # The producer returned without waiting on the blocked disk write.
        assert elapsed < 0.5
        assert seq == 1
        # And while the write is blocked, nothing has been flushed yet, which
        # confirms the producer did not synchronously drive the write.
        assert matrix.session_diary_path.read_text(encoding="utf-8") == ""
    finally:
        release.set()
        worker.stop()

    # After release, both entries land on disk in FIFO order.
    lines = [
        line
        for line in matrix.session_diary_path.read_text(encoding="utf-8").splitlines()
        if line
    ]
    assert len(lines) == 2


# --------------------------------------------------------------------------- #
# R9.7 — Hermes evolves only when idle, and begin_run never blocks
# --------------------------------------------------------------------------- #


def _seed_diary(matrix: MemoryMatrix, count: int, *, run_id: str = "r-1") -> None:
    """Synchronously append ``count`` diary lines (no worker thread needed)."""
    import json

    with matrix.session_diary_path.open("a", encoding="utf-8") as handle:
        for i in range(count):
            handle.write(
                json.dumps(
                    {"seq": i, "runId": run_id, "type": "command", "payload": {"n": i}}
                )
                + "\n"
            )


def test_hermes_does_not_evolve_while_a_run_is_active(tmp_path: Path) -> None:
    clock = _FakeClock()
    matrix = MemoryMatrix(tmp_path)
    matrix.initialize()
    _seed_diary(matrix, 3)

    hermes = HermesEvolution(matrix, idle_seconds=60.0, clock=clock)
    hermes.begin_run()
    clock.advance(1000.0)  # plenty of wall time, but a run is still active

    assert hermes.is_idle() is False
    assert hermes.run_once() is False
    # SKILL.md is left at its initialized (empty) content while not idle.
    assert matrix.skill_path.read_text(encoding="utf-8") == ""


def test_hermes_evolves_only_after_idle_threshold_elapses(tmp_path: Path) -> None:
    clock = _FakeClock()
    matrix = MemoryMatrix(tmp_path)
    matrix.initialize()
    _seed_diary(matrix, 3)

    hermes = HermesEvolution(matrix, idle_seconds=60.0, clock=clock)
    hermes.begin_run()
    hermes.end_run()

    # Just under the threshold: still not idle, no cycle.
    clock.advance(59.0)
    assert hermes.is_idle() is False
    assert hermes.run_once() is False

    # At the threshold: idle, the cycle runs and updates SKILL.md.
    clock.advance(1.0)
    assert hermes.is_idle() is True
    assert hermes.run_once() is True
    assert "assessed traces: 3" in matrix.skill_path.read_text(encoding="utf-8")


def test_begin_run_does_not_block_on_an_in_progress_cycle(tmp_path: Path) -> None:
    """R9.7: starting a run must not wait on an in-progress evolution cycle."""
    matrix = MemoryMatrix(tmp_path)
    matrix.initialize()
    _seed_diary(matrix, 1)

    in_gepa = threading.Event()
    release = threading.Event()

    def _slow_gepa(
        traces: Sequence[Trace],
        current_skill: str,
        gepa_state: Mapping[str, Any],
    ) -> GepaResult:
        in_gepa.set()
        release.wait(timeout=5.0)
        return GepaResult(skill_md="# done\n", gepa_state={"generation": 1})

    # idle_seconds=0 so the background loop is immediately eligible to evolve.
    hermes = HermesEvolution(
        matrix, idle_seconds=0.0, poll_interval=0.01, gepa_step=_slow_gepa
    )
    hermes.start()
    try:
        assert in_gepa.wait(timeout=2.0), "evolution cycle never started"
        # The cycle is parked inside the slow GEPA step. begin_run must return
        # immediately rather than waiting for that cycle to finish.
        start = time.monotonic()
        hermes.begin_run()
        elapsed = time.monotonic() - start
        assert elapsed < 0.5
    finally:
        release.set()
        hermes.stop()


if __name__ == "__main__":  # pragma: no cover
    import pytest

    raise SystemExit(pytest.main([__file__, "-v"]))
