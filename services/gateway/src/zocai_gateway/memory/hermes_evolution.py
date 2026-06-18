"""Tier 3 — Hermes-Evolution / GEPA idle loop (task 9.4, R9.7).

Hermes-Evolution is the Tier 3 store of the memory matrix. It owns a single
background, *idle-only* loop that improves the agent's prompt scripts over time
without ever interfering with live work. Two invariants drive this module:

* **Idle-only trigger (R9.7).** The loop performs an evolution cycle only
  *while no Agent_Mode run has been active for at least 60 seconds*. Activity is
  reported through :meth:`HermesEvolution.begin_run` / :meth:`end_run`; the loop
  treats the matrix as idle exactly when there is no in-flight run **and** at
  least ``idle_seconds`` have elapsed since the last run ended.
* **Never blocks an active run (R9.7).** All evolution work runs on a dedicated
  daemon thread. ``begin_run``/``end_run`` only touch in-memory counters under a
  short lock and never wait on the (potentially slow) GEPA step or disk IO, so a
  newly-started run is never stalled by an in-progress cycle.

An evolution cycle reads the historical execution traces from the Tier 1
Session_Diary (``.zocai/session_diary.jsonl``), feeds them through the GEPA
prompt-evolution **seam**, and writes the evolved prompt scripts to
``.zocai/hermes-evolution/SKILL.md`` together with the GEPA population/Pareto
state at ``gepa_state.json`` (all paths come from
:class:`~zocai_gateway.memory.matrix.MemoryMatrix`).

The GEPA step itself is a clear seam (:class:`GepaStep`): callers may inject a
real Genetic-Pareto implementation, but the default
:class:`DeterministicGepaStub` keeps this task self-contained and fully
deterministic. Only the idle-trigger and non-blocking background behavior are
load-bearing here; the genetic search is intentionally deferred behind the seam.
"""

from __future__ import annotations

import json
import os
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from types import TracebackType
from typing import Any, Protocol, runtime_checkable

from zocai_gateway.memory.matrix import MemoryMatrix

__all__ = [
    "DEFAULT_IDLE_SECONDS",
    "DEFAULT_POLL_INTERVAL",
    "DeterministicGepaStub",
    "GepaResult",
    "GepaStep",
    "HermesEvolution",
    "Trace",
]

#: A run must have been over for at least this many seconds before the loop is
#: allowed to evolve (R9.7: "no Agent_Mode run has been active for at least 60
#: seconds").
DEFAULT_IDLE_SECONDS = 60.0

#: How often the background loop wakes to re-check the idle condition. Kept well
#: below ``idle_seconds`` so the trigger fires promptly once the matrix settles.
DEFAULT_POLL_INTERVAL = 1.0


# ── Trace + GEPA seam ────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Trace:
    """One historical execution trace lifted from the Session_Diary.

    A trace is a thin, read-only view over a single Tier 1 diary line: the FIFO
    ``seq``, the originating ``run_id`` and event ``type``, and the full
    ``payload``. GEPA consumes a sequence of these to mine the prompt scripts.
    """

    seq: int
    run_id: str
    type: str
    payload: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class GepaResult:
    """The output of one GEPA step: the new ``SKILL.md`` body and GEPA state.

    :attr:`skill_md` is written verbatim to ``SKILL.md``; :attr:`gepa_state` is
    JSON-serialized to ``gepa_state.json`` (the GEPA population / Pareto front).
    """

    skill_md: str
    gepa_state: Mapping[str, Any] = field(default_factory=dict)


@runtime_checkable
class GepaStep(Protocol):
    """The Genetic-Pareto prompt-evolution seam.

    An implementation receives the historical ``traces``, the ``current_skill``
    body, and the prior ``gepa_state``, and returns the evolved
    :class:`GepaResult`. The default :class:`DeterministicGepaStub` stands in for
    a real genetic search so the idle loop is testable end to end; swapping in a
    production GEPA backend requires no change to :class:`HermesEvolution`.
    """

    def __call__(
        self,
        traces: Sequence[Trace],
        current_skill: str,
        gepa_state: Mapping[str, Any],
    ) -> GepaResult: ...


