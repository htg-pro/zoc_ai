"""Build-gated clean-rebuild migration controller (Requirement 13).

This package implements the policy engine that enforces the
preservation-branch-first -> replace-before-delete -> per-language build-gate
discipline before any legacy directory is removed. It performs no real git,
build, or filesystem mutation itself; it drives injectable abstractions so it
can be exercised deterministically by unit, property, and integration tests.

Replaces ad-hoc deletion scripting for the legacy cutover (task 15).
"""

from __future__ import annotations

from zocai_migration.controller import (
    DEFAULT_BRANCH_NAME,
    DEFAULT_SHARED_BUILD_CONFIG,
    DEFAULT_STAGES,
    BuildRunner,
    FailureIndication,
    FileSystem,
    HaltReason,
    MigrationController,
    MigrationResult,
    MigrationStage,
    VersionControl,
)
from zocai_migration.git_vcs import GitVersionControl, git_available
from zocai_migration.guard import (
    BranchInspector,
    DeletionGuard,
    GuardError,
    GuardOutcome,
    GuardReason,
    OnDiskFileSystem,
    ReplacementSpec,
    module_importable,
)

__version__ = "0.1.0"

__all__ = [
    "DEFAULT_BRANCH_NAME",
    "DEFAULT_SHARED_BUILD_CONFIG",
    "DEFAULT_STAGES",
    "BranchInspector",
    "BuildRunner",
    "DeletionGuard",
    "FailureIndication",
    "FileSystem",
    "GitVersionControl",
    "GuardError",
    "GuardOutcome",
    "GuardReason",
    "HaltReason",
    "MigrationController",
    "MigrationResult",
    "MigrationStage",
    "OnDiskFileSystem",
    "ReplacementSpec",
    "VersionControl",
    "git_available",
    "module_importable",
]
