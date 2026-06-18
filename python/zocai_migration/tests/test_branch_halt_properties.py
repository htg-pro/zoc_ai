"""Property test for independent branch-create vs branch-commit halts.

Feature: zocai-ecosystem-rebuild, Property 50

Property 50: Branch-creation failure and branch-commit failure are two
independent halt conditions.

*For any* migration run, if the preservation branch cannot be created the
migration halts and deletes no legacy source, and independently, if the branch
is created but cannot be committed the migration halts and deletes no legacy
source.

**Validates: Requirements 13.3, 13.8**

These tests drive the ``MigrationController`` through the in-memory ``FakeVCS``
(whose ``can_create``/``can_commit`` flags are toggled independently) over a
full workspace -- so that a *successful* preservation branch would otherwise
lead to legacy removals. That framing makes "deletes no legacy source"
meaningful: any deletion in a halted run would be a violation.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping

from hypothesis import given, settings
from hypothesis import strategies as st

from zocai_migration import (
    DEFAULT_SHARED_BUILD_CONFIG,
    DEFAULT_STAGES,
    HaltReason,
    MigrationController,
)

# ---------------------------------------------------------------------------
# In-memory fakes (mirrors tests/test_controller.py)
# ---------------------------------------------------------------------------


class FakeVCS:
    """In-memory VCS port with independently controllable create/commit."""

    def __init__(self, *, can_create: bool = True, can_commit: bool = True) -> None:
        self._can_create = can_create
        self._can_commit = can_commit
        self.created: list[str] = []
        self.committed: list[str] = []

    def create_branch(self, name: str) -> bool:
        if not self._can_create:
            return False
        self.created.append(name)
        return True

    def commit_branch(self, name: str, message: str) -> bool:
        if not self._can_commit:
            return False
        self.committed.append(name)
        return True


class FakeBuildRunner:
    """Build port returning configured exit codes per build id."""

    def __init__(self, exit_codes: Mapping[str, int] | None = None) -> None:
        self._exit_codes = dict(exit_codes or {})
        self.calls: list[str] = []

    def run_build(self, build_id: str) -> int:
        self.calls.append(build_id)
        return self._exit_codes.get(build_id, 0)


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


def _full_workspace() -> FakeFileSystem:
    """A filesystem where every replacement, legacy dir, and config exists.

    With this workspace a committed preservation branch would proceed to remove
    every legacy directory, so a halted run that removes nothing is a genuine
    signal that the branch gate stopped the run.
    """
    paths: set[str] = set(DEFAULT_SHARED_BUILD_CONFIG)
    for stage in DEFAULT_STAGES:
        paths.add(stage.replacement)
        paths.add(stage.legacy_dir)
    return FakeFileSystem(paths)


def _run(*, can_create: bool, can_commit: bool):
    """Run a migration over a full workspace with the given VCS toggles."""
    vcs = FakeVCS(can_create=can_create, can_commit=can_commit)
    fs = _full_workspace()
    result = MigrationController(
        vcs=vcs,
        build_runner=FakeBuildRunner(),
        filesystem=fs,
    ).run()
    return result, vcs, fs


# ---------------------------------------------------------------------------
# Property 50
# ---------------------------------------------------------------------------


@settings(max_examples=200)
@given(can_create=st.booleans(), can_commit=st.booleans())
def test_branch_create_and_commit_are_independent_halt_conditions(
    can_create: bool, can_commit: bool
) -> None:
    """The two halt conditions are independent and each deletes nothing.

    Feature: zocai-ecosystem-rebuild, Property 50
    Validates: Requirements 13.3, 13.8
    """
    result, vcs, fs = _run(can_create=can_create, can_commit=can_commit)

    if not can_create:
        # R13.3: branch cannot be created -> halt, delete nothing. This outcome
        # must NOT depend on the commit capability (commit is never attempted).
        assert result.completed is False
        assert result.branch_created is False
        assert result.branch_committed is False
        assert result.failure is not None
        assert result.failure.reason is HaltReason.BRANCH_CREATE_FAILED
        assert result.removed_directories == []
        assert fs.removed == []
        assert vcs.committed == []  # commit independent: never reached
    elif not can_commit:
        # R13.8: branch created but cannot be committed -> halt, delete nothing.
        assert result.completed is False
        assert result.branch_created is True
        assert result.branch_committed is False
        assert result.failure is not None
        assert result.failure.reason is HaltReason.BRANCH_COMMIT_FAILED
        assert result.removed_directories == []
        assert fs.removed == []
    else:
        # Both succeed -> the branch gate does not halt the run; with a full
        # workspace the migration completes and removals occur only now.
        assert result.preservation_branch_ready is True
        assert result.failure is None
        assert result.removed_directories != []


@settings(max_examples=200)
@given(commit_when_create_fails=st.booleans())
def test_create_failure_outcome_is_independent_of_commit_capability(
    commit_when_create_fails: bool,
) -> None:
    """Create-failure halt is unaffected by the commit toggle's value.

    Demonstrates independence directly: fixing ``can_create=False`` while
    varying ``can_commit`` yields the same BRANCH_CREATE_FAILED halt with no
    deletions either way.

    Feature: zocai-ecosystem-rebuild, Property 50
    Validates: Requirements 13.3, 13.8
    """
    result, _vcs, fs = _run(can_create=False, can_commit=commit_when_create_fails)

    assert result.completed is False
    assert result.failure is not None
    assert result.failure.reason is HaltReason.BRANCH_CREATE_FAILED
    assert result.branch_created is False
    assert fs.removed == []


@settings(max_examples=200)
@given(create_succeeds=st.booleans())
def test_commit_failure_arises_exactly_when_create_succeeds(
    create_succeeds: bool,
) -> None:
    """A commit-failure halt occurs only after a successful create.

    With ``can_commit=False`` fixed, the halt reason depends solely on whether
    create succeeded: create-failure short-circuits before commit, and a
    successful create surfaces the independent commit-failure halt. Neither
    branch deletes any legacy source.

    Feature: zocai-ecosystem-rebuild, Property 50
    Validates: Requirements 13.3, 13.8
    """
    result, _vcs, fs = _run(can_create=create_succeeds, can_commit=False)

    assert result.completed is False
    assert result.failure is not None
    assert fs.removed == []
    if create_succeeds:
        assert result.failure.reason is HaltReason.BRANCH_COMMIT_FAILED
        assert result.branch_created is True
    else:
        assert result.failure.reason is HaltReason.BRANCH_CREATE_FAILED
        assert result.branch_created is False
