"""Property test for the centralized deletion guard's gate (task 1.1).

Feature: zoc-agent-ecosystem-merge.

For *any* combination of preservation-branch readiness, replacement-path
existence, and replacement-module importability, the guard deletes a legacy
directory **iff** all required gates pass: the committed preservation branch
exists AND every supplied replacement reference is satisfied (path present
and/or module importable). Otherwise it raises and deletes nothing.

This is the deletion-side invariant the 9.x tasks depend on, cross-referencing
Rebuild-R13.2/R13.3/R13.4/R13.8 and Requirements 7.5, 8.5, 11.3 (a removal must
never leave the build without an importable replacement).
"""

from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st

from zocai_migration import DeletionGuard, GuardError, GuardReason, ReplacementSpec

_LEGACY = "services/agent"
_MODULE = "zocai_gateway"
_PATH = "services/gateway"


class _FakeBranchInspector:
    def __init__(self, *, ready: bool) -> None:
        self._ready = ready

    def branch_exists(self, name: str) -> bool:
        return self._ready

    def branch_has_commit(self, name: str) -> bool:
        return self._ready


class _FakeFileSystem:
    def __init__(self, existing: set[str]) -> None:
        self._paths = set(existing)
        self.removed: list[str] = []

    def exists(self, path: str) -> bool:
        return path in self._paths

    def remove_directory(self, path: str) -> None:
        self.removed.append(path)
        self._paths.discard(path)


@settings(max_examples=200)
@given(
    branch_ready=st.booleans(),
    path_exists=st.booleans(),
    module_importable=st.booleans(),
    use_module=st.booleans(),
    use_path=st.booleans(),
)
def test_guard_deletes_iff_all_gates_pass(
    branch_ready: bool,
    path_exists: bool,
    module_importable: bool,
    use_module: bool,
    use_path: bool,
) -> None:
    """Deletion occurs exactly when branch is committed and the supplied
    replacement references are all satisfied.

    Feature: zoc-agent-ecosystem-merge
    Validates: Requirements 7.5, 8.5, 11.3
    """
    # A spec must reference at least one replacement; force at least one on.
    if not use_module and not use_path:
        use_path = True

    spec = ReplacementSpec(
        legacy_path=_LEGACY,
        replacement_module=_MODULE if use_module else None,
        replacement_path=_PATH if use_path else None,
    )

    existing: set[str] = set()
    if path_exists:
        existing.add(_PATH)
    fs = _FakeFileSystem(existing)

    guard = DeletionGuard(
        branch_inspector=_FakeBranchInspector(ready=branch_ready),
        filesystem=fs,
        importable=lambda name: module_importable,
    )

    # Expected gate: branch committed AND every supplied reference satisfied.
    replacement_ok = True
    if use_path:
        replacement_ok = replacement_ok and path_exists
    if use_module:
        replacement_ok = replacement_ok and module_importable
    should_delete = branch_ready and replacement_ok

    if should_delete:
        outcome = guard.delete(spec)
        assert outcome.reason is GuardReason.OK
        assert outcome.deleted is True
        assert fs.removed == [_LEGACY]
    else:
        try:
            guard.delete(spec)
        except GuardError as exc:
            # The right gate was blamed, and nothing was deleted.
            if not branch_ready:
                assert exc.outcome.reason is GuardReason.PRESERVATION_BRANCH_MISSING
            else:
                assert exc.outcome.reason is GuardReason.REPLACEMENT_NOT_READY
            assert exc.exit_code != 0
            assert fs.removed == []
        else:  # pragma: no cover - would be a guard bug
            raise AssertionError("guard deleted despite a failing gate")
