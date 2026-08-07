"""The Workspace_Binder: resolve the active Workspace_Root for every request (R1).

The Gateway used to capture the workspace root once in ``create_app`` and fall
back to a ``tempfile.mkdtemp`` scratch directory when none was configured, so a
folder opened *after* the process started was invisible and root-less runs wrote
to ``/tmp``. This module replaces that with a per-request resolver that reads the
canonical persisted configuration the Desktop_Shell writes
(``~/.zoc-studio/desktop.json``), so the Gateway agrees with the shell by
construction and a rebind needs no process restart (R1.1, R1.2, R1.6).

Resolution precedence (D1):

1. an explicitly injected override (tests, ``create_app(workspace_root=...)``),
2. ``workspace_root`` from ``~/.zoc-studio/desktop.json``,
3. the ``ZOC_STUDIO_WORKSPACE`` environment variable (the sidecar handshake),
4. ``None``.

The resolved :class:`WorkspaceContext` is cached on the config file's
``(mtime_ns, size)`` so the common case is one ``stat`` per request and a
changed file invalidates immediately.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from zocai_gateway.errors import ErrorCode
from zocai_gateway.workspace_context import (
    WorkspaceContext,
    workspace_context_from_path,
)

if TYPE_CHECKING:  # pragma: no cover - typing only, avoids runtime import coupling
    from zocai_gateway.emit_gate import DiaryMirror
    from zocai_gateway.memory.hermes_evolution import HermesEvolution
    from zocai_gateway.memory.state_wrapper import StateWrapperStore

logger = logging.getLogger(__name__)

__all__ = [
    "NoWorkspaceError",
    "WorkspaceBinder",
    "WorkspaceOutsideError",
    "WorkspaceScope",
    "default_desktop_config_path",
]

#: The workspace root env var, kept as the third resolution source (the sidecar
#: handshake still exports it). Mirrors ``launch.WORKSPACE_ENV_VAR``.
WORKSPACE_ENV_VAR = "ZOC_STUDIO_WORKSPACE"


class NoWorkspaceError(Exception):
    """No workspace is configured; the caller must refuse (R1.4).

    Carries the ``no_workspace`` error code so a route can map it to a typed
    409 without inspecting the exception text.
    """

    code: str = ErrorCode.NO_WORKSPACE

    def __init__(self, message: str | None = None) -> None:
        super().__init__(message or "No workspace is open. Open a project folder first.")


class WorkspaceOutsideError(Exception):
    """A requested path resolved outside the workspace root (R1.5)."""

    code: str = ErrorCode.PATH_OUTSIDE_WORKSPACE

    def __init__(self, rejected: str, root: str) -> None:
        self.rejected = rejected
        self.root = root
        super().__init__(f"path resolved outside the workspace: {rejected!r}")


@dataclass(slots=True)
class WorkspaceScope:
    """Everything scoped to one workspace root, created on first use (D3).

    A rebind retires the previous scope (stop the diary worker, stop hermes,
    close the MCP host) so a workspace switch does not require a sidecar restart
    and does not leak a worker per resolution.
    """

    workspace: WorkspaceContext
    diary: DiaryMirror | None
    diary_path: Path | None
    state_store: StateWrapperStore | None
    hermes: HermesEvolution | None
    mcp_host: object

    async def aclose(self) -> None:
        """Retire this scope's workspace-scoped resources (D3)."""
        stop_diary = getattr(self.diary, "stop", None)
        if callable(stop_diary):
            try:
                stop_diary()
            except Exception:  # pragma: no cover - defensive teardown
                logger.warning("failed to stop diary worker on scope retirement", exc_info=True)
        stop_hermes = getattr(self.hermes, "stop", None)
        if callable(stop_hermes):
            try:
                stop_hermes()
            except Exception:  # pragma: no cover - defensive teardown
                logger.warning("failed to stop hermes on scope retirement", exc_info=True)
        aclose = getattr(self.mcp_host, "aclose", None)
        if aclose is not None:
            try:
                await aclose()
            except Exception:  # pragma: no cover - defensive teardown
                logger.warning("failed to close MCP host on scope retirement", exc_info=True)


def default_desktop_config_path() -> Path:
    """The canonical ``~/.zoc-studio/desktop.json`` the Desktop_Shell writes."""
    return Path.home() / ".zoc-studio" / "desktop.json"


ScopeFactory = Callable[[WorkspaceContext], "Awaitable[WorkspaceScope]"]


