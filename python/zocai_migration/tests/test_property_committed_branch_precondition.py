"""Property test for the committed-branch precondition (task 1.3).

Feature: zocai-ecosystem-rebuild, Property 49: A committed preservation branch
exists before any legacy component is removed.

**Validates: Requirements 13.2**

Design Property 49 (verbatim intent): *For any* ordering of migration steps,
every removal of a legacy component is preceded by an already-created and
already-committed legacy preservation branch; no legacy component is removed
while the committed branch does not yet exist.

Strategy
--------
We drive the real :class:`MigrationController` through instrumented ports that
append to a single shared, ordered event log. Hypothesis explores:

* arbitrary orderings and subsets of the migration stages (the "ordering of
  migration steps"),
* whether branch creation and/or commit succeed or fail,
* which replacements exist on disk,
* per-build exit codes (so removals may or may not be gated through).

For every run we assert the temporal invariant: at the index of *every*
``remove_directory`` event in the shared log, a ``create_branch`` event and a
``commit_branch`` event both appear strictly earlier. This holds for any
ordering because the controller refuses to enter the removal phase until a
committed preservation branch exists.
"""

from __future__ import annotations

from collections.abc import Mapping

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from zocai_migration import (
    DEFAULT_SHARED_BUILD_CONFIG,
    DEFAULT_STAGES,
    MigrationController,
    MigrationStage,
)

# ---------------------------------------------------------------------------
# Shared-log instrumented ports
# ---------------------------------------------------------------------------

# Event log entries are (kind, payload) tuples ordered by occurrence.
CREATE = "create_branch"
COMMIT = "commit_branch"
REMOVE = "remove"


class RecordingVCS:
    """VCS port that records create/commit events into a shared log."""

    def __init__(
        self, log: list[tuple[str, str]], *, can_create: bool, can_commit: bool
    ) -> None:
        self._log = log
        self._can_create = can_create
        self._can_commit = can_commit

    def create_branch(self, name: str) -> bool:
        if not self._can_create:
            return False
        self._log.append((CREATE, name))
        return True

    def commit_branch(self, name: str, message: str) -> bool:
        if not self._can_commit:
            return False
        self._log.append((COMMIT, name))
        return True


class RecordingBuildRunner:
    """Build port returning configured exit codes per build id."""

    def __init__(self, exit_codes: Mapping[str, int]) -> None:
        self._exit_codes = dict(exit_codes)

    def run_build(self, build_id: str) -> int:
        return self._exit_codes.get(build_id, 0)


class RecordingFileSystem:
    """Filesystem port that records every legacy-directory removal."""

    def __init__(self, log: list[tuple[str, str]], existing: set[str]) -> None:
        self._log = log
        self._paths = set(existing)

    def exists(self, path: str) -> bool:
        return path in self._paths

    def remove_directory(self, path: str) -> None:
        self._log.append((REMOVE, path))
        self._paths.discard(path)


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

_BUILD_IDS = sorted({s.build_id for s in DEFAULT_STAGES})


@st.composite
def _stage_orderings(draw: st.DrawFn) -> tuple[MigrationStage, ...]:
    """An arbitrary non-empty ordering/subset of the migration stages.

    Models "any ordering of migration steps" by permuting a random subset of
    the canonical stages.
    """
    stages = draw(
        st.lists(st.sampled_from(DEFAULT_STAGES), min_size=1, max_size=8, unique=True)
    )
    return tuple(draw(st.permutations(stages)))


@st.composite
def _scenarios(draw: st.DrawFn) -> dict[str, object]:
    stages = draw(_stage_orderings())

    # Replacements that exist on disk (any subset of the referenced ones).
    candidate_replacements = sorted({s.replacement for s in stages})
    existing_replacements = set(
        draw(st.lists(st.sampled_from(candidate_replacements), unique=True))
        if candidate_replacements
        else []
    )

    existing: set[str] = set(DEFAULT_SHARED_BUILD_CONFIG) | existing_replacements

    exit_codes = {
        build_id: draw(st.integers(min_value=0, max_value=130))
        for build_id in _BUILD_IDS
    }

    return {
        "stages": stages,
        "existing": existing,
        "exit_codes": exit_codes,
        "can_create": draw(st.booleans()),
        "can_commit": draw(st.booleans()),
    }


# ---------------------------------------------------------------------------
# Property 49
# ---------------------------------------------------------------------------


@settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
@given(scenario=_scenarios())
def test_committed_branch_precedes_every_removal(scenario: dict[str, object]) -> None:
    """Property 49: no legacy removal occurs before a committed branch exists.

    **Validates: Requirements 13.2**
    """
    log: list[tuple[str, str]] = []

    vcs = RecordingVCS(
        log,
        can_create=bool(scenario["can_create"]),
        can_commit=bool(scenario["can_commit"]),
    )
    controller = MigrationController(
        vcs=vcs,
        build_runner=RecordingBuildRunner(scenario["exit_codes"]),  # type: ignore[arg-type]
        filesystem=RecordingFileSystem(log, set(scenario["existing"])),  # type: ignore[arg-type]
        stages=scenario["stages"],  # type: ignore[arg-type]
    )

    result = controller.run()

    # Temporal invariant: at every removal, a create AND a commit precede it.
    for index, (kind, _payload) in enumerate(log):
        if kind != REMOVE:
            continue
        prior_kinds = {entry_kind for entry_kind, _ in log[:index]}
        assert CREATE in prior_kinds, (
            "legacy removal occurred before the preservation branch was created"
        )
        assert COMMIT in prior_kinds, (
            "legacy removal occurred before the preservation branch was committed"
        )

    # Corollary: if no committed branch exists, nothing was ever removed.
    if not result.preservation_branch_ready:
        assert not any(kind == REMOVE for kind, _ in log)
        assert result.removed_directories == []


@settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
@given(scenario=_scenarios())
def test_any_removal_implies_branch_committed_in_result(
    scenario: dict[str, object],
) -> None:
    """If any directory was removed, the result reports a committed branch.

    **Validates: Requirements 13.2**
    """
    log: list[tuple[str, str]] = []
    controller = MigrationController(
        vcs=RecordingVCS(
            log,
            can_create=bool(scenario["can_create"]),
            can_commit=bool(scenario["can_commit"]),
        ),
        build_runner=RecordingBuildRunner(scenario["exit_codes"]),  # type: ignore[arg-type]
        filesystem=RecordingFileSystem(log, set(scenario["existing"])),  # type: ignore[arg-type]
        stages=scenario["stages"],  # type: ignore[arg-type]
    )

    result = controller.run()

    if result.removed_directories:
        assert result.branch_created is True
        assert result.branch_committed is True
        assert result.preservation_branch_ready is True
