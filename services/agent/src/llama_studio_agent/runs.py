"""In-process registry of live agent runs, keyed by session.

A suspended tool-call approval lives only in the in-memory
:class:`~llama_studio_agent.approvals.ApprovalGate`. Startup reconciliation
(``reconcile_orphaned_approvals``) recovers approvals orphaned by a *full*
restart, but an approval can also be orphaned *without* a restart: if the
in-flight ``/agent/run`` request is cancelled (the client disconnects), the
awaiting coroutine is cancelled, the gate future is popped, and the call is
left persisted as ``needs_approval`` while the process keeps running.

The resolve endpoint can't tell that apart from the fast-frontend race (a
decision arriving before the run has registered its waiter) using the gate
alone — in both cases there's no live future. This registry closes that gap:
a run records itself as active for the duration of ``/agent/run`` (and the
retry re-run). When a resolve finds no live waiter, an *inactive* session
means the run is gone (orphaned, reconcile it), while an *active* session
means the waiter just hasn't registered yet (buffer the decision).
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from uuid import UUID


class RunRegistry:
    """Tracks how many agent runs are live per session.

    A simple per-session count tolerates overlapping runs (e.g. a retry
    issued while another run is winding down) without one's teardown
    clearing the other's liveness.
    """

    def __init__(self) -> None:
        self._active: dict[UUID, int] = {}

    def register(self, session_id: UUID) -> None:
        self._active[session_id] = self._active.get(session_id, 0) + 1

    def unregister(self, session_id: UUID) -> None:
        remaining = self._active.get(session_id, 0) - 1
        if remaining > 0:
            self._active[session_id] = remaining
        else:
            self._active.pop(session_id, None)

    def is_active(self, session_id: UUID) -> bool:
        """True if at least one run is currently live for this session."""

        return self._active.get(session_id, 0) > 0

    @contextmanager
    def track(self, session_id: UUID) -> Iterator[None]:
        """Mark a run live for the duration of the block.

        The ``finally`` runs even when the surrounding request coroutine is
        cancelled (client disconnect), so liveness is dropped exactly when
        the run truly ends — which is what lets the resolve path treat a
        still-suspended call with no active run as orphaned.
        """

        self.register(session_id)
        try:
            yield
        finally:
            self.unregister(session_id)
