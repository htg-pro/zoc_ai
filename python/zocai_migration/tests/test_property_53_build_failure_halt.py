"""Property 53: Migration halts and reports on stage build failure.

Feature: zocai-ecosystem-rebuild, Property 53: Migration halts and reports on
stage build failure.

Validates: Requirements 13.7

*For any* migration stage whose build fails, the migration halts, retains the
legacy preservation branch for rollback, and emits a failure indication
identifying the failed stage and the affected build (HaltReason.BUILD_FAILED).

The test drives the real :class:`MigrationController` through in-memory fakes
for the VCS, build, and filesystem ports. The build runner returns
caller-supplied per-build exit codes so Hypothesis can make any combination of
language builds fail. The workspace always contains every replacement and every
shared-config file, so the *only* reachable post-commit halt is a build-gate
failure -- isolating the behaviour Property 53 asserts.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping

from hypothesis import given, settings
from hypothesis import strategies as st

from zocai_migration import (
    DEFAULT_SHARED_BUILD_CONFIG,
    DEFAULT_STAGES,
    FailureIndication,
    HaltReason,
    MigrationController,
    MigrationStage,
)

# ---------------------------------------------------------------------------
# In-memory fakes (self-contained for this property test)
# ---------------------------------------------------------------------------


class FakeVCS:
    """VCS port whose branch create/commit always succeed."""

    def __init__(self) -> None:
        self.created: list[str] = []
        self.committed: list[str] = []

    def create_branch(self, name: str) -> bool:
        self.created.append(name)
        return True

    def commit_branch(self, name: str, message: str) -> bool:
        self.committed.append(name)
        return True


class FakeBuildRunner:
    """Build port returning configured exit codes per build id (default 0)."""

    def __init__(self, exit_codes: Mapping[str, int]) -> None:
        self._exit_codes = dict(exit_codes)
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
    """Workspace where every replacement, legacy dir, and config exists."""
    paths: set[str] = set(DEFAULT_SHARED_BUILD_CONFIG)
    for stage in DEFAULT_STAGES:
        paths.add(stage.replacement)
        paths.add(stage.legacy_dir)
    return FakeFileSystem(paths)


# ---------------------------------------------------------------------------
# Strategy: per-build-id exit codes with at least one failing build
# ---------------------------------------------------------------------------

_BUILD_IDS: tuple[str, ...] = tuple(sorted({s.build_id for s in DEFAULT_STAGES}))


@st.composite
def build_exit_codes(draw: st.DrawFn) -> dict[str, int]:
    """A mapping from build id to exit code with >=1 non-zero (failing) build.

    Each language build either succeeds (0) or fails with a non-zero exit code
    in the conventional 1..255 range. At least one build is forced to fail so
    that every generated example exercises a real build-gate failure.
    """
    exit_code = st.one_of(st.just(0), st.integers(min_value=1, max_value=255))
    codes = {build_id: draw(exit_code) for build_id in _BUILD_IDS}
    if all(code == 0 for code in codes.values()):
        forced = draw(st.sampled_from(_BUILD_IDS))
        codes[forced] = draw(st.integers(min_value=1, max_value=255))
    return codes


def _first_failing_stage(codes: Mapping[str, int]) -> MigrationStage:
    """The first stage (in canonical order) whose language build fails."""
    for stage in DEFAULT_STAGES:
        if codes.get(stage.build_id, 0) != 0:
            return stage
    raise AssertionError("strategy guarantees at least one failing build")


# ---------------------------------------------------------------------------
# Property 53
# ---------------------------------------------------------------------------


@settings(max_examples=200)
@given(codes=build_exit_codes())
def test_build_failure_halts_retains_branch_and_reports_stage(
    codes: dict[str, int],
) -> None:
    """Any failing stage build halts the migration with a BUILD_FAILED report.

    Feature: zocai-ecosystem-rebuild, Property 53.
    Validates: Requirements 13.7.
    """
    expected = _first_failing_stage(codes)
    vcs = FakeVCS()
    fs = _full_workspace()
    emitted: list[FailureIndication] = []

    controller = MigrationController(
        vcs=vcs,
        build_runner=FakeBuildRunner(codes),
        filesystem=fs,
        emit=emitted.append,
    )
    result = controller.run()

    # The migration halts (does not complete) ...
    assert result.completed is False
    # ... after a committed preservation branch already existed ...
    assert result.preservation_branch_ready is True
    # ... and the branch is retained for rollback (R13.7).
    assert result.branch_retained_for_rollback is True

    # A failure indication is emitted exactly once, of kind BUILD_FAILED, and
    # it names both the failed stage and the affected language build (R13.7).
    assert result.failure is not None
    assert result.failure.reason is HaltReason.BUILD_FAILED
    assert result.failure.failed_stage == expected.legacy_dir
    assert result.failure.affected_build == expected.build_label
    assert str(codes[expected.build_id]) in result.failure.message
    assert emitted == [result.failure]

    # The failing stage's legacy directory is never removed; nor is anything at
    # or beyond it. Only stages strictly before the failing one (all green
    # builds) were removed, preserving the halt-on-first-failure guarantee.
    halt_index = DEFAULT_STAGES.index(expected)
    removed_before = [s.legacy_dir for s in DEFAULT_STAGES[:halt_index]]
    assert result.removed_directories == removed_before
    assert fs.removed == removed_before
    assert expected.legacy_dir not in result.removed_directories
