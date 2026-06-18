"""Unit tests for the MigrationController (Requirement 13, task 1.2).

These tests exercise the controller through in-memory fakes for the VCS,
build, and filesystem ports. Property tests (tasks 1.3-1.7) and the VCS
integration test (task 1.8) build on the same abstractions.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping

from zocai_migration import (
    DEFAULT_SHARED_BUILD_CONFIG,
    DEFAULT_STAGES,
    FailureIndication,
    HaltReason,
    MigrationController,
    MigrationStage,
)

# ---------------------------------------------------------------------------
# Fakes
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
    """A filesystem where every replacement, legacy dir, and config exists."""
    paths: set[str] = set(DEFAULT_SHARED_BUILD_CONFIG)
    for stage in DEFAULT_STAGES:
        paths.add(stage.replacement)
        paths.add(stage.legacy_dir)
    return FakeFileSystem(paths)


def _controller(
    *,
    vcs: FakeVCS,
    build: FakeBuildRunner,
    fs: FakeFileSystem,
    emitted: list[FailureIndication] | None = None,
) -> MigrationController:
    return MigrationController(
        vcs=vcs,
        build_runner=build,
        filesystem=fs,
        emit=(emitted.append if emitted is not None else None),
    )


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_full_migration_removes_all_legacy_dirs_after_committed_branch() -> None:
    vcs = FakeVCS()
    build = FakeBuildRunner()
    fs = _full_workspace()

    result = _controller(vcs=vcs, build=build, fs=fs).run()

    assert result.completed is True
    assert result.preservation_branch_ready is True
    assert result.failure is None
    # Every legacy directory was removed, in stage order.
    assert result.removed_directories == [s.legacy_dir for s in DEFAULT_STAGES]
    assert fs.removed == [s.legacy_dir for s in DEFAULT_STAGES]
    # Branch created and committed before any removal occurred.
    assert vcs.created and vcs.committed
    # Shared build config retained (R13.5).
    assert result.retained_build_config == list(DEFAULT_SHARED_BUILD_CONFIG)
    for config_path in DEFAULT_SHARED_BUILD_CONFIG:
        assert fs.exists(config_path)


# ---------------------------------------------------------------------------
# Independent halt conditions (R13.3, R13.8)
# ---------------------------------------------------------------------------


def test_branch_create_failure_deletes_nothing() -> None:
    vcs = FakeVCS(can_create=False)
    build = FakeBuildRunner()
    fs = _full_workspace()
    emitted: list[FailureIndication] = []

    result = _controller(vcs=vcs, build=build, fs=fs, emitted=emitted).run()

    assert result.completed is False
    assert result.branch_created is False
    assert result.branch_committed is False
    assert result.removed_directories == []
    assert fs.removed == []
    assert result.branch_retained_for_rollback is False
    assert result.failure is not None
    assert result.failure.reason is HaltReason.BRANCH_CREATE_FAILED
    assert emitted == [result.failure]


def test_branch_commit_failure_deletes_nothing() -> None:
    vcs = FakeVCS(can_commit=False)
    build = FakeBuildRunner()
    fs = _full_workspace()

    result = _controller(vcs=vcs, build=build, fs=fs).run()

    assert result.completed is False
    assert result.branch_created is True
    assert result.branch_committed is False
    assert result.removed_directories == []
    assert fs.removed == []
    assert result.failure is not None
    assert result.failure.reason is HaltReason.BRANCH_COMMIT_FAILED


def test_create_and_commit_failures_are_independent() -> None:
    # Create succeeds, commit fails -> commit-specific halt, nothing deleted.
    result = _controller(
        vcs=FakeVCS(can_create=True, can_commit=False),
        build=FakeBuildRunner(),
        fs=_full_workspace(),
    ).run()
    assert result.failure is not None
    assert result.failure.reason is HaltReason.BRANCH_COMMIT_FAILED
    assert result.branch_created is True

    # Create fails -> commit is never attempted.
    vcs = FakeVCS(can_create=False)
    result2 = _controller(vcs=vcs, build=FakeBuildRunner(), fs=_full_workspace()).run()
    assert result2.failure is not None
    assert result2.failure.reason is HaltReason.BRANCH_CREATE_FAILED
    assert vcs.committed == []


def test_raising_vcs_is_treated_as_failure() -> None:
    class RaisingVCS:
        def create_branch(self, name: str) -> bool:
            raise RuntimeError("git unavailable")

        def commit_branch(self, name: str, message: str) -> bool:
            return True

    fs = _full_workspace()
    result = MigrationController(
        vcs=RaisingVCS(), build_runner=FakeBuildRunner(), filesystem=fs
    ).run()

    assert result.failure is not None
    assert result.failure.reason is HaltReason.BRANCH_CREATE_FAILED
    assert fs.removed == []


# ---------------------------------------------------------------------------
# Replace-before-delete gate (R13.4, R13.6, R13.7)
# ---------------------------------------------------------------------------


def test_missing_replacement_blocks_removal_and_retains_branch() -> None:
    # Drop the first stage's replacement from the workspace.
    first = DEFAULT_STAGES[0]
    paths: set[str] = set(DEFAULT_SHARED_BUILD_CONFIG)
    for stage in DEFAULT_STAGES:
        paths.add(stage.legacy_dir)
        if stage.replacement != first.replacement:
            paths.add(stage.replacement)
    fs = FakeFileSystem(paths)

    result = _controller(vcs=FakeVCS(), build=FakeBuildRunner(), fs=fs).run()

    assert result.completed is False
    assert result.removed_directories == []
    assert fs.removed == []
    assert result.branch_retained_for_rollback is True
    assert result.failure is not None
    assert result.failure.reason is HaltReason.REPLACEMENT_MISSING
    assert result.failure.failed_stage == first.legacy_dir


def test_build_failure_halts_retains_branch_and_names_stage_and_build() -> None:
    # The Rust build fails; the crates/hotpath stage must be blocked.
    rust_stage = next(s for s in DEFAULT_STAGES if s.build_id == "rust")
    build = FakeBuildRunner({"rust": 101})
    fs = _full_workspace()
    emitted: list[FailureIndication] = []

    result = _controller(vcs=FakeVCS(), build=build, fs=fs, emitted=emitted).run()

    assert result.completed is False
    assert result.branch_retained_for_rollback is True
    assert rust_stage.legacy_dir not in result.removed_directories
    assert rust_stage.legacy_dir not in fs.removed
    assert result.failure is not None
    assert result.failure.reason is HaltReason.BUILD_FAILED
    assert result.failure.failed_stage == rust_stage.legacy_dir
    assert result.failure.affected_build == rust_stage.build_label
    assert "101" in result.failure.message
    assert emitted == [result.failure]


def test_can_remove_predicate_requires_branch_replacement_and_green_build() -> None:
    stage = MigrationStage(
        legacy_dir="legacy/x",
        replacement="new/x",
        build_id="ts",
        build_label="TS build (new/x)",
    )
    fs = FakeFileSystem({"new/x"})

    ok = MigrationController(
        vcs=FakeVCS(),
        build_runner=FakeBuildRunner({"ts": 0}),
        filesystem=fs,
        stages=(stage,),
    )
    assert ok.can_remove(stage, branch_ready=True) is True
    assert ok.can_remove(stage, branch_ready=False) is False

    failing_build = MigrationController(
        vcs=FakeVCS(),
        build_runner=FakeBuildRunner({"ts": 2}),
        filesystem=FakeFileSystem({"new/x"}),
        stages=(stage,),
    )
    assert failing_build.can_remove(stage, branch_ready=True) is False

    missing_replacement = MigrationController(
        vcs=FakeVCS(),
        build_runner=FakeBuildRunner({"ts": 0}),
        filesystem=FakeFileSystem(set()),
        stages=(stage,),
    )
    assert missing_replacement.can_remove(stage, branch_ready=True) is False


def test_shared_config_lost_during_removal_halts() -> None:
    class ConfigClobberingFS(FakeFileSystem):
        def remove_directory(self, path: str) -> None:
            super().remove_directory(path)
            # Simulate a removal that also wipes a shared config file.
            self._paths.discard("pyproject.toml")

    fs = ConfigClobberingFS(
        set(DEFAULT_SHARED_BUILD_CONFIG)
        | {s.replacement for s in DEFAULT_STAGES}
        | {s.legacy_dir for s in DEFAULT_STAGES}
    )

    result = _controller(vcs=FakeVCS(), build=FakeBuildRunner(), fs=fs).run()

    assert result.completed is False
    assert result.failure is not None
    assert result.failure.reason is HaltReason.SHARED_CONFIG_LOST
    assert result.branch_retained_for_rollback is True