class DeterministicGepaStub:
    """A deterministic stand-in for GEPA prompt evolution (the seam default).

    It does no genetic search: it bumps a ``generation`` counter, records how
    many traces it has assessed so far, and renders a stable ``SKILL.md`` summary
    of the traces seen. Being deterministic, the same inputs always yield the
    same outputs, which keeps the idle loop's behavior reproducible in tests.
    """

    def __call__(
        self,
        traces: Sequence[Trace],
        current_skill: str,
        gepa_state: Mapping[str, Any],
    ) -> GepaResult:
        prior_generation = gepa_state.get("generation")
        generation = (prior_generation if isinstance(prior_generation, int) else 0) + 1

        # Distinct run ids observed across the traces, in first-seen order, so
        # the rendered summary is stable and human-readable.
        run_ids: list[str] = []
        for trace in traces:
            if trace.run_id and trace.run_id not in run_ids:
                run_ids.append(trace.run_id)

        new_state: dict[str, Any] = {
            "generation": generation,
            "assessed_traces": len(traces),
            "observed_runs": len(run_ids),
        }

        lines = [
            "# SKILL.md",
            "",
            "<!-- Evolved by Hermes-Evolution (GEPA). Deterministic stub. -->",
            f"- generation: {generation}",
            f"- assessed traces: {len(traces)}",
            f"- observed runs: {len(run_ids)}",
        ]
        skill_md = "\n".join(lines) + "\n"
        return GepaResult(skill_md=skill_md, gepa_state=new_state)


# ── The idle loop ─────────────────────────────────────────────────────────────


