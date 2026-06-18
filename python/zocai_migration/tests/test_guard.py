"""Unit tests for the preservation-branch + replace-before-delete guard (task 1.1).

These exercise :class:`zocai_migration.guard.DeletionGuard` through in-memory
fakes for the branch inspector and filesystem ports, plus a controllable
importability predicate, so each gate is verified independently and in
combination.

Cross-ref Requirements 7.5, 8.5, 11.3 (Rebuild-R13.2/R13.3/R13.4/R13.8).
"""

from __future__ import annotations

from collections.abc import Iterable

import pytest

from zocai_migration import (
    DeletionGuard,
    GuardError,
    GuardReason,
    ReplacementSpec,
    module_importable,
)


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class FakeBranchInspector:
    """Branch inspector with controllable existence/commit answers."""

    def __init__(self, *, exists: bool = True, has_commit: bool = True) -> None:
        self._exists = exists
        self._has_commit = has_commit

    def branch_exists(self, name: str) -> bool:
        return self._exists

    def branch_has_commit(self, name: str) -> bool:
        return self._has_commit


class FakeFileSystem:
    """In-memory filesystem tracking existing paths and removals."""

    def __init__(self, existing: Iterable[str]) -> None:
        self._paths: set[str] = set(existing)
        self.removed: list[str] = []

    def exists(self, path: str) -> bool:
        return path in self._paths

    def remove_directory(self, path: str) -> None:
        self.removed.append(path)
        self._paths.discard(path)


def _guard(
    *,
    branch_ready: bool = True,
    existing: Iterable[str] = (),
    importable: set[str] | None = None,
    fs: FakeFileSystem | None = None,
) -> tuple[DeletionGuard, FakeFileSystem]:
    importable_set = importable if importable is not None else set()
    filesystem = fs if fs is not None else FakeFileSystem(existing)
    guard = DeletionGuard(
        branch_inspector=FakeBranchInspector(
            exists=branch_ready, has_commit=branch_ready
        ),
        filesystem=filesystem,
        importable=lambda name: name in importable_set,
    )
    return guard, filesystem


_SPEC = ReplacementSpec(
    legacy_path="services/agent",
    replacement_module="zocai_gateway",
    replacement_path="services/gateway",
    label="services/agent",
)


# ---------------------------------------------------------------------------
# Preservation-branch precondition (R13.2/R13.3/R13.8)
# ---------------------------------------------------------------------------


def test_preservation_branch_ready_requires_branch_and_commit() -> None:
    ready, _ = _guard(branch_ready=True)
    assert ready.preservation_branch_ready() is True

    no_branch = DeletionGuard(
        branch_inspector=FakeBranchInspector(exists=False, has_commit=False),
        filesystem=FakeFileSystem(()),
    )
    assert no_branch.preservation_branch_ready() is False

    # A ref with no commit does not satisfy the precondition (R13.8).
    ref_only = DeletionGuard(
        branch_inspector=FakeBranchInspector(exists=True, has_commit=False),
        filesystem=FakeFileSystem(()),
    )
    assert ref_only.preservation_branch_ready() is False


def test_inspector_raising_is_treated_as_no_branch() -> None:
    class RaisingInspector:
        def branch_exists(self, name: str) -> bool:
            raise RuntimeError("git unavailable")

        def branch_has_commit(self, name: str) -> bool:
            return True

    guard = DeletionGuard(
        branch_inspector=RaisingInspector(), filesystem=FakeFileSystem(())
    )
    assert guard.preservation_branch_ready() is False


def test_delete_aborts_when_preservation_branch_missing() -> None:
    guard, fs = _guard(
        branch_ready=False,
        existing={"services/gateway"},
        importable={"zocai_gateway"},
    )
    with pytest.raises(GuardError) as excinfo:
        guard.delete(_SPEC)

    outcome = excinfo.value.outcome
    assert outcome.reason is GuardReason.PRESERVATION_BRANCH_MISSING
    assert outcome.exit_code != 0
    assert fs.removed == []  # nothing deleted


# ---------------------------------------------------------------------------
# Replace-before-delete (R13.4): present AND importable
# ---------------------------------------------------------------------------


def test_delete_aborts_when_replacement_module_not_importable() -> None:
    # Path exists but the module is not importable -> refuse.
    guard, fs = _guard(
        branch_ready=True,
        existing={"services/gateway"},
        importable=set(),
    )
    with pytest.raises(GuardError) as excinfo:
        guard.delete(_SPEC)

    assert excinfo.value.outcome.reason is GuardReason.REPLACEMENT_NOT_READY
    assert "not importable" in excinfo.value.outcome.message
    assert fs.removed == []


def test_delete_aborts_when_replacement_path_missing() -> None:
    # Module importable but the path is absent -> refuse.
    guard, fs = _guard(
        branch_ready=True,
        existing=set(),
        importable={"zocai_gateway"},
    )
    with pytest.raises(GuardError) as excinfo:
        guard.delete(_SPEC)

    assert excinfo.value.outcome.reason is GuardReason.REPLACEMENT_NOT_READY
    assert "does not exist" in excinfo.value.outcome.message
    assert fs.removed == []


def test_delete_succeeds_when_branch_committed_and_replacement_ready() -> None:
    guard, fs = _guard(
        branch_ready=True,
        existing={"services/gateway", "services/agent"},
        importable={"zocai_gateway"},
    )
    outcome = guard.delete(_SPEC)

    assert outcome.reason is GuardReason.OK
    assert outcome.deleted is True
    assert outcome.exit_code == 0
    assert fs.removed == ["services/agent"]


def test_module_only_spec_uses_importability_alone() -> None:
    spec = ReplacementSpec(
        legacy_path="python/llama_studio_neural",
        replacement_module="zocai_evolution",
    )
    guard, fs = _guard(
        branch_ready=True,
        existing=set(),
        importable={"zocai_evolution"},
    )
    assert guard.delete(spec).deleted is True
    assert fs.removed == ["python/llama_studio_neural"]


def test_path_only_spec_uses_existence_alone() -> None:
    spec = ReplacementSpec(
        legacy_path="apps/frontend/src/lib/sse.ts",
        replacement_path="apps/frontend/src/features/agent/useAgentStream.ts",
    )
    guard, fs = _guard(
        branch_ready=True,
        existing={"apps/frontend/src/features/agent/useAgentStream.ts"},
    )
    assert guard.delete(spec).deleted is True
    assert fs.removed == ["apps/frontend/src/lib/sse.ts"]


# ---------------------------------------------------------------------------
# ReplacementSpec validation and importability helper
# ---------------------------------------------------------------------------


def test_replacement_spec_requires_a_replacement_reference() -> None:
    with pytest.raises(ValueError):
        ReplacementSpec(legacy_path="services/agent")


def test_replacement_spec_requires_legacy_path() -> None:
    with pytest.raises(ValueError):
        ReplacementSpec(legacy_path="", replacement_module="zocai_gateway")


def test_module_importable_against_real_modules() -> None:
    # The package under test is importable; a fabricated name is not.
    assert module_importable("zocai_migration") is True
    assert module_importable("definitely_not_a_real_module_xyz") is False
    assert module_importable("") is False
