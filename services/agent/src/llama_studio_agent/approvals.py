"""Interactive approval gate for tool calls that need the user's consent.

When a tool hits a missing permission, the orchestrator suspends the call
and waits here for the user's decision (deny / allow once / allow this tool
/ allow scope), which is delivered from the frontend via an HTTP endpoint
that calls :meth:`ApprovalGate.resolve`. This turns the per-tool approval
prompt into a real round-trip instead of relying on the model to re-attempt
the call on a later iteration.
"""

from __future__ import annotations

import asyncio
from uuid import UUID


class ApprovalGate:
    """Rendezvous between a suspended tool call and the user's decision.

    Keyed by ``(session_id, tool_call_id)``. A waiter (the orchestrator)
    awaits :meth:`wait`; the API layer calls :meth:`resolve` once the user
    picks an option. Decisions that arrive before a waiter has registered
    (a fast frontend) are buffered so they are not lost.
    """

    def __init__(self) -> None:
        self._futures: dict[tuple[UUID, UUID], asyncio.Future[bool]] = {}
        self._buffered: dict[tuple[UUID, UUID], bool] = {}

    async def wait(self, session_id: UUID, call_id: UUID, *, timeout: float) -> bool:
        """Suspend until the call is resolved. Returns the decision.

        Raises :class:`asyncio.TimeoutError` if no decision arrives in time.
        """

        key = (session_id, call_id)
        if key in self._buffered:
            return self._buffered.pop(key)
        loop = asyncio.get_running_loop()
        future: asyncio.Future[bool] = loop.create_future()
        self._futures[key] = future
        try:
            return await asyncio.wait_for(future, timeout)
        finally:
            self._futures.pop(key, None)
            # If the wait timed out, drop any decision that arrived while
            # we were already gone — leaving it in `_buffered` would let
            # the next `wait()` for the *same* call_id pick up a stale
            # answer that was never linked to a live request.
            self._buffered.pop(key, None)

    def resolve(self, session_id: UUID, call_id: UUID, allowed: bool) -> bool:
        """Deliver a decision. Returns True if a waiter was woken.

        If no waiter is registered yet, the decision is buffered for the
        next :meth:`wait` on the same key.
        """

        key = (session_id, call_id)
        future = self._futures.get(key)
        if future is not None and not future.done():
            future.set_result(allowed)
            return True
        self._buffered[key] = allowed
        return False

    def pending(self, session_id: UUID) -> list[UUID]:
        """Tool-call ids currently awaiting a decision for this session."""

        return [cid for (sid, cid) in self._futures if sid == session_id]
