"""Property test for the replace-before-delete build gate (task 1.5).

Feature: zocai-ecosystem-rebuild, Property 51: Migration never removes a legacy
directory before a built replacement exists.

**Validates: Requirements 13.4, 13.6**

For *any* ordering of migration steps and *any* combination of replacement
existence and language build exit codes, a legacy directory is removed only
when ALL of the following hold:

* a committed preservation branch exists, AND
* the named replacement component exists in the workspace, AND
* that component's language build returns exit code zero.

If the replacement is missing or its build fails, removal of that legacy
directory is prevented and the migration halts.

These properties drive the ``MigrationController`` through in-memory fakes
(``FakeVCS``, ``FakeBuildRunner``, ``FakeFileSystem``) so the gate is exercised
deterministically over randomized inputs.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping

from hypothesis import given, settings
from hypothesis import strategies as st

from zocai_migration import (
    DEFAULT_SHARED_BUILD_CONFIG,
    DEFAULT_STAGES,
    MigrationController,
    MigrationStage,
)

# ---------------------------------------------------------------------------
# In-memory fakes (mirrors of the unit-test fakes; kept local so the property
# test is self-contained and uses only real controller logic, no mocking).
# ---------------------------------------------------------------------------


class FakeVCS:
    """VCS port with independently controllable create/commit outcomes."""

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


# Build ids used across the default stages, and the legacy/replacement universe.
_BUILD_IDS = sorted({s.build_id for s in DEFAULT_STAGES})
_REPLACEMENTS = sorted({s.replacement for s in DEFAULT_STAGES})

# Exit codes: 0 (pass) plus a spread of non-zero failure codes.
_exit_code = st.integers(min_value=0, max_value=130)


@st.composite
def _migration_world(draw: st.DrawFn) -> dict[str, object]:
    """Generate a randomized migration world.

    Randomizes: branch create/commit success, which replacements exist, and the
    exit code each language build returns. Shared build config and legacy dirs
    always start present so the only gate variables under test are branch
    readiness, replacement existence, and build exit code.
    """
    can_create = draw(st.booleans())
    can_commit = draw(st.booleans())

    # Each replacement independently present or absent.
    replacement_present = {
        rep: draw(st.booleans()) for rep in _REPLACEMENTS
    }
    # Self-aliased stages (legacy_dir == replacement) share a single path in the
    # fake filesystem, and ``_build_world`` always adds ``legacy_dir``. Such a
    # path therefore always exists regardless of the drawn boolean, so coerce
    # the model to True to keep it consistent with the fake filesystem.
    for stage in DEFAULT_STAGES:
        if stage.legacy_dir == stage.replacement:
            replacement_present[stage.replacement] = True
    # Each build id returns an independently chosen exit code.
    exit_codes = {bid: draw(_exit_code) for bid in _BUILD_IDS}

    return {
        "can_create": can_create,
        "can_commit": can_commit,
        "replacement_present": replacement_present,
        "exit_codes": exit_codes,
    }


def _build_world(world: Mapping[str, object]) -> tuple[FakeVCS, FakeBuildRunner, FakeFileSystem]:
    replacement_present: Mapping[str, bool] = world["replacement_present"]  # type: ignore[assignment]
    exit_codes: Mapping[str, int] = world["exit_codes"]  # type: ignore[assignment]

    paths: set[str] = set(DEFAULT_SHARED_BUILD_CONFIG)
    for stage in DEFAULT_STAGES:
        paths.add(stage.legacy_dir)
        if replacement_present.get(stage.replacement, False):
            paths.add(stage.replacement)

    vcs = FakeVCS(
        can_create=bool(world["can_create"]),
        can_commit=bool(world["can_commit"]),
    )
    build = FakeBuildRunner(exit_codes)
    fs = FakeFileSystem(paths)
    return vcs, build, fs


# ---------------------------------------------------------------------------
# Property 51
# ---------------------------------------------------------------------------


@settings(max_examples=200)
@given(world=_migration_world())
def test_property_51_removal_only_after_built_replacement_exists(
    world: Mapping[str, object],
) -> None:
    """A legacy dir is removed only when branch-committed, replacement exists,
    and its build returns exit 0; otherwise removal is prevented.

    Feature: zocai-ecosystem-rebuild, Property 51
    Validates: Requirements 13.4, 13.6
    """
    replacement_present: Mapping[str, bool] = world["replacement_present"]  # type: ignore[assignment]
    exit_codes: Mapping[str, int] = world["exit_codes"]  # type: ignore[assignment]
    branch_committed = bool(world["can_create"]) and bool(world["can_commit"])

    vcs, build, fs = _build_world(world)
    result = MigrationController(vcs=vcs, build_runner=build, filesystem=fs).run()

    # (a) Nothing is ever removed unless a committed preservation branch exists.
    if not branch_committed:
        assert result.removed_directories == []
        assert fs.removed == []
        return

    # (b) Every removed legacy directory satisfied the full gate: its named
    #     replacement existed AND its language build returned exit code 0.
    for legacy_dir in result.removed_directories:
        stage = next(s for s in DEFAULT_STAGES if s.legacy_dir == legacy_dir)
        assert replacement_present.get(stage.replacement, False) is True, (
            f"{legacy_dir} removed though replacement {stage.replacement} was absent"
        )
        assert exit_codes.get(stage.build_id, 0) == 0, (
            f"{legacy_dir} removed though build {stage.build_id} did not pass"
        )

    # (c) Removal order is a prefix of the stage order, and the controller halts
    #     at the FIRST stage that fails the gate (replace-before-delete is
    #     strict: no later directory is removed once one is blocked).
    removed = result.removed_directories
    assert removed == [s.legacy_dir for s in DEFAULT_STAGES][: len(removed)]

    if not result.completed:
        # The first un-removed stage is exactly the one whose gate failed.
        blocked = DEFAULT_STAGES[len(removed)]
        gate_open = (
            replacement_present.get(blocked.replacement, False)
            and exit_codes.get(blocked.build_id, 0) == 0
        )
        assert gate_open is False, (
            f"stage {blocked.legacy_dir} was blocked though its gate was open"
        )


@settings(max_examples=200)
@given(
    branch_ready=st.booleans(),
    replacement_exists=st.booleans(),
    exit_code=_exit_code,
)
def test_property_51_can_remove_predicate_matches_gate(
    branch_ready: bool, replacement_exists: bool, exit_code: int
) -> None:
    """The pure ``can_remove`` gate is true iff branch-ready AND replacement
    exists AND build exit code is zero.

    Feature: zocai-ecosystem-rebuild, Property 51
    Validates: Requirements 13.4, 13.6
    """
    stage = MigrationStage(
        legacy_dir="legacy/x",
        replacement="new/x",
        build_id="ts",
        build_label="TS build (new/x)",
    )
    existing: set[str] = {"new/x"} if replacement_exists else set()
    controller = MigrationController(
        vcs=FakeVCS(),
        build_runner=FakeBuildRunner({"ts": exit_code}),
        filesystem=FakeFileSystem(existing),
        stages=(stage,),
    )

    expected = branch_ready and replacement_exists and exit_code == 0
    assert controller.can_remove(stage, branch_ready=branch_ready) is expected
