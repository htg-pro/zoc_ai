"""Tests for the Tier 3 Hermes-Evolution idle loop (task 9.4, R9.7).

These cover the two task invariants:

* **Idle-only trigger (R9.7)** — an evolution cycle runs only while no
  Agent_Mode run has been active for at least ``idle_seconds``.
* **Never blocks an active run (R9.7)** — reporting a run boundary is cheap and
  never waits on the (possibly slow) GEPA step running on the background thread.

Both example-based and property-based (Hypothesis) tests are included; the
property test exercises the idle gate across many randomized timelines of run
boundaries and clock advances.
"""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from hypothesis import given, settings
from hypothesis import strategies as st

from zocai_gateway.memory import (
    DeterministicGepaStub,
    DiaryWorker,
    GepaResult,
    HermesEvolution,
    MemoryMatrix,
    Trace,
)


class _FakeClock:
    """A manually-advanced monotonic clock for deterministic idle timing."""

    def __init__(self, start: float = 0.0) -> None:
        self._now = start

    def __call__(self) -> float:
        return self._now

    def advance(self, seconds: float) -> None:
        self._now += seconds


def _make_matrix(tmp_path: Path) -> MemoryMatrix:
    matrix = MemoryMatrix(tmp_path)
    matrix.initialize()
    return matrix


def _seed_diary(matrix: MemoryMatrix, count: int, *, run_id: str = "r-1") -> None:
    """Synchronously append ``count`` diary lines (no worker thread needed)."""
    with matrix.session_diary_path.open("a", encoding="utf-8") as handle:
        for i in range(count):
            handle.write(
                json.dumps(
                    {"seq": i, "runId": run_id, "type": "command", "payload": {"n": i}}
                )
                + "\n"
            )


# ── Idle-trigger gating (R9.7) ───────────────────────────────────────────────


def test_not_idle_while_run_active(tmp_path: Path) -> None:
    clock = _FakeClock()
    hermes = HermesEvolution(_make_matrix(tmp_path), idle_seconds=60.0, clock=clock)
    hermes.begin_run()
    clock.advance(1000.0)  # plenty of wall time, but a run is still active
    assert hermes.is_idle() is False


def test_not_idle_before_threshold_after_run_ends(tmp_path: Path) -> None:
    clock = _FakeClock()
    hermes = HermesEvolution(_make_matrix(tmp_path), idle_seconds=60.0, clock=clock)
    hermes.begin_run()
    hermes.end_run()
    clock.advance(59.0)
    assert hermes.is_idle() is False


def test_idle_once_threshold_elapses_after_run_ends(tmp_path: Path) -> None:
    clock = _FakeClock()
    hermes = HermesEvolution(_make_matrix(tmp_path), idle_seconds=60.0, clock=clock)
    hermes.begin_run()
    hermes.end_run()
    clock.advance(60.0)
    assert hermes.is_idle() is True


def test_new_run_resets_idle_timer(tmp_path: Path) -> None:
    clock = _FakeClock()
    hermes = HermesEvolution(_make_matrix(tmp_path), idle_seconds=60.0, clock=clock)
    hermes.begin_run()
    hermes.end_run()
    clock.advance(60.0)
    assert hermes.is_idle() is True
    # A fresh run defers the next cycle: ending it restarts the countdown.
    hermes.begin_run()
    hermes.end_run()
    clock.advance(30.0)
    assert hermes.is_idle() is False


# ── Evolution cycle (R9.7) ───────────────────────────────────────────────────


def test_run_once_skips_when_not_idle(tmp_path: Path) -> None:
    clock = _FakeClock()
    matrix = _make_matrix(tmp_path)
    _seed_diary(matrix, 3)
    hermes = HermesEvolution(matrix, idle_seconds=60.0, clock=clock)
    hermes.begin_run()  # active → not idle
    assert hermes.run_once() is False
    # SKILL.md left at its initialized (empty) content.
    assert matrix.skill_path.read_text(encoding="utf-8") == ""


def test_run_once_evolves_skill_and_state_when_idle(tmp_path: Path) -> None:
    clock = _FakeClock()
    matrix = _make_matrix(tmp_path)
    _seed_diary(matrix, 3)
    hermes = HermesEvolution(matrix, idle_seconds=60.0, clock=clock)
    clock.advance(60.0)  # idle from construction time

    assert hermes.run_once() is True

    skill = matrix.skill_path.read_text(encoding="utf-8")
    assert "generation: 1" in skill
    assert "assessed traces: 3" in skill

    state = json.loads(matrix.gepa_state_path.read_text(encoding="utf-8"))
    assert state["generation"] == 1
    assert state["assessed_traces"] == 3
    assert state["observed_runs"] == 1


def test_run_once_skips_when_no_new_traces(tmp_path: Path) -> None:
    clock = _FakeClock()
    matrix = _make_matrix(tmp_path)
    _seed_diary(matrix, 2)
    hermes = HermesEvolution(matrix, idle_seconds=60.0, clock=clock)
    clock.advance(60.0)

    assert hermes.run_once() is True  # first cycle processes the 2 traces
    assert hermes.run_once() is False  # nothing new → no redundant cycle


