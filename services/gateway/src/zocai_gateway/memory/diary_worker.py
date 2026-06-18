"""Tier 1 Diary_Worker — non-blocking, FIFO-ordered Session_Diary append.

Every SSE event the Gateway emits is mirrored to ``.zocai/session_diary.jsonl``
(the Tier 1 append-only event log). Two invariants drive this module:

* **Non-blocking emission (R9.3).** :meth:`DiaryWorker.append` must return
  without waiting on the Session_Diary disk write, so the SSE bus latency is
  decoupled from disk latency. Appending therefore only enqueues the entry on an
  in-process queue and returns; the actual ``write`` happens off the hot path on
  a background consumer thread.
* **FIFO append order (R9.4).** The Session_Diary entries are written in the
  exact first-in-first-out order in which events were emitted. A *single*
  consumer thread draining a FIFO queue guarantees emission order equals append
  order: there is only ever one writer, and it pops in enqueue order.

Each diary line is one JSON object matching the design's "Session Diary Entry
(Tier 1)" schema::

    { "seq": 12, "runId": "r-abc", "type": "command", "ts": "...", "payload": {...} }

``seq`` is assigned atomically at enqueue time so it reflects true emission
order even though the write is asynchronous; downstream readers can rely on it
to detect ordering regressions.

**Disk-failure memory-only fallback and ordered flush-on-recovery (R10.1,
R10.4)** are layered on here by task 9.5. The single consumer keeps the
to-be-written entries in an in-memory ``_pending`` buffer and drains it to disk
in order. If a ``.zocai/`` write raises, the failed entry stays buffered, the
worker flips to a memory-only mode, and the consumer keeps accepting new
appends so the agent runtime stays operational (R10.1). On the next drain
attempt for which the disk write succeeds, the worker flushes the buffered
entries in their original FIFO order and resumes normal appending (R10.4).
Because there is still exactly one writer draining one ordered buffer, the
FIFO append-order guarantee (R9.4) is preserved across a fallback/recovery
cycle: a newer entry can never reach disk ahead of an older buffered one.
"""

from __future__ import annotations

import json
import queue
import threading
from collections import deque
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from types import TracebackType

__all__ = ["DiaryEntry", "DiaryWorker"]

#: Callback invoked (off the hot path, on the consumer thread) when the worker
#: switches to memory-only mode after a ``.zocai/`` write raises (R10.1).
FallbackHook = Callable[[BaseException], None]
#: Callback invoked when disk capability is restored and the buffered entries
#: have been flushed in order (R10.4).
RecoveryHook = Callable[[], None]


@dataclass(frozen=True, slots=True)
class DiaryEntry:
    """A single Session_Diary line (design "Session Diary Entry (Tier 1)").

    The entry wraps the full emitted event in :attr:`payload` and lifts the
    fields downstream readers index on (``seq``, ``runId``, ``type``, ``ts``)
    to the top level. :attr:`seq` is the FIFO emission index assigned at append
    time (R9.4).
    """

    seq: int
    run_id: str
    type: str
    ts: str
    payload: Mapping[str, object]

    def to_json_line(self) -> str:
        """Render the entry as one newline-terminated JSON object."""
        record: dict[str, object] = {
            "seq": self.seq,
            "runId": self.run_id,
            "type": self.type,
            "ts": self.ts,
            "payload": dict(self.payload),
        }
        # ``sort_keys`` keeps the on-disk byte layout stable for a given entry,
        # which makes the JSONL log diff-friendly and test-assertable.
        return json.dumps(record, sort_keys=True) + "\n"


# Sentinel pushed onto the queue by :meth:`DiaryWorker.stop` to terminate the
# single consumer thread once it has drained every pending entry.
_STOP = object()

# Sentinel pushed by :meth:`DiaryWorker.flush` to ask the consumer to retry the
# in-memory buffer (e.g. after disk capability is restored) without enqueuing a
# new entry. Routing recovery through the queue keeps the single-writer
# discipline intact (R9.4): only the consumer thread ever touches the buffer.
_FLUSH = object()