class HermesEvolution:
    """Tier 3 background, idle-only GEPA prompt-evolution loop (R9.7).

    Wire one instance to the workspace :class:`MemoryMatrix`. Report run
    boundaries with :meth:`begin_run`/:meth:`end_run` (or the :meth:`active_run`
    context manager); start the background thread with :meth:`start` (or use the
    instance as a context manager). The loop evolves ``SKILL.md`` only once the
    matrix has been idle for ``idle_seconds`` and a new trace has appeared since
    the last cycle.

    The ``clock`` is injectable so tests can drive the idle timer deterministically
    without sleeping for a real minute.
    """

    def __init__(
        self,
        matrix: MemoryMatrix,
        *,
        idle_seconds: float = DEFAULT_IDLE_SECONDS,
        poll_interval: float = DEFAULT_POLL_INTERVAL,
        gepa_step: GepaStep | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if idle_seconds < 0:
            raise ValueError("idle_seconds must be non-negative")
        if poll_interval <= 0:
            raise ValueError("poll_interval must be positive")

        self._matrix = matrix
        self._idle_seconds = idle_seconds
        self._poll_interval = poll_interval
        self._gepa_step: GepaStep = gepa_step if gepa_step is not None else DeterministicGepaStub()
        self._clock = clock

        # Activity tracking. ``_active_runs`` counts in-flight Agent_Mode runs;
        # ``_last_activity`` is the clock reading at the most recent run boundary
        # (start or end). Both are guarded by ``_lock`` so ``begin_run`` /
        # ``end_run`` stay atomic with the loop's idle check.
        self._lock = threading.Lock()
        self._active_runs = 0
        self._last_activity = self._clock()

        # The number of diary traces folded into the last evolution cycle, used
        # to avoid re-evolving when no new trace has been recorded.
        self._processed_trace_count = 0

        # Background loop machinery.
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._started = False

    # -- Activity reporting (non-blocking, R9.7) ---------------------------

    def begin_run(self) -> None:
        """Mark an Agent_Mode run as active (suppresses evolution).

        Cheap and non-blocking: it only increments the in-flight counter and
        stamps the activity clock under a short lock, so starting a run is never
        delayed by an in-progress evolution cycle (which runs on its own thread
        and does not hold this lock during its work).
        """
        with self._lock:
            self._active_runs += 1
            self._last_activity = self._clock()

    def end_run(self) -> None:
        """Mark an Agent_Mode run as finished and (re)start the idle timer.

        The ``idle_seconds`` countdown is measured from this moment, so a fresh
        run that ends resets the clock and defers the next evolution cycle.
        """
        with self._lock:
            if self._active_runs > 0:
                self._active_runs -= 1
            self._last_activity = self._clock()

    class _ActiveRun:
        """Context manager returned by :meth:`active_run`."""

        def __init__(self, hermes: HermesEvolution) -> None:
            self._hermes = hermes

        def __enter__(self) -> None:
            self._hermes.begin_run()

        def __exit__(
            self,
            exc_type: type[BaseException] | None,
            exc: BaseException | None,
            tb: TracebackType | None,
        ) -> None:
            self._hermes.end_run()

    def active_run(self) -> HermesEvolution._ActiveRun:
        """Scope an active run with ``with hermes.active_run(): ...``."""
        return HermesEvolution._ActiveRun(self)

    def is_idle(self) -> bool:
        """Whether the matrix is idle enough to evolve (R9.7).

        True iff there is no in-flight run **and** at least ``idle_seconds`` have
        elapsed since the last run boundary.
        """
        with self._lock:
            if self._active_runs > 0:
                return False
            return (self._clock() - self._last_activity) >= self._idle_seconds

    # -- Evolution cycle ---------------------------------------------------

    def run_once(self) -> bool:
        """Run one evolution cycle if (and only if) the matrix is idle.

        Returns ``True`` when a cycle ran (``SKILL.md``/``gepa_state.json`` were
        updated) and ``False`` when the matrix was not idle or no new trace had
        been recorded since the previous cycle. This is the synchronous unit the
        background loop drives; calling it directly is the deterministic way to
        exercise a single cycle in tests.
        """
        if not self.is_idle():
            return False

        traces = self._read_traces()
        # Skip redundant work when nothing new has been recorded since the last
        # cycle — the loop would otherwise re-evolve every poll while idle.
        if len(traces) <= self._processed_trace_count:
            return False

        self._evolve(traces)
        self._processed_trace_count = len(traces)
        return True

    def _evolve(self, traces: Sequence[Trace]) -> None:
        """Feed ``traces`` through the GEPA seam and persist the result."""
        current_skill = self._read_text(self._matrix.skill_path)
        gepa_state = self._read_json_object(self._matrix.gepa_state_path)

        result = self._gepa_step(traces, current_skill, gepa_state)

        self._atomic_write(self._matrix.skill_path, result.skill_md)
        self._atomic_write(
            self._matrix.gepa_state_path,
            json.dumps(dict(result.gepa_state), ensure_ascii=False, indent=2, sort_keys=True)
            + "\n",
        )

    def _read_traces(self) -> list[Trace]:
        """Read historical execution traces from the Tier 1 Session_Diary.

        Each non-empty line is one diary entry; a malformed trailing line (e.g. a
        partial write racing an append) is tolerated and skipped so a concurrent
        Diary_Worker never crashes the loop.
        """
        path = self._matrix.session_diary_path
        try:
            text = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return []

        traces: list[Trace] = []
        for line in text.splitlines():
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                # Skip a partially-written trailing line; complete lines remain.
                continue
            if not isinstance(record, dict):
                continue
            payload = record.get("payload")
            traces.append(
                Trace(
                    seq=int(record["seq"]) if isinstance(record.get("seq"), int) else len(traces),
                    run_id=str(record.get("runId", "")),
                    type=str(record.get("type", "")),
                    payload=payload if isinstance(payload, dict) else {},
                )
            )
        return traces

    @staticmethod
    def _read_text(path: Path) -> str:
        try:
            return path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return ""

    @staticmethod
    def _read_json_object(path: Path) -> Mapping[str, Any]:
        try:
            text = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return {}
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return {}
        return data if isinstance(data, dict) else {}

    @staticmethod
    def _atomic_write(path: Path, content: str) -> None:
        """Write ``content`` to ``path`` atomically via a temp file + replace.

        A half-written ``SKILL.md`` or ``gepa_state.json`` is never observable to
        a reader, even if the process dies mid-cycle.
        """
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        with tmp.open("w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)

    # -- Background lifecycle ----------------------------------------------

    def start(self) -> None:
        """Start the idle-only background loop on a daemon thread (idempotent)."""
        if self._started:
            return
        self._started = True
        self._stop_event.clear()
        thread = threading.Thread(
            target=self._loop,
            name="zocai-hermes-evolution",
            daemon=True,
        )
        self._thread = thread
        thread.start()

    def stop(self) -> None:
        """Signal the background loop to exit and join its thread."""
        if not self._started:
            return
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join()
            self._thread = None
        self._started = False

    def _loop(self) -> None:
        """Poll the idle condition and evolve when idle, until stopped.

        The loop sleeps on the stop event between polls, so :meth:`stop` wakes it
        immediately rather than waiting out the poll interval.
        """
        while not self._stop_event.is_set():
            try:
                self.run_once()
            except OSError:
                # Disk hiccups must not kill the loop; the next poll retries.
                pass
            self._stop_event.wait(self._poll_interval)

    def __enter__(self) -> HermesEvolution:
        self.start()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.stop()
