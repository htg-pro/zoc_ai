"""Per-file write locks for concurrent agent runs (§12.3).

With several runs executing at once, two runs must never write the same file at
the same time — the second write would silently clobber the first, and neither
run's diff would describe the file's final state. A whole-workspace lock would
prevent that but also serialise unrelated work, defeating the point of running
in parallel.

So the lock is **per file**: a run acquires the paths it plans to write, holds
them for its apply phase, and releases them at the end. Two runs touching
disjoint files never contend; two runs touching the same file are ordered.

Design notes:

* Locks are keyed by *workspace-relative, separator-normalised* path, so
  ``src/app.py`` and ``src\\app.py`` are the same lock.
* Acquisition is **all-or-nothing** and ordered: paths are sorted before
  acquiring, which makes deadlock between two runs impossible (a cycle needs
  two runs acquiring the same two locks in opposite orders).
* A blocked run waits up to :data:`DEFAULT_LOCK_TIMEOUT_SECONDS` and then
  reports which paths it could not get, so the caller can raise a
  ``decision_required`` instead of hanging.
* ``threading`` rather than ``asyncio``: the run pipeline executes in worker
  threads (``asyncio.to_thread``), so the lock must be thread-based.
"""

from __future__ import annotations

import threading
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from time import monotonic

__all__ = [
    "DEFAULT_LOCK_TIMEOUT_SECONDS",
    "FileLockRegistry",
    "LockAcquisition",
    "normalize_lock_path",
]

#: How long a run waits for a contended file before giving up (§12.3).
DEFAULT_LOCK_TIMEOUT_SECONDS = 10.0


def normalize_lock_path(path: str) -> str:
    """Canonical lock key for ``path``.

    Normalises separators and strips a leading ``./`` so the same file always
    maps to the same lock regardless of how a plan spelled it.
    """
    cleaned = path.strip().replace("\\", "/")
    while cleaned.startswith("./"):
        cleaned = cleaned[2:]
    return cleaned.strip("/")


@dataclass(frozen=True, slots=True)
class LockAcquisition:
    """The result of an acquisition attempt.

    ``acquired`` is true only when *every* requested path was locked;
    ``blocked_paths`` names the ones that were not, along with the run that
    holds them, so the caller can explain the wait to the user.
    """

    acquired: bool
    paths: tuple[str, ...] = ()
    blocked_paths: tuple[str, ...] = ()
    blocked_by: tuple[str, ...] = ()


@dataclass
class _Holder:
    run_id: str
    depth: int = 1


@dataclass
class FileLockRegistry:
    """Process-wide registry of per-file write locks (§12.3)."""

    _condition: threading.Condition = field(
        default_factory=lambda: threading.Condition(threading.Lock())
    )
    _holders: dict[str, _Holder] = field(default_factory=dict)

    def holder(self, path: str) -> str | None:
        """Run id currently holding ``path``, or ``None``."""
        with self._condition:
            entry = self._holders.get(normalize_lock_path(path))
            return entry.run_id if entry is not None else None

    def held_paths(self) -> tuple[str, ...]:
        with self._condition:
            return tuple(sorted(self._holders))

    def acquire(
        self,
        run_id: str,
        paths: Iterable[str],
        *,
        timeout: float = DEFAULT_LOCK_TIMEOUT_SECONDS,
    ) -> LockAcquisition:
        """Lock every path in ``paths`` for ``run_id``, or nothing at all.

        Re-entrant per run: a run that already holds a path can acquire it again
        (the apply loop may revisit a file during remediation).

        Returns a :class:`LockAcquisition` with ``acquired=False`` — never
        raising, and never holding a partial set — when the timeout elapses.
        """
        wanted = sorted({normalize_lock_path(p) for p in paths if normalize_lock_path(p)})
        if not wanted:
            return LockAcquisition(acquired=True)

        deadline = monotonic() + max(timeout, 0.0)
        with self._condition:
            while True:
                blocked = [
                    path
                    for path in wanted
                    if (entry := self._holders.get(path)) is not None
                    and entry.run_id != run_id
                ]
                if not blocked:
                    for path in wanted:
                        entry = self._holders.get(path)
                        if entry is None:
                            self._holders[path] = _Holder(run_id=run_id)
                        else:
                            entry.depth += 1
                    return LockAcquisition(acquired=True, paths=tuple(wanted))

                remaining = deadline - monotonic()
                if remaining <= 0:
                    return LockAcquisition(
                        acquired=False,
                        blocked_paths=tuple(blocked),
                        blocked_by=tuple(
                            dict.fromkeys(
                                self._holders[path].run_id
                                for path in blocked
                                if path in self._holders
                            )
                        ),
                    )
                self._condition.wait(timeout=min(remaining, 0.25))

    def release(self, run_id: str, paths: Iterable[str]) -> None:
        """Release ``paths`` held by ``run_id``. Unknown paths are ignored."""
        with self._condition:
            for raw in paths:
                path = normalize_lock_path(raw)
                entry = self._holders.get(path)
                if entry is None or entry.run_id != run_id:
                    continue
                entry.depth -= 1
                if entry.depth <= 0:
                    del self._holders[path]
            self._condition.notify_all()

    def release_run(self, run_id: str) -> None:
        """Release every lock held by ``run_id``.

        The safety net for a run that crashed mid-apply: without it a panicking
        run would keep files locked for the life of the process.
        """
        with self._condition:
            for path in [p for p, e in self._holders.items() if e.run_id == run_id]:
                del self._holders[path]
            self._condition.notify_all()

    @contextmanager
    def hold(
        self,
        run_id: str,
        paths: Iterable[str],
        *,
        timeout: float = DEFAULT_LOCK_TIMEOUT_SECONDS,
    ) -> Iterator[LockAcquisition]:
        """Acquire ``paths`` for the duration of the block.

        Always releases, including on exception, so a failing apply cannot leak
        locks. The caller must check ``acquisition.acquired``; the block runs
        either way so it can emit a ``decision_required`` and bail out.
        """
        acquisition = self.acquire(run_id, paths, timeout=timeout)
        try:
            yield acquisition
        finally:
            if acquisition.acquired:
                self.release(run_id, acquisition.paths)
