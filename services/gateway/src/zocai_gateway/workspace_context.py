"""The single source of truth for "which folder is open" (Phase 4).

The gateway previously used ``"."`` and :meth:`Path.cwd` as stand-ins for the
user's workspace when no root had been supplied. In a packaged desktop build the
sidecar's working directory is wherever the installer put the executable, so
those fallbacks silently pointed tools — and spawned terminals — at the
application's own ``bin`` directory instead of the user's project. A shell
opening in ``/usr/lib/zoc-studio`` and an agent creating files there are the same
bug seen from two angles.

This module replaces both fallbacks with an explicit, canonical value or
``None``:

* :class:`WorkspaceContext` is built only from a path that exists and is a
  directory, and stores it fully resolved (symlinks followed).
* :func:`resolve_terminal_cwd` decides a terminal's working directory. It never
  returns the process's own directory: the answer is always the requested
  directory (when it is inside the workspace) or the workspace root itself.

Keeping the decision in one pure function is what makes the cases the product
actually hits — workspace opened, workspace switched, terminal reopened, no
workspace, workspace deleted — testable without spawning a shell.
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass
from pathlib import Path

from zocai_gateway.errors import ErrorCode

__all__ = [
    "CwdDecision",
    "WorkspaceContext",
    "resolve_terminal_cwd",
    "workspace_context_from_path",
]


@dataclass(frozen=True, slots=True)
class WorkspaceContext:
    """The active workspace, resolved once and shared by every consumer.

    ``root_path`` is always absolute and canonical, so path-confinement checks
    elsewhere can use a plain prefix comparison without re-resolving.
    """

    workspace_id: str
    root_path: str
    display_name: str
    opened_at: float

    @property
    def root(self) -> Path:
        return Path(self.root_path)

    def contains(self, candidate: Path) -> bool:
        """Whether ``candidate`` resolves to this root or somewhere inside it."""
        try:
            resolved = candidate.resolve()
        except OSError:
            return False
        root = self.root
        return resolved == root or root in resolved.parents


def _workspace_id(root: Path) -> str:
    """Stable id for a root path.

    A hash of the canonical path rather than the path itself, so the id can be
    logged and sent to the renderer without disclosing the user's directory
    layout.
    """
    return hashlib.sha256(str(root).encode("utf-8")).hexdigest()[:16]


def workspace_context_from_path(
    root: str | Path | None,
    *,
    opened_at: float | None = None,
) -> WorkspaceContext | None:
    """Build a :class:`WorkspaceContext`, or ``None`` when there is no workspace.

    Returns ``None`` for ``None``/blank input. Raises :class:`ValueError` when a
    path *was* supplied but does not name an existing directory, because
    silently degrading a bad root to "no workspace" is how a run ends up writing
    somewhere unexpected.
    """
    if root is None:
        return None
    raw = str(root).strip()
    if not raw:
        return None
    candidate = Path(raw).expanduser()
    try:
        resolved = candidate.resolve()
    except OSError as exc:  # pragma: no cover - platform dependent
        raise ValueError(f"{ErrorCode.WORKSPACE_INVALID}: {exc}") from exc
    if not resolved.is_dir():
        raise ValueError(f"{ErrorCode.WORKSPACE_INVALID}: not a directory")
    return WorkspaceContext(
        workspace_id=_workspace_id(resolved),
        root_path=str(resolved),
        display_name=resolved.name or str(resolved),
        opened_at=opened_at if opened_at is not None else time.time(),
    )


@dataclass(frozen=True, slots=True)
class CwdDecision:
    """Outcome of choosing a terminal working directory.

    ``cwd`` is ``None`` only when there is nothing safe to use, in which case
    ``code``/``message`` explain why and the caller must refuse to spawn rather
    than fall back to the process directory.
    """

    cwd: str | None
    #: True when the requested directory was replaced by the workspace root.
    fell_back: bool = False
    code: str | None = None
    message: str | None = None

    @property
    def ok(self) -> bool:
        return self.cwd is not None


def resolve_terminal_cwd(
    requested: str | None,
    workspace: WorkspaceContext | None,
) -> CwdDecision:
    """Choose the working directory a terminal should start in.

    Precedence:

    1. No workspace at all → refuse. There is no verified directory to use, and
       the process directory is exactly the wrong answer.
    2. Workspace root itself gone (deleted/unmounted since it was opened) →
       refuse.
    3. No requested directory → the workspace root.
    4. Requested directory outside the workspace, missing, or not a directory →
       the workspace root, flagged as a fallback so the caller can tell the user.
    5. Otherwise → the requested directory, canonicalised.
    """
    if workspace is None:
        return CwdDecision(
            cwd=None,
            code=ErrorCode.NO_WORKSPACE,
            message=("No workspace is open. Open a project folder to start a terminal."),
        )

    root = workspace.root
    if not root.is_dir():
        return CwdDecision(
            cwd=None,
            code=ErrorCode.WORKSPACE_INVALID,
            message=(
                "The workspace folder is no longer available. Reopen the folder "
                "to start a terminal."
            ),
        )

    raw = (requested or "").strip()
    if not raw:
        return CwdDecision(cwd=str(root))

    candidate = Path(raw).expanduser()
    target = candidate if candidate.is_absolute() else root / candidate
    try:
        resolved = target.resolve()
    except OSError:
        resolved = None

    if resolved is None or not resolved.is_dir():
        return CwdDecision(
            cwd=str(root),
            fell_back=True,
            code=ErrorCode.TERMINAL_CWD_INVALID,
            message=(
                "The requested folder does not exist; starting in the workspace root instead."
            ),
        )
    if not workspace.contains(resolved):
        return CwdDecision(
            cwd=str(root),
            fell_back=True,
            code=ErrorCode.PATH_OUTSIDE_WORKSPACE,
            message=(
                "The requested folder is outside the open workspace; starting in "
                "the workspace root instead."
            ),
        )
    return CwdDecision(cwd=str(resolved))
