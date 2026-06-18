"""Preservation-branch + replace-before-delete deletion guard (task 1.1).

This module centralizes the *deletion discipline* the later cutover tasks (9.x)
must obey, so the rules live in exactly one place rather than being re-derived
per deletion script:

1. **Preservation-branch precondition (Rebuild-R13.2/R13.3/R13.8).** No legacy
   directory may be removed unless the committed ``legacy-preservation`` branch
   already exists *and* carries at least one commit. If it does not, the guard
   aborts with a non-zero exit and deletes nothing.
2. **Replace-before-delete (Rebuild-R13.4).** A delete step refuses to run until
   its *named replacement module* is both present in the workspace and
   importable. Presence alone is not enough — the replacement must be a real,
   importable module so the merged app never loses a capability it has not
   already re-provided. This is a strictly stronger gate than the
   :class:`~zocai_migration.controller.MigrationController`'s ``exists()`` check
   and is what task 9.x deletions rely on (cross-ref Requirements 7.5, 8.5,
   11.3: every removal must leave a build whose imports still resolve).

The guard is *pure policy over injectable ports*, mirroring the controller: it
never talks to git or the filesystem directly. The real cutover supplies a
:class:`~zocai_migration.git_vcs.GitVersionControl` branch inspector and an
on-disk filesystem; tests supply in-memory fakes. The single CLI entrypoint in
:mod:`zocai_migration.cli` wires the real adapters together.
"""

from __future__ import annotations

import importlib.util
import shutil
from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Protocol, runtime_checkable

from zocai_migration.controller import DEFAULT_BRANCH_NAME, FileSystem

__all__ = [
    "BranchInspector",
    "DeletionGuard",
    "GuardError",
    "GuardOutcome",
    "GuardReason",
    "OnDiskFileSystem",
    "ReplacementSpec",
    "module_importable",
]


# ---------------------------------------------------------------------------
# Importability check
# ---------------------------------------------------------------------------


def module_importable(module_name: str) -> bool:
    """Return ``True`` when ``module_name`` can be located as an import.

    Uses :func:`importlib.util.find_spec`, which resolves the module on
    ``sys.path`` without executing it, so the check is side-effect free. Any
    failure to locate the module — a missing module, a broken parent package,
    or an invalid name — is reported as not importable rather than raised.
    """
    if not module_name:
        return False
    try:
        return importlib.util.find_spec(module_name) is not None
    except (ImportError, ModuleNotFoundError, ValueError):
        return False


# ---------------------------------------------------------------------------
# Injectable ports
# ---------------------------------------------------------------------------


@runtime_checkable
class BranchInspector(Protocol):
    """Port that inspects whether the committed preservation branch exists.

    :class:`zocai_migration.git_vcs.GitVersionControl` satisfies this protocol
    via its ``branch_exists`` / ``branch_has_commit`` helpers.
    """

    def branch_exists(self, name: str) -> bool:
        """Return ``True`` when a local branch ``name`` exists."""
        ...

    def branch_has_commit(self, name: str) -> bool:
        """Return ``True`` when ``name`` resolves to at least one commit."""
        ...


# ---------------------------------------------------------------------------
# Value types
# ---------------------------------------------------------------------------


class GuardReason(str, Enum):
    """Why the guard refused (or allowed) a deletion."""

    OK = "ok"
    PRESERVATION_BRANCH_MISSING = "preservation_branch_missing"
    REPLACEMENT_NOT_READY = "replacement_not_ready"
    INVALID_REQUEST = "invalid_request"


# Process exit codes the CLI maps each refusal onto. ``0`` is success; every
# refusal is a distinct non-zero code so callers (and CI) can branch on it.
_EXIT_CODES: dict[GuardReason, int] = {
    GuardReason.OK: 0,
    GuardReason.INVALID_REQUEST: 2,
    GuardReason.PRESERVATION_BRANCH_MISSING: 3,
    GuardReason.REPLACEMENT_NOT_READY: 4,
}


@dataclass(frozen=True)
class ReplacementSpec:
    """A single replace-before-delete request.

    ``legacy_path`` is the workspace directory to remove. It may be removed only
    once its replacement is ready, where "ready" means:

    * ``replacement_module`` (when given) is importable, AND
    * ``replacement_path`` (when given) exists in the workspace.

    At least one of ``replacement_module`` / ``replacement_path`` must be
    provided. Supplying both enforces that the replacement is present on disk
    *and* importable.
    """

    legacy_path: str
    replacement_module: str | None = None
    replacement_path: str | None = None
    label: str | None = None

    def __post_init__(self) -> None:
        if not self.legacy_path:
            raise ValueError("legacy_path must be a non-empty path")
        if not self.replacement_module and not self.replacement_path:
            raise ValueError(
                "a ReplacementSpec must name a replacement_module and/or a "
                "replacement_path so replace-before-delete can be enforced"
            )

    @property
    def display(self) -> str:
        """A human-readable label for messages."""
        return self.label or self.legacy_path


@dataclass(frozen=True)
class GuardOutcome:
    """The structured result of a guard check or guarded deletion."""

    reason: GuardReason
    message: str
    legacy_path: str | None = None
    branch_ready: bool = False
    replacement_ready: bool = False
    deleted: bool = False

    @property
    def ok(self) -> bool:
        """Whether the guard permitted the operation."""
        return self.reason is GuardReason.OK

    @property
    def exit_code(self) -> int:
        """The process exit code this outcome maps to."""
        return _EXIT_CODES[self.reason]


class GuardError(Exception):
    """Raised when the guard refuses an operation.

    Carries the structured :class:`GuardOutcome` so the CLI can report the
    reason and exit with the matching non-zero code.
    """

    def __init__(self, outcome: GuardOutcome) -> None:
        super().__init__(outcome.message)
        self.outcome = outcome

    @property
    def exit_code(self) -> int:
        return self.outcome.exit_code


