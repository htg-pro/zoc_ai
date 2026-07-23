"""Small asynchronous event bus for process-local gateway coordination."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

FS_CHANGED_TOPIC = "fs://changed"


@dataclass(frozen=True, slots=True)
class WorkspaceFilesChanged:
    session_id: str
    paths: tuple[str, ...]


EventHandler = Callable[[object], Awaitable[None]]
Unsubscribe = Callable[[], None]


class GatewayEventBus:
    """Publish ordered process-local events to asynchronous subscribers."""

    def __init__(self) -> None:
        self._subscribers: dict[str, list[EventHandler]] = defaultdict(list)

    def subscribe(self, topic: str, handler: EventHandler) -> Unsubscribe:
        handlers = self._subscribers[topic]
        handlers.append(handler)

        def unsubscribe() -> None:
            current = self._subscribers.get(topic)
            if current is None:
                return
            try:
                current.remove(handler)
            except ValueError:
                return
            if not current:
                self._subscribers.pop(topic, None)

        return unsubscribe

    async def publish(self, topic: str, event: object) -> None:
        for handler in tuple(self._subscribers.get(topic, ())):
            await handler(event)


__all__ = [
    "FS_CHANGED_TOPIC",
    "GatewayEventBus",
    "WorkspaceFilesChanged",
]
