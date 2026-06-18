"""Property test for shared build configuration retention (task 1.6).

Feature: zocai-ecosystem-rebuild, Property 52: Migration retains shared build
configuration.

**Validates: Requirements 13.5**

Property 52 (design): *For any* set of legacy removals, the workspace build
configuration files required by remaining and new components are retained.

The controller (``zocai_migration.controller.MigrationController``) enforces
this by re-checking, after every legacy directory removal, that none of the
shared build config files were taken with it; a removal that clobbers a shared
config halts the run with ``HaltReason.SHARED_CONFIG_LOST`` (R13.5).

This module drives the controller with Hypothesis-generated workspaces over the
``FakeFileSystem`` port and asserts:

1. On a fully green run, every shared build config file is still present after
   *each* legacy removal and on the completed migration, and the controller
   reports the full retained config set.
2. A removal that clobbers any shared config file halts with
   ``HaltReason.SHARED_CONFIG_LOST`` and retains the branch for rollback.
"""

from __future__ import annotations

from collections.abc import Iterable

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from zocai_migration import (
    DEFAULT_SHARED_BUILD_CONFIG,
    FailureIndication,
    HaltReason,
    MigrationController,
    MigrationStage,
)

# ---------------------------------------------------------------------------
# Fakes (mirrors the FakeFileSystem in test_controller.py; kept local so this
# property module is self-contained)
# ---------------------------------------------------------------------------


class FakeVCS:
    """Always-succeeding VCS port: a committed branch always exists."""

    def create_branch(self, name: str) -> bool:
        return True

    def commit_branch(self, name: str, message: str) -> bool:
        return True


class FakeBuildRunner:
    """Build port; every build returns exit code 0 (green)."""

    def run_build(self, build_id: str) -> int:
        return 0


class RecordingFileSystem:
    """In-memory filesystem that snapshots config presence after each removal.

    ``config_files`` is the set of shared build config paths whose presence is
    tracked. After every ``remove_directory`` call the still-present subset of
    those config files is appended to ``config_after_each_removal`` so the
    property can assert retention at *every* removal step (not just the end).
    """

    def __init__(self, existing: Iterable[str], config_files: Iterable[str]) -> None:
        self._paths: set[str] = set(existing)
        self._config_files: tuple[str, ...] = tuple(config_files)
        self.removed: list[str] = []
        self.config_after_each_removal: list[set[str]] = []

    def exists(self, path: str) -> bool:
        return path in self._paths

    def remove_directory(self, path: str) -> None:
        self.removed.append(path)
        self._paths.discard(path)
        self.config_after_each_removal.append(
            {c for c in self._config_files if c in self._paths}
        )


class ClobberingFileSystem(RecordingFileSystem):
    """Filesystem whose removal at ``victim_stage`` also wipes ``victim_config``.

    Models a removal that accidentally takes a shared build config file with it,
    so the controller must detect the loss and halt.
    """

    def __init__(
        self,
        existing: Iterable[str],
        config_files: Iterable[str],
        *,
        victim_stage: str,
        victim_config: str,
    ) -> None:
        super().__init__(existing, config_files)
        self._victim_stage = victim_stage
        self._victim_config = victim_config

    def remove_directory(self, path: str) -> None:
        super().remove_directory(path)
        if path == self._victim_stage:
            self._paths.discard(self._victim_config)


# ---------------------------------------------------------------------------
# Generators -- intelligently constrained to the migration input space
# ---------------------------------------------------------------------------

_BUILD_IDS = ("ts", "rust", "python")

# Distinct path-like tokens used to build legacy dirs, replacements, and config
# names without collisions.
_NAMES = st.text(
    alphabet="abcdefghijklmnopqrstuvwxyz0123456789",
    min_size=1,
    max_size=8,
)