class DiaryWorker:
    """Single-consumer background appender for the Tier 1 Session_Diary.

    The worker owns one daemon thread that drains an unbounded FIFO queue and
    appends each entry to ``diary_path``. Producers call :meth:`append`, which
    only enqueues (R9.3 non-blocking); the thread performs the disk write in
    enqueue order (R9.4 FIFO). The worker is a context manager so callers can
    scope its lifetime and guarantee the thread is joined.
    """

    def __init__(
        self,
        diary_path: Path | str,
        *,
        on_fallback: FallbackHook | None = None,
        on_recovery: RecoveryHook | None = None,
    ) -> None:
        self._diary_path = Path(diary_path)
        # Unbounded FIFO queue: ``put`` never blocks on a bound, so ``append``
        # stays non-blocking with respect to the disk write (R9.3).
        self._queue: queue.Queue[DiaryEntry | object] = queue.Queue()
        # ``seq`` is assigned under this lock at enqueue time so the index
        # reflects true emission order even with concurrent producers (R9.4).
        self._seq_lock = threading.Lock()
        self._next_seq = 0
        self._thread: threading.Thread | None = None
        self._started = False
        self._stopped = False
        # In-memory write buffer drained by the single consumer (R10.1). Entries
        # the consumer has accepted but not yet persisted live here in FIFO
        # order; on a disk-write failure the unwritten entries simply stay
        # buffered so nothing is lost.
        self._pending: deque[DiaryEntry] = deque()
        # ``True`` once a ``.zocai/`` write has raised and the worker is running
        # memory-only; flipped back to ``False`` after a successful flush (R10.4).
        # Guarded by ``_state_lock`` because observers read it from other threads.
        self._memory_only = False
        self._state_lock = threading.Lock()
        self._on_fallback = on_fallback
        self._on_recovery = on_recovery

    # -- Lifecycle ---------------------------------------------------------

    def start(self) -> None:
        """Start the single consumer thread (idempotent)."""
        if self._started:
            return
        self._started = True
        self._stopped = False
        thread = threading.Thread(
            target=self._consume,
            name="zocai-diary-worker",
            daemon=True,
        )
        self._thread = thread
        thread.start()

    def stop(self, *, drain: bool = True) -> None:
        """Stop the consumer thread, optionally draining pending entries first.

        With ``drain=True`` (the default) the stop sentinel is appended *after*
        every already-queued entry, so all pending appends are flushed in FIFO
        order before the thread exits. The call blocks until the thread joins.
        """
        if not self._started or self._stopped:
            return
        self._stopped = True
        if drain:
            self._queue.put(_STOP)
        else:
            # Jump the queue so the thread stops promptly without flushing
            # outstanding entries.
            self._drop_pending()
            self._queue.put(_STOP)
        if self._thread is not None:
            self._thread.join()
            self._thread = None

    def __enter__(self) -> DiaryWorker:
        self.start()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.stop()

    # -- Producer API ------------------------------------------------------

    def append(self, event: Mapping[str, object]) -> int:
        """Enqueue ``event`` for appending and return its FIFO sequence number.

        Non-blocking with respect to disk (R9.3): this only assigns the FIFO
        ``seq`` and enqueues the entry; the background thread writes it later.
        The returned ``seq`` is the entry's first-in-first-out emission index
        (R9.4).
        """
        with self._seq_lock:
            seq = self._next_seq
            self._next_seq += 1
        entry = self._build_entry(seq, event)
        self._queue.put(entry)
        return seq

    # -- Resilience observation / control (R10.1, R10.4) -------------------

    @property
    def memory_only(self) -> bool:
        """Whether the worker is currently in the disk-failure fallback mode.

        ``True`` after a ``.zocai/`` write raised and before the buffered
        entries have been flushed back to disk (R10.1). Safe to read from any
        thread.
        """
        with self._state_lock:
            return self._memory_only

    @property
    def pending_count(self) -> int:
        """Number of accepted-but-not-yet-persisted entries held in memory.

        Non-zero while a disk fault keeps entries buffered (R10.1); returns to
        zero once they are flushed on recovery (R10.4).
        """
        with self._state_lock:
            return len(self._pending)

    def flush(self, timeout: float | None = None) -> None:
        """Ask the consumer to retry persisting any buffered entries.

        Used after disk capability is believed restored: it routes a flush
        request through the queue so the single consumer thread re-attempts the
        buffered writes in FIFO order (R10.4) without violating the
        single-writer discipline (R9.4). Blocks until the request is processed.
        """
        if not self._started or self._stopped:
            return
        self._queue.put(_FLUSH)
        self.wait_until_idle(timeout)

    def wait_until_idle(self, timeout: float | None = None) -> None:
        """Block until every queued entry has been written (test/flush helper).

        This is *not* on the emission hot path; it exists so callers and tests
        can deterministically observe that the asynchronous appends have landed
        on disk before reading the Session_Diary back.
        """
        if timeout is None:
            self._queue.join()
            return
        # ``queue.join`` has no timeout; emulate one by polling the unfinished
        # task count so tests never hang indefinitely on a stuck worker.
        deadline = _monotonic() + timeout
        while self._queue.unfinished_tasks:
            if _monotonic() >= deadline:
                raise TimeoutError("diary worker did not drain within timeout")
            _sleep(0.005)

    # -- Internals ---------------------------------------------------------

    def _build_entry(self, seq: int, event: Mapping[str, object]) -> DiaryEntry:
        """Wrap a raw emitted event into a :class:`DiaryEntry`.

        Missing top-level fields degrade gracefully: ``runId``/``type`` fall
        back to empty/``"message"`` and ``ts`` defaults to the current UTC
        timestamp, so a sparse event is still recorded in FIFO order.
        """
        run_id = event.get("runId")
        event_type = event.get("type")
        ts = event.get("ts")
        return DiaryEntry(
            seq=seq,
            run_id=str(run_id) if run_id is not None else "",
            type=str(event_type) if event_type is not None else "message",
            ts=str(ts) if ts is not None else _utc_now_iso(),
            payload=event,
        )

    def _consume(self) -> None:
        """Single-consumer loop: buffer each entry, then drain to disk in order.

        Every accepted entry is appended to the in-memory ``_pending`` buffer
        and the loop then attempts to drain that buffer to disk in FIFO order.
        Because exactly one thread runs this loop and drains one ordered
        buffer, on-disk append order is identical to enqueue order (R9.4) even
        across a disk-failure fallback and recovery (R10.1, R10.4). A ``_FLUSH``
        request just re-attempts the drain (used after disk capability is
        restored); ``_STOP`` makes a final best-effort drain and exits.
        """
        while True:
            item = self._queue.get()
            try:
                if item is _STOP:
                    self._drain_pending()
                    break
                if item is _FLUSH:
                    self._drain_pending()
                    continue
                assert isinstance(item, DiaryEntry)
                with self._state_lock:
                    self._pending.append(item)
                self._drain_pending()
            finally:
                self._queue.task_done()

    def _drain_pending(self) -> None:
        """Write buffered entries to disk in FIFO order, degrading on failure.

        Walks ``_pending`` front-to-back, persisting each entry. A successful
        write removes the entry from the buffer; a raised ``OSError`` (the
        ``.zocai/`` write failing) leaves the failed entry — and everything
        after it — buffered, flips the worker into memory-only mode the first
        time it happens (R10.1), and returns without losing data. When the
        buffer fully drains after having been in memory-only mode, disk
        capability is considered restored and the worker resumes normal
        appends (R10.4).

        This method never raises: a disk fault is absorbed into the buffer so
        the agent runtime stays operational (R10.1).
        """
        recovered = False
        while True:
            with self._state_lock:
                if not self._pending:
                    # Buffer fully flushed. If we had degraded, this is the
                    # recovery point (R10.4); note it and clear the flag while
                    # still holding the lock so observers see a consistent state.
                    if self._memory_only:
                        self._memory_only = False
                        recovered = True
                    break
                entry = self._pending[0]
            try:
                self._write(entry)
            except OSError as exc:
                first_failure = False
                with self._state_lock:
                    if not self._memory_only:
                        self._memory_only = True
                        first_failure = True
                if first_failure and self._on_fallback is not None:
                    self._run_fallback_hook(exc)
                # Leave the failed entry (and its successors) buffered (R10.1).
                return
            else:
                with self._state_lock:
                    # The just-written entry is necessarily still at the front.
                    self._pending.popleft()
        if recovered and self._on_recovery is not None:
            self._run_recovery_hook()

    def _run_fallback_hook(self, exc: BaseException) -> None:
        """Run the fallback hook, swallowing hook errors (R10.1 stays operational)."""
        hook = self._on_fallback
        if hook is None:
            return
        try:
            hook(exc)
        except Exception:  # noqa: BLE001 - hooks must not break the worker
            pass

    def _run_recovery_hook(self) -> None:
        """Run the recovery hook, swallowing hook errors (R10.1 stays operational)."""
        hook = self._on_recovery
        if hook is None:
            return
        try:
            hook()
        except Exception:  # noqa: BLE001 - hooks must not break the worker
            pass

    def _write(self, entry: DiaryEntry) -> None:
        """Append a single entry's JSON line to the Session_Diary."""
        with self._diary_path.open("a", encoding="utf-8") as handle:
            handle.write(entry.to_json_line())

    def _drop_pending(self) -> None:
        """Discard queued-but-unwritten entries (used by non-draining stop)."""
        while True:
            try:
                self._queue.get_nowait()
            except queue.Empty:
                break
            else:
                self._queue.task_done()


def _utc_now_iso() -> str:
    """Current UTC time as an ISO-8601 string (default entry timestamp)."""
    return datetime.now(timezone.utc).isoformat()


# Bound at module load so the hot path avoids repeated attribute lookups and so
# tests can monkeypatch timing primitives if needed.
def _monotonic() -> float:
    import time

    return time.monotonic()


def _sleep(seconds: float) -> None:
    import time

    time.sleep(seconds)