# ---------------------------------------------------------------------------
# On-disk filesystem adapter (used by the CLI)
# ---------------------------------------------------------------------------


class OnDiskFileSystem:
    """Real filesystem port rooted at a workspace directory.

    Implements the :class:`~zocai_migration.controller.FileSystem` port so the
    guard's removals operate on actual directories during the cutover. Paths
    are resolved relative to ``root``.
    """

    def __init__(self, root: str | Path) -> None:
        self._root = Path(root)

    def exists(self, path: str) -> bool:
        return (self._root / path).exists()

    def remove_directory(self, path: str) -> None:
        target = self._root / path
        if target.is_dir():
            shutil.rmtree(target)
        elif target.exists():
            target.unlink()


# ---------------------------------------------------------------------------
# The guard
# ---------------------------------------------------------------------------


class DeletionGuard:
    """Centralized preservation-branch + replace-before-delete guard.

    Every deletion the 9.x tasks perform routes through :meth:`delete`, which
    refuses (raising :class:`GuardError`) unless:

    * the committed preservation branch exists (R13.2/R13.3/R13.8), and
    * the request's named replacement module is present and importable
      (R13.4 — replace-before-delete).
    """

    def __init__(
        self,
        *,
        branch_inspector: BranchInspector,
        filesystem: FileSystem,
        branch_name: str = DEFAULT_BRANCH_NAME,
        importable: Callable[[str], bool] = module_importable,
    ) -> None:
        self._branches = branch_inspector
        self._fs = filesystem
        self._branch_name = branch_name
        self._importable = importable

    # -- preservation-branch precondition ---------------------------------

    def preservation_branch_ready(self) -> bool:
        """Return ``True`` when the committed preservation branch exists.

        Requires both that the branch exists and that it carries a commit; a
        branch ref with no commit does not satisfy the precondition (R13.8).
        """
        try:
            return self._branches.branch_exists(
                self._branch_name
            ) and self._branches.branch_has_commit(self._branch_name)
        except Exception:
            # An inspector that cannot answer (e.g. git unavailable) is treated
            # as "no committed branch" so the guard fails closed.
            return False

    def check_preservation_branch(self) -> GuardOutcome:
        """Evaluate the preservation-branch precondition without deleting."""
        if self.preservation_branch_ready():
            return GuardOutcome(
                reason=GuardReason.OK,
                message=(
                    f"Committed preservation branch {self._branch_name!r} is "
                    "present; deletions are permitted."
                ),
                branch_ready=True,
            )
        return GuardOutcome(
            reason=GuardReason.PRESERVATION_BRANCH_MISSING,
            message=(
                f"Committed preservation branch {self._branch_name!r} was not "
                "found; refusing to delete any legacy source."
            ),
            branch_ready=False,
        )

    # -- replace-before-delete --------------------------------------------

    def replacement_ready(self, spec: ReplacementSpec) -> bool:
        """Return ``True`` when ``spec``'s replacement is present and importable."""
        ready = True
        if spec.replacement_path is not None:
            ready = ready and self._fs.exists(spec.replacement_path)
        if spec.replacement_module is not None:
            ready = ready and self._importable(spec.replacement_module)
        return ready

    # -- guarded deletion --------------------------------------------------

    def evaluate(self, spec: ReplacementSpec) -> GuardOutcome:
        """Evaluate both gates for ``spec`` without performing the deletion.

        Returns an OK outcome only when the preservation branch is committed and
        the replacement is present and importable.
        """
        branch_ready = self.preservation_branch_ready()
        if not branch_ready:
            return GuardOutcome(
                reason=GuardReason.PRESERVATION_BRANCH_MISSING,
                message=(
                    f"Refusing to delete {spec.display!r}: committed preservation "
                    f"branch {self._branch_name!r} was not found."
                ),
                legacy_path=spec.legacy_path,
                branch_ready=False,
            )

        if not self.replacement_ready(spec):
            missing: list[str] = []
            if spec.replacement_module is not None and not self._importable(
                spec.replacement_module
            ):
                missing.append(f"module {spec.replacement_module!r} is not importable")
            if spec.replacement_path is not None and not self._fs.exists(
                spec.replacement_path
            ):
                missing.append(f"path {spec.replacement_path!r} does not exist")
            return GuardOutcome(
                reason=GuardReason.REPLACEMENT_NOT_READY,
                message=(
                    f"Refusing to delete {spec.display!r}: replacement not ready ("
                    + "; ".join(missing)
                    + ")."
                ),
                legacy_path=spec.legacy_path,
                branch_ready=True,
                replacement_ready=False,
            )

        return GuardOutcome(
            reason=GuardReason.OK,
            message=(
                f"Replacement for {spec.display!r} is present and importable; "
                "deletion permitted."
            ),
            legacy_path=spec.legacy_path,
            branch_ready=True,
            replacement_ready=True,
        )

    def delete(self, spec: ReplacementSpec) -> GuardOutcome:
        """Delete ``spec.legacy_path`` only if both gates pass.

        Raises :class:`GuardError` (carrying a non-zero exit code) if the
        committed preservation branch is missing or the replacement is not ready.
        On success the legacy directory is removed and an OK outcome returned.
        """
        outcome = self.evaluate(spec)
        if not outcome.ok:
            raise GuardError(outcome)

        self._fs.remove_directory(spec.legacy_path)
        return GuardOutcome(
            reason=GuardReason.OK,
            message=(
                f"Deleted {spec.display!r} after confirming the committed "
                "preservation branch and an importable replacement."
            ),
            legacy_path=spec.legacy_path,
            branch_ready=True,
            replacement_ready=True,
            deleted=True,
        )