@st.composite
def _scenarios(draw: st.DrawFn) -> tuple[tuple[MigrationStage, ...], tuple[str, ...]]:
    """Generate a stage list and a shared-config set with disjoint paths."""
    # Unique slugs partitioned into legacy dirs, replacements, and config files.
    n_stages = draw(st.integers(min_value=1, max_value=6))
    slugs = draw(
        st.lists(_NAMES, min_size=2 * n_stages + 1, max_size=40, unique=True)
    )

    legacy_slugs = slugs[:n_stages]
    replacement_slugs = slugs[n_stages : 2 * n_stages]
    config_slugs = slugs[2 * n_stages :]

    stages = tuple(
        MigrationStage(
            legacy_dir=f"legacy/{legacy_slugs[i]}",
            replacement=f"new/{replacement_slugs[i]}",
            build_id=draw(st.sampled_from(_BUILD_IDS)),
            build_label=f"build {i}",
        )
        for i in range(n_stages)
    )

    # At least one config file so retention is meaningful; sometimes reuse the
    # real default set to exercise production config names too.
    use_defaults = draw(st.booleans())
    if use_defaults or not config_slugs:
        config = DEFAULT_SHARED_BUILD_CONFIG
    else:
        config = tuple(f"config/{s}.toml" for s in config_slugs)

    return stages, config


def _full_workspace_paths(
    stages: tuple[MigrationStage, ...], config: tuple[str, ...]
) -> set[str]:
    paths: set[str] = set(config)
    for stage in stages:
        paths.add(stage.replacement)
        paths.add(stage.legacy_dir)
    return paths


_SETTINGS = settings(
    max_examples=150,
    suppress_health_check=[HealthCheck.too_slow],
)


# ---------------------------------------------------------------------------
# Property 52
# ---------------------------------------------------------------------------


@_SETTINGS
@given(scenario=_scenarios())
def test_green_migration_retains_all_shared_config_after_every_removal(
    scenario: tuple[tuple[MigrationStage, ...], tuple[str, ...]],
) -> None:
    """Property 52: every shared config file is retained after each removal.

    For any green set of legacy removals, all shared build config files remain
    present after each removal and on the completed migration, and the
    controller reports the full retained config set.
    """
    stages, config = scenario
    fs = RecordingFileSystem(_full_workspace_paths(stages, config), config)

    result = MigrationController(
        vcs=FakeVCS(),
        build_runner=FakeBuildRunner(),
        filesystem=fs,
        stages=stages,
        shared_build_config=config,
    ).run()

    # The migration completed and removed every legacy directory.
    assert result.completed is True
    assert result.failure is None
    assert result.removed_directories == [s.legacy_dir for s in stages]

    # Retention holds after EVERY individual removal.
    assert fs.config_after_each_removal, "expected at least one removal"
    for present in fs.config_after_each_removal:
        assert present == set(config)

    # Retention holds on the completed migration.
    for config_path in config:
        assert fs.exists(config_path)
    assert result.retained_build_config == list(config)


@_SETTINGS
@given(scenario=_scenarios(), data=st.data())
def test_clobbering_a_shared_config_halts_with_shared_config_lost(
    scenario: tuple[tuple[MigrationStage, ...], tuple[str, ...]],
    data: st.DataObject,
) -> None:
    """Property 52 (negative): a removal that clobbers a shared config halts.

    If any legacy removal wipes a shared build config file, the migration must
    halt with ``HaltReason.SHARED_CONFIG_LOST`` and retain the branch for
    rollback rather than silently continuing without the config.
    """
    stages, config = scenario
    victim_stage = data.draw(st.sampled_from(stages)).legacy_dir
    victim_config = data.draw(st.sampled_from(config))

    emitted: list[FailureIndication] = []
    fs = ClobberingFileSystem(
        _full_workspace_paths(stages, config),
        config,
        victim_stage=victim_stage,
        victim_config=victim_config,
    )

    result = MigrationController(
        vcs=FakeVCS(),
        build_runner=FakeBuildRunner(),
        filesystem=fs,
        stages=stages,
        shared_build_config=config,
        emit=emitted.append,
    ).run()

    assert result.completed is False
    assert result.failure is not None
    assert result.failure.reason is HaltReason.SHARED_CONFIG_LOST
    assert result.branch_retained_for_rollback is True
    # The lost config is named in the failure message and the halt is emitted.
    assert victim_config in result.failure.message
    assert emitted == [result.failure]
    # The clobbering removal is the last one performed (run halts immediately).
    assert fs.removed[-1] == victim_stage