class WorkspaceBinder:
    """Resolves the active Workspace_Root for every request (R1.1, R1.2, R1.6)."""

    def __init__(
        self,
        *,
        override: Path | str | None = None,
        config_path: Path | None = None,
        env: Mapping[str, str] | None = None,
        scope_factory: ScopeFactory | None = None,
    ) -> None:
        self._override_raw = override
        self._config_path = (
            config_path if config_path is not None else default_desktop_config_path()
        )
        self._env = env if env is not None else os.environ
        self._scope_factory = scope_factory
        # (mtime_ns, size) of the config the cached context was built from, or a
        # sentinel for the non-config branches so a stale cache is invalidated.
        self._cache_stat: tuple[int, int] | None = None
        self._cache_source: str | None = None
        self._cached: WorkspaceContext | None = None
        self._scope: WorkspaceScope | None = None
        self._scope_lock = asyncio.Lock()

    # -- resolution ---------------------------------------------------------

    def resolve(self) -> WorkspaceContext | None:
        """The active workspace, or ``None`` when none is configured (R1.1, R1.2)."""
        # 1) Injected override wins and never changes for a given binder.
        if self._override_raw is not None:
            if self._cache_source != "override":
                self._cached = self._build(self._override_raw)
                self._cache_source = "override"
                self._cache_stat = None
            return self._cached

        # 2) Persisted desktop config, cached on its (mtime_ns, size).
        stat = self._config_stat()
        if stat is not None:
            if self._cache_source == "config" and self._cache_stat == stat:
                return self._cached
            root = self._read_config_root()
            self._cached = self._build(root) if root else None
            self._cache_source = "config"
            self._cache_stat = stat
            if self._cached is not None or root is not None:
                return self._cached
            # Config present but no workspace_root: fall through to env.

        # 3) The sidecar-handshake environment variable.
        env_root = (self._env.get(WORKSPACE_ENV_VAR) or "").strip()
        if env_root:
            if self._cache_source != "env" or self._cache_stat is not None:
                self._cached = self._build(env_root)
                self._cache_source = "env"
                self._cache_stat = None
            return self._cached

        # 4) Nothing configured.
        self._cached = None
        self._cache_source = "none"
        self._cache_stat = None
        return None

    def require(self) -> WorkspaceContext:
        """The active workspace, raising :class:`NoWorkspaceError` when none (R1.4)."""
        workspace = self.resolve()
        if workspace is None:
            raise NoWorkspaceError()
        return workspace

    def resolve_path(self, candidate: str | Path) -> Path:
        """Canonicalize ``candidate`` inside the workspace (R1.5).

        Raises :class:`NoWorkspaceError` when no workspace is configured and
        :class:`WorkspaceOutsideError` naming the rejected path when it escapes
        the root — through ``..`` segments, a sibling-prefix name, or a symlink.
        """
        workspace = self.require()
        root = workspace.root
        raw = str(candidate)
        target = Path(raw)
        if not target.is_absolute():
            target = root / target
        try:
            resolved = target.resolve()
        except OSError as exc:
            raise WorkspaceOutsideError(raw, str(root)) from exc
        # ``root`` is already canonical (WorkspaceContext resolves it), so a
        # prefix comparison on the fully resolved candidate is exact: a sibling
        # like ``/a/project-evil`` is not under ``/a/project`` and is rejected.
        if resolved != root and root not in resolved.parents:
            raise WorkspaceOutsideError(raw, str(root))
        return resolved

    # -- workspace-scoped resources (D3) ------------------------------------

    def set_scope_factory(self, factory: ScopeFactory) -> None:
        """Install the factory that builds a :class:`WorkspaceScope` for a root."""
        self._scope_factory = factory

    def seed_scope(self, scope: WorkspaceScope) -> None:
        """Seed the scope the app built eagerly for the startup workspace (D3).

        Lets ``scope()`` return the already-constructed resources for the startup
        root without rebuilding them, while a later rebind still retires this
        scope and builds a fresh one.
        """
        self._scope = scope

    async def scope(self) -> WorkspaceScope:
        """The :class:`WorkspaceScope` for the active root, retiring a stale one (D3).

        Serialized behind a lock so two concurrent requests cannot both build a
        scope. Raises :class:`NoWorkspaceError` when no workspace is resolved —
        scoped resources have nowhere to live without a root.
        """
        if self._scope_factory is None:
            raise RuntimeError("WorkspaceBinder was constructed without a scope factory")
        workspace = self.require()
        async with self._scope_lock:
            current = self._scope
            if current is not None and current.workspace.workspace_id == workspace.workspace_id:
                return current
            if current is not None:
                await current.aclose()
            self._scope = await self._scope_factory(workspace)
            return self._scope

    async def retire_scope(self) -> None:
        """Retire the active scope, if any (used on shutdown)."""
        async with self._scope_lock:
            if self._scope is not None:
                await self._scope.aclose()
                self._scope = None

    # -- internals ----------------------------------------------------------

    def _build(self, root: str | Path) -> WorkspaceContext | None:
        try:
            return workspace_context_from_path(root)
        except ValueError as exc:
            logger.warning("ignoring invalid workspace root %r: %s", str(root), exc)
            return None

    def _config_stat(self) -> tuple[int, int] | None:
        try:
            st = self._config_path.stat()
        except OSError:
            return None
        return (st.st_mtime_ns, st.st_size)

    def _read_config_root(self) -> str | None:
        try:
            raw = self._config_path.read_text(encoding="utf-8")
        except OSError:
            return None
        try:
            data = json.loads(raw)
        except (ValueError, TypeError):
            logger.warning("desktop config is not valid JSON: %s", self._config_path)
            return None
        if not isinstance(data, Mapping):
            return None
        value = data.get("workspace_root")
        if isinstance(value, str) and value.strip():
            return value.strip()
        return None