def test_run_once_re_evolves_when_new_traces_appear(tmp_path: Path) -> None:
    clock = _FakeClock()
    matrix = _make_matrix(tmp_path)
    _seed_diary(matrix, 2)
    hermes = HermesEvolution(matrix, idle_seconds=60.0, clock=clock)
    clock.advance(60.0)

    assert hermes.run_once() is True
    _seed_diary(matrix, 1)  # a new trace lands
    assert hermes.run_once() is True

    state = json.loads(matrix.gepa_state_path.read_text(encoding="utf-8"))
    assert state["generation"] == 2
    assert state["assessed_traces"] == 3


# ── Non-blocking behavior (R9.7) ──────────────────────────────────────────────


def test_begin_run_does_not_block_on_slow_gepa(tmp_path: Path) -> None:
    """R9.7: starting a run must not wait on an in-progress evolution cycle."""
    matrix = _make_matrix(tmp_path)
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
    hermes = HermesEvolution(matrix, idle_seconds=0.0, poll_interval=0.01, gepa_step=_slow_gepa)
    hermes.start()
    try:
        assert in_gepa.wait(timeout=2.0), "evolution cycle never started"
        # The cycle is parked inside the slow GEPA step. begin_run must return
        # immediately rather than waiting for it to finish.
        start = time.monotonic()
        hermes.begin_run()
        elapsed = time.monotonic() - start
        assert elapsed < 0.5
    finally:
        release.set()
        hermes.stop()


def test_background_loop_evolves_once_idle(tmp_path: Path) -> None:
    """The daemon loop fires a cycle on its own once the matrix is idle."""
    matrix = _make_matrix(tmp_path)
    _seed_diary(matrix, 4)
    with HermesEvolution(matrix, idle_seconds=0.0, poll_interval=0.01) as hermes:
        del hermes  # the context manager started the loop; let it run
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            if matrix.skill_path.read_text(encoding="utf-8"):
                break
            time.sleep(0.02)

    assert "assessed traces: 4" in matrix.skill_path.read_text(encoding="utf-8")


def test_reads_traces_from_live_diary_worker(tmp_path: Path) -> None:
    """Traces are read from the Tier 1 Session_Diary written by the worker."""
    clock = _FakeClock()
    matrix = _make_matrix(tmp_path)
    with DiaryWorker(matrix.session_diary_path) as worker:
        for i in range(5):
            worker.append({"runId": "r-9", "type": "command", "n": i})
        worker.wait_until_idle(timeout=5.0)

    hermes = HermesEvolution(matrix, idle_seconds=60.0, clock=clock)
    clock.advance(60.0)
    assert hermes.run_once() is True
    assert "assessed traces: 5" in matrix.skill_path.read_text(encoding="utf-8")


# ── GEPA stub determinism ─────────────────────────────────────────────────────


def test_deterministic_stub_is_deterministic() -> None:
    stub = DeterministicGepaStub()
    traces = [
        Trace(seq=0, run_id="a", type="command", payload={}),
        Trace(seq=1, run_id="b", type="edit", payload={}),
        Trace(seq=2, run_id="a", type="done", payload={}),
    ]
    first = stub(traces, "", {})
    second = stub(traces, "", {})
    assert first == second
    assert first.gepa_state["observed_runs"] == 2  # distinct run ids: a, b


# ── Property-based: idle gate over randomized timelines (R9.7) ────────────────


@settings(max_examples=100, deadline=None)
@given(
    steps=st.lists(
        st.one_of(
            st.tuples(st.just("begin"), st.floats(min_value=0, max_value=120)),
            st.tuples(st.just("end"), st.floats(min_value=0, max_value=120)),
            st.tuples(st.just("wait"), st.floats(min_value=0, max_value=120)),
        ),
        min_size=0,
        max_size=30,
    ),
    idle_seconds=st.floats(min_value=1.0, max_value=60.0),
)
def test_property_idle_iff_no_active_run_and_threshold_elapsed(
    tmp_path_factory: Any, steps: list[tuple[str, float]], idle_seconds: float
) -> None:
    """Property (R9.7): the loop reports idle *iff* no run is active and at least
    ``idle_seconds`` have elapsed since the last run boundary.

    We replay a randomized timeline of run begins/ends and clock advances, then
    cross-check :meth:`HermesEvolution.is_idle` against an independent model of
    the same condition.

    **Validates: Requirements 9.7**
    """
    tmp_path = tmp_path_factory.mktemp("hermes")
    clock = _FakeClock()
    matrix = MemoryMatrix(tmp_path)
    matrix.initialize()
    hermes = HermesEvolution(matrix, idle_seconds=idle_seconds, clock=clock)

    # Independent model of the activity state.
    active = 0
    last_activity = clock()

    for kind, amount in steps:
        if kind == "begin":
            hermes.begin_run()
            active += 1
            last_activity = clock()
        elif kind == "end":
            hermes.end_run()
            if active > 0:
                active -= 1
            last_activity = clock()
        else:  # "wait"
            clock.advance(amount)

        expected_idle = active == 0 and (clock() - last_activity) >= idle_seconds
        assert hermes.is_idle() is expected_idle
