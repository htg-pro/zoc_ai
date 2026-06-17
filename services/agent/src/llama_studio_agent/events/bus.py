"""Per-session async event bus.

The agent orchestrator publishes structured `AgentEvent` records here; the
SSE endpoint subscribes per-session and forwards them to the frontend. All
events are also persisted via the `SessionRepository` so a late subscriber
can replay history from `since_seq`.
"""

from __future__ import annotations

import asyncio
from collections import defaultdict
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from itertools import count
from uuid import UUID

from shared_schema.models import AgentEventBase, DoneEvent


@dataclass(slots=True)
class EventSubscriber:
    session_id: UUID
    queue: asyncio.Queue[AgentEventBase | None]


class EventBus:
    """In-memory pub/sub keyed by session id with monotonic per-session seq.

    The per-session seq counter is restart-safe: the in-memory counter resets
    when the process restarts, so the first time a seq is requested for a
    session it is seeded from the persisted high-water mark (via
    ``seq_floor``). This keeps newly emitted events — e.g. approval
    reconciliation on startup — strictly above any seq a reconnecting client
    has already seen, so they aren't filtered out on SSE replay.
    """

    def __init__(self, *, seq_floor: Callable[[UUID], int] | None = None) -> None:
        self._subs: dict[UUID, list[EventSubscriber]] = defaultdict(list)
        self._seq: dict[UUID, count[int]] = {}
        self._seq_floor = seq_floor
        self._lock = asyncio.Lock()

    def next_seq(self, session_id: UUID) -> int:
        """Return the next monotonic per-session sequence number.

        This is the sole authority for event ordering. It is orthogonal to an
        event's ``run_id`` (the owning run is stamped by the producer, e.g. the
        orchestrator's ``_emit``); ``seq`` never resets per run.
        """
        counter = self._seq.get(session_id)
        if counter is None:
            start = 1
            if self._seq_floor is not None:
                start = self._seq_floor(session_id) + 1
            counter = count(start)
            self._seq[session_id] = counter
        return next(counter)

    async def publish(self, event: AgentEventBase) -> None:
        """Fan out an event to all subscribers of its session.

        The event is published as-is: producers stamp ``event.run_id`` (the
        owning run) before publishing so every subscriber can correlate the
        event to its run and discard events from a superseded run.
        """
        async with self._lock:
            subs = list(self._subs.get(event.session_id, ()))
        for sub in subs:
            await sub.queue.put(event)

    async def close(self, session_id: UUID) -> None:
        async with self._lock:
            subs = list(self._subs.get(session_id, ()))
        for sub in subs:
            await sub.queue.put(None)

    @asynccontextmanager
    async def subscribe(self, session_id: UUID) -> AsyncIterator[EventSubscriber]:
        sub = EventSubscriber(session_id=session_id, queue=asyncio.Queue(maxsize=256))
        async with self._lock:
            self._subs[session_id].append(sub)
        try:
            yield sub
        finally:
            async with self._lock:
                self._subs[session_id].remove(sub)
                if not self._subs[session_id]:
                    self._subs.pop(session_id, None)

    async def iter_events(
        self, session_id: UUID, timeout: float | None = None
    ) -> AsyncIterator[AgentEventBase]:
        """Yield events for a session until a `DoneEvent` (or close) arrives."""

        async with self.subscribe(session_id) as sub:
            while True:
                try:
                    if timeout is None:
                        event = await sub.queue.get()
                    else:
                        event = await asyncio.wait_for(sub.queue.get(), timeout)
                except TimeoutError:
                    return
                if event is None:
                    return
                yield event
                if isinstance(event, DoneEvent):
                    return
