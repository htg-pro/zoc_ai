"""The ``MigrationController`` and its injectable abstractions (Requirement 13).

The controller is *pure policy*. It never runs git, a compiler, or a filesystem
delete on its own; instead it drives three injectable ports:

* :class:`VersionControl` -- create and commit the legacy preservation branch.
* :class:`BuildRunner`    -- run a named language build, returning its exit code.
* :class:`FileSystem`     -- test for a replacement's existence and remove a
  legacy directory.

This separation keeps the migration logic deterministic and testable. The real
legacy cutover (task 15) supplies concrete git/cargo/pnpm/uv-backed
implementations; tests supply in-memory fakes.

Discipline enforced: **preservation-branch-first -> replace-before-delete ->
per-language build-gate**, with the legacy branch retained for rollback on any
post-commit failure.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from enum import Enum
from typing import Protocol, runtime_checkable

# ---------------------------------------------------------------------------
# Injectable ports
# ---------------------------------------------------------------------------


@runtime_checkable
class VersionControl(Protocol):
    """Version-control port used to create and commit the preservation branch."""

    def create_branch(self, name: str) -> bool:
        """Create a branch capturing the complete legacy implementation.

        Returns ``True`` when the branch was created, ``False`` otherwise.
        """
        ...

    def commit_branch(self, name: str, message: str) -> bool:
        """Commit the preservation branch.

        Returns ``True`` when the commit succeeded, ``False`` otherwise.
        """
        ...


@runtime_checkable
class BuildRunner(Protocol):
    """Build port that runs a named language build and returns its exit code."""

    def run_build(self, build_id: str) -> int:
        """Run the build identified by ``build_id`` and return its exit code.

        An exit code of ``0`` means success; any non-zero value is a failure.
        """
        ...


@runtime_checkable
class FileSystem(Protocol):
    """Filesystem port for replacement existence checks and legacy removal."""

    def exists(self, path: str) -> bool:
        """Return ``True`` when ``path`` exists in the workspace."""
        ...

    def remove_directory(self, path: str) -> None:
        """Remove the legacy directory at ``path``."""
        ...


# ---------------------------------------------------------------------------
# Value types
# ---------------------------------------------------------------------------


class HaltReason(str, Enum):
    """The reason a migration halted before completing."""

    BRANCH_CREATE_FAILED = "branch_create_failed"
    BRANCH_COMMIT_FAILED = "branch_commit_failed"
    REPLACEMENT_MISSING = "replacement_missing"
    BUILD_FAILED = "build_failed"
    SHARED_CONFIG_LOST = "shared_config_lost"


@dataclass(frozen=True)
class MigrationStage:
    """A single replace-before-delete stage.

    ``legacy_dir`` is removed only once ``replacement`` exists and the build
    identified by ``build_id`` returns exit code 0. ``build_label`` is the
    human-readable name reported in a failure indication.
    """

    legacy_dir: str
    replacement: str
    build_id: str
    build_label: str


@dataclass(frozen=True)
class FailureIndication:
    """A structured failure emitted when the migration halts.

    ``failed_stage`` and ``affected_build`` are populated for build/gate halts
    so the operator can identify exactly which stage and which language build
    failed (R13.7).
    """

    reason: HaltReason
    message: str
    failed_stage: str | None = None
    affected_build: str | None = None


@dataclass
class MigrationResult:
    """The outcome of a migration run."""

    completed: bool
    branch_created: bool
    branch_committed: bool
    removed_directories: list[str] = field(default_factory=list)
    retained_build_config: list[str] = field(default_factory=list)
    branch_retained_for_rollback: bool = False
    failure: FailureIndication | None = None

    @property
    def preservation_branch_ready(self) -> bool:
        """Whether a committed preservation branch exists."""
        return self.branch_created and self.branch_committed


# ---------------------------------------------------------------------------
# Defaults derived from the design's legacy -> replacement mapping
# ---------------------------------------------------------------------------

DEFAULT_BRANCH_NAME = "legacy-preservation"

DEFAULT_STAGES: tuple[MigrationStage, ...] = (
    MigrationStage(
        legacy_dir="apps/desktop",
        replacement="apps/workbench",
        build_id="ts",
        build_label="TypeScript build (apps/workbench)",
    ),
    MigrationStage(
        legacy_dir="apps/frontend",
        replacement="apps/workbench",
        build_id="ts",
        build_label="TypeScript build (apps/workbench)",
    ),
    MigrationStage(
        legacy_dir="crates/hotpath",
        replacement="crates/hardware-probe",
        build_id="rust",
        build_label="Rust build (crates/hardware-probe)",
    ),
    MigrationStage(
        legacy_dir="packages/shared-types",
        replacement="packages/shared-types",
        build_id="ts",
        build_label="TypeScript build (packages/shared-types)",
    ),
    MigrationStage(
        legacy_dir="python/llama_studio_neural",
        replacement="python/zocai_evolution",
        build_id="python",
        build_label="Python build/typecheck (python/zocai_evolution)",
    ),
    MigrationStage(
        legacy_dir="services/agent",
        replacement="services/gateway",
        build_id="python",
        build_label="Python build/typecheck (services/gateway)",
    ),
)

DEFAULT_SHARED_BUILD_CONFIG: tuple[str, ...] = (
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "Cargo.toml",
    "Cargo.lock",
    "pyproject.toml",
    "uv.lock",
)


# ---------------------------------------------------------------------------
# Controller
# ---------------------------------------------------------------------------


class MigrationController:
    """Drives the build-gated clean-rebuild legacy cutover (Requirement 13).

    The controller guarantees, by construction, that:

    * No legacy directory is removed before a committed preservation branch
      exists (R13.2). Branch-create and branch-commit failures are two
      independent halt conditions that both delete nothing (R13.3, R13.8).
    * A legacy directory is removed only after its named replacement exists and
      its language build returns exit code 0 (R13.4, R13.6).
    * Shared build configuration is retained on every removal (R13.5).
    * Any stage build failure halts the run, retains the branch for rollback,
      and emits a failure indication naming the failed stage and affected build
      (R13.7).
    """

    def __init__(
        self,
        *,
        vcs: VersionControl,
        build_runner: BuildRunner,
        filesystem: FileSystem,
        stages: Sequence[MigrationStage] = DEFAULT_STAGES,
        branch_name: str = DEFAULT_BRANCH_NAME,
        shared_build_config: Iterable[str] = DEFAULT_SHARED_BUILD_CONFIG,
        emit: Callable[[FailureIndication], None] | None = None,
    ) -> None:
        self._vcs = vcs
        self._build_runner = build_runner
        self._fs = filesystem
        self._stages: tuple[MigrationStage, ...] = tuple(stages)
        self._branch_name = branch_name
        self._shared_build_config: tuple[str, ...] = tuple(shared_build_config)
        self._emit = emit

    # -- public API --------------------------------------------------------

    def run(self) -> MigrationResult:
        """Execute the full migration and return its outcome."""
        result = MigrationResult(
            completed=False,
            branch_created=False,
            branch_committed=False,
        )

        if not self._establish_preservation_branch(result):
            return result

        # The committed preservation branch now exists. Only from here may any
        # legacy directory be removed (R13.2). Every post-commit halt retains
        # the branch for rollback (R13.7).
        for stage in self._stages:
            if not self._process_stage(stage, result):
                return result

        result.completed = True
        return result

    def can_remove(self, stage: MigrationStage, *, branch_ready: bool) -> bool:
        """Pure predicate: may ``stage``'s legacy directory be removed now?

        Removal is permitted only when the committed preservation branch is
        ready AND the replacement exists AND its build returns exit code 0.
        Exposed for property tests that model the gate independently of the
        full run loop.
        """
        if not branch_ready:
            return False
        if not self._fs.exists(stage.replacement):
            return False
        return self._build_runner.run_build(stage.build_id) == 0

    # -- internal helpers --------------------------------------------------

    def _establish_preservation_branch(self, result: MigrationResult) -> bool:
        """Create and commit the preservation branch.

        Branch-create failure (R13.3) and branch-commit failure (R13.8) are
        independent halt conditions; both leave the workspace untouched and the
        branch is not retained for rollback because no removal has occurred.
        Returns ``True`` only when a committed preservation branch exists.
        """
        if not self._safe_call(self._vcs.create_branch, self._branch_name):
            result.failure = self._fail(
                HaltReason.BRANCH_CREATE_FAILED,
                f"Preservation branch {self._branch_name!r} could not be created; "
                "no legacy source deleted.",
            )
            return False
        result.branch_created = True

        commit_message = "Preserve complete legacy implementation before clean rebuild"
        if not self._safe_commit(self._branch_name, commit_message):
            result.failure = self._fail(
                HaltReason.BRANCH_COMMIT_FAILED,
                f"Preservation branch {self._branch_name!r} was created but could "
                "not be committed; no legacy source deleted.",
            )
            return False
        result.branch_committed = True
        return True

    def _process_stage(self, stage: MigrationStage, result: MigrationResult) -> bool:
        """Apply the replace-before-delete gate for one stage.

        Returns ``True`` when the stage's legacy directory was removed and the
        run may continue; ``False`` when the run must halt (branch retained for
        rollback).
        """
        # Replace-before-delete: the named replacement must exist first (R13.4).
        if not self._fs.exists(stage.replacement):
            result.branch_retained_for_rollback = True
            result.failure = self._fail(
                HaltReason.REPLACEMENT_MISSING,
                f"Replacement {stage.replacement!r} for legacy directory "
                f"{stage.legacy_dir!r} does not exist; removal blocked.",
                failed_stage=stage.legacy_dir,
                affected_build=stage.build_label,
            )
            return False

        # Build gate: the replacement's language build must return exit 0
        # (R13.4 / R13.6). On failure: halt, retain branch, emit failure (R13.7).
        exit_code = self._build_runner.run_build(stage.build_id)
        if exit_code != 0:
            result.branch_retained_for_rollback = True
            result.failure = self._fail(
                HaltReason.BUILD_FAILED,
                f"{stage.build_label} failed with exit code {exit_code} for stage "
                f"{stage.legacy_dir!r}; removal blocked and migration halted.",
                failed_stage=stage.legacy_dir,
                affected_build=stage.build_label,
            )
            return False

        # Gate satisfied -> remove the legacy directory (R13.4).
        self._fs.remove_directory(stage.legacy_dir)
        result.removed_directories.append(stage.legacy_dir)

        # Retain shared build configuration on each removal (R13.5).
        if not self._verify_shared_config_retained(stage, result):
            return False
        result.retained_build_config = list(self._shared_build_config)
        return True

    def _verify_shared_config_retained(
        self, stage: MigrationStage, result: MigrationResult
    ) -> bool:
        """Verify removal did not take any shared build config with it (R13.5)."""
        for config_path in self._shared_build_config:
            if not self._fs.exists(config_path):
                result.branch_retained_for_rollback = True
                result.failure = self._fail(
                    HaltReason.SHARED_CONFIG_LOST,
                    f"Shared build configuration {config_path!r} was lost while "
                    f"removing {stage.legacy_dir!r}; migration halted.",
                    failed_stage=stage.legacy_dir,
                    affected_build=stage.build_label,
                )
                return False
        return True

    def _fail(
        self,
        reason: HaltReason,
        message: str,
        *,
        failed_stage: str | None = None,
        affected_build: str | None = None,
    ) -> FailureIndication:
        """Build and emit a failure indication."""
        indication = FailureIndication(
            reason=reason,
            message=message,
            failed_stage=failed_stage,
            affected_build=affected_build,
        )
        if self._emit is not None:
            self._emit(indication)
        return indication

    @staticmethod
    def _safe_call(fn: Callable[[str], bool], name: str) -> bool:
        """Invoke a create-branch call, treating any raised error as failure."""
        try:
            return fn(name)
        except Exception:
            return False

    def _safe_commit(self, name: str, message: str) -> bool:
        """Invoke commit_branch, treating any raised error as failure."""
        try:
            return self._vcs.commit_branch(name, message)
        except Exception:
            return False
