"""The authoritative run lifecycle state machine (Phase 3).

One run has exactly one lifecycle, owned by the gateway::

    idle → initializing → running → stopping → cancelled
                       ↘         ↘         ↘
                        failed    completed  failed

This is deliberately *not* the agent :class:`~zocai_gateway.stages.Stage` FSM.
``Stage`` tracks how far the agent got through its own pipeline (INTAKE,
PLAN_EDITS, APPLY_EDITS…). :class:`RunState` tracks whether the *run* is alive,
which is the question the Stop button and the run list actually ask. Conflating
the two is what allowed a run to sit in the UI as "Running…" after its pipeline
had already reached ``ERROR_CLOSED``.

Guarantees this type provides:

* **A terminal state is final.** Once ``completed``/``cancelled``/``failed`` is
  reached no further transition happens, so a late callback from an abandoned
  worker cannot resurrect a finished run.
* **Stop is idempotent.** :meth:`RunLifecycle.request_stop` returns whether it
  actually initiated a stop. Calling it on an already-stopping or already
  terminal run is a no-op that reports success, so a double-click on Stop, or a
  stop that races completion, cannot raise.
* **Transitions are checked.** Anything not in :data:`LEGAL` raises
  :class:`IllegalRunTransition`, so an unexpected ordering is a loud bug in
  tests rather than a silently wedged UI in production.
"""

from __future__ import annotations

import threading
from enum import Enum
from typing import Final

__all__ = [
    "LEGAL",
    "TERMINAL_STATES",
    "IllegalRunTransition",
    "RunLifecycle",
    "RunState",
]


class RunState(str, Enum):
    """Lifecycle states of a single run."""

    IDLE = "idle"
    INITIALIZING = "initializing"
    RUNNING = "running"
    STOPPING = "stopping"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    FAILED = "failed"


#: States from which no transition is legal.
TERMINAL_STATES: Final[frozenset[RunState]] = frozenset(
    {RunState.COMPLETED, RunState.CANCELLED, RunState.FAILED}
)

#: Legal successor states. A process can fail at any point before terminating,
#: and a stop can be requested at any point before terminating, so ``FAILED``
#: and ``STOPPING`` are reachable from every live state.
LEGAL: Final[dict[RunState, frozenset[RunState]]] = {
    RunState.IDLE: frozenset({RunState.INITIALIZING, RunState.STOPPING, RunState.FAILED}),
    RunState.INITIALIZING: frozenset(
        {
            RunState.RUNNING,
            RunState.STOPPING,
            RunState.COMPLETED,
            RunState.CANCELLED,
            RunState.FAILED,
        }
    ),
    RunState.RUNNING: frozenset(
        {RunState.STOPPING, RunState.COMPLETED, RunState.CANCELLED, RunState.FAILED}
    ),
    # A stopping run normally lands in `cancelled`. `completed`/`failed` remain
    # legal because the pipeline may have finished (or died) in the window
    # between the stop request and the cooperative cancellation taking effect —
    # the outcome that actually happened wins over the one we asked for.
    RunState.STOPPING: frozenset({RunState.CANCELLED, RunState.COMPLETED, RunState.FAILED}),
    RunState.COMPLETED: frozenset(),
    RunState.CANCELLED: frozenset(),
    RunState.FAILED: frozenset(),
}


class IllegalRunTransition(RuntimeError):
    """Raised when a run is moved to a state it cannot legally enter."""

    def __init__(self, source: RunState, target: RunState) -> None:
        super().__init__(f"illegal run transition: {source.value} -> {target.value}")
        self.source = source
        self.target = target


class RunLifecycle:
    """Thread-safe holder of one run's :class:`RunState`.

    The pipeline runs in a worker thread while the HTTP handlers run on the
    event loop, so every read and write is taken under one lock and the
    "check current state, then transition" sequences that need to be atomic
    (:meth:`request_stop`, :meth:`finish`) are performed inside it.
    """

    __slots__ = ("_lock", "_reason", "_state")

    def __init__(self, initial: RunState = RunState.IDLE) -> None:
        self._state = initial
        self._reason: str | None = None
        self._lock = threading.Lock()

    @property
    def state(self) -> RunState:
        with self._lock:
            return self._state

    @property
    def reason(self) -> str | None:
        """Why the run left the happy path, when it did."""
        with self._lock:
            return self._reason

    @property
    def is_terminal(self) -> bool:
        with self._lock:
            return self._state in TERMINAL_STATES

    @property
    def is_stopping(self) -> bool:
        with self._lock:
            return self._state is RunState.STOPPING

    def to(self, target: RunState, *, reason: str | None = None) -> RunState:
        """Move to ``target``, raising :class:`IllegalRunTransition` if illegal."""
        with self._lock:
            if target is self._state:
                return self._state
            if target not in LEGAL[self._state]:
                raise IllegalRunTransition(self._state, target)
            self._state = target
            if reason is not None:
                self._reason = reason
            return self._state

    def request_stop(self) -> bool:
        """Begin stopping this run. Idempotent.

        Returns ``True`` when this call moved a live run into ``STOPPING`` (so
        the caller should perform the actual teardown), and ``False`` when there
        was nothing to stop — already stopping, or already terminal. Never
        raises: a redundant stop is a normal user action, not an error.
        """
        with self._lock:
            if self._state in TERMINAL_STATES or self._state is RunState.STOPPING:
                return False
            self._state = RunState.STOPPING
            return True

    def finish(self, target: RunState, *, reason: str | None = None) -> RunState:
        """Settle the run in a terminal state, keeping the first outcome.

        Unlike :meth:`to` this never raises: terminal settlement is reached from
        several independent callbacks (pipeline return, timeout, process exit,
        cancellation) and whichever arrives first is the truth. Later callers
        observe the already-settled state.
        """
        if target not in TERMINAL_STATES:
            raise ValueError(f"not a terminal state: {target.value}")
        with self._lock:
            if self._state in TERMINAL_STATES:
                return self._state
            self._state = target
            if reason is not None:
                self._reason = reason
            return self._state
