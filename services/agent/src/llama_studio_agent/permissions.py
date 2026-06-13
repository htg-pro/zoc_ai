"""Per-session permission grants for destructive tool calls."""

from __future__ import annotations

from threading import RLock
from uuid import UUID

from shared_schema.models import PermissionGrant, PermissionScope, ToolGrant

from .persistence import SessionRepository


class PermissionDenied(RuntimeError):
    """Raised when a tool needs a scope the session has not granted."""


class PermissionManager:
    """Read-through cache over `SessionRepository` permission storage.

    Tracks two layers of approval: coarse-grained *scope* grants
    (e.g. `run_command`) and fine-grained per-*tool* grants. A per-tool
    grant lets the user approve a single tool without unlocking every
    other tool that shares its scope, and supports "allow once" grants
    that are consumed the first time the tool runs.

    The cache is guarded by a single RLock — under load (concurrent SSE
    runs against the same session) two callers used to be able to read,
    mutate, and write back simultaneously and lose a grant or consume a
    one-shot twice. Coarse but correct.
    """

    def __init__(self, repo: SessionRepository) -> None:
        self.repo = repo
        self._lock = RLock()
        self._cache: dict[tuple[UUID, PermissionScope], bool] = {}
        self._tool_cache: dict[tuple[UUID, str], ToolGrant] = {}
        self._tool_loaded: set[UUID] = set()

    def grant(self, session_id: UUID, scope: PermissionScope, *, note: str | None = None) -> None:
        with self._lock:
            self.repo.set_permission(
                session_id, PermissionGrant(scope=scope, granted=True, note=note)
            )
            self._cache[(session_id, scope)] = True

    def revoke(self, session_id: UUID, scope: PermissionScope) -> None:
        with self._lock:
            self.repo.set_permission(
                session_id, PermissionGrant(scope=scope, granted=False)
            )
            self._cache[(session_id, scope)] = False

    def has(self, session_id: UUID, scope: PermissionScope) -> bool:
        key = (session_id, scope)
        with self._lock:
            if key in self._cache:
                return self._cache[key]
            for g in self.repo.get_permissions(session_id):
                self._cache[(session_id, g.scope)] = g.granted
            return self._cache.get(key, False)

    def require(self, session_id: UUID, scope: PermissionScope) -> None:
        if not self.has(session_id, scope):
            raise PermissionDenied(f"missing permission: {scope.value}")

    # ── per-tool grants ─────────────────────────────────────────────────

    def _load_tool_grants(self, session_id: UUID) -> None:
        if session_id in self._tool_loaded:
            return
        for g in self.repo.get_tool_grants(session_id):
            self._tool_cache[(session_id, g.tool)] = g
        self._tool_loaded.add(session_id)

    def grant_tool(
        self, session_id: UUID, tool: str, *, once: bool = False, note: str | None = None
    ) -> None:
        with self._lock:
            grant = ToolGrant(tool=tool, granted=True, once=once, note=note)
            self.repo.set_tool_grant(session_id, grant)
            self._tool_cache[(session_id, tool)] = grant
            self._tool_loaded.add(session_id)

    def revoke_tool(self, session_id: UUID, tool: str) -> None:
        with self._lock:
            self.repo.delete_tool_grant(session_id, tool)
            self._tool_cache.pop((session_id, tool), None)
            self._tool_loaded.add(session_id)

    def tool_grant(self, session_id: UUID, tool: str) -> ToolGrant | None:
        with self._lock:
            self._load_tool_grants(session_id)
            return self._tool_cache.get((session_id, tool))

    def allow_tool(self, session_id: UUID, tool: str, *, consume: bool = True) -> bool:
        """Return True when a per-tool grant authorises this tool.

        An "allow once" grant is consumed (deleted) on first use so the
        next call falls back to the scope check. Pass ``consume=False`` to
        peek without consuming the one-shot grant — used by the orchestrator
        to probe whether a call needs approval before actually running it.

        The whole probe + consume is atomic under the manager's lock so
        two concurrent tool calls can't both consume a single one-shot.
        """

        with self._lock:
            self._load_tool_grants(session_id)
            grant = self._tool_cache.get((session_id, tool))
            if grant is None or not grant.granted:
                return False
            if grant.once and consume:
                self.repo.delete_tool_grant(session_id, tool)
                self._tool_cache.pop((session_id, tool), None)
            return True
