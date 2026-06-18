"""Integration test for the preservation-branch VCS process (task 1.8).

Feature: zocai-ecosystem-rebuild.

**Validates: Requirements 13.2, 13.3**

Unlike the property/unit suites, which drive the controller through in-memory
fakes, this test wires the **real** git-backed
:class:`zocai_migration.GitVersionControl` adapter against a throwaway git
repository created with ``git init`` in a ``tempfile`` directory, plus a real
on-disk filesystem adapter. It proves the end-to-end discipline that matters
most for the legacy cutover:

* R13.2 -- the legacy preservation branch is actually created **and committed**
  in git *before* any legacy directory is removed from disk.
* R13.3 -- if the preservation branch cannot be created, the migration halts
  and deletes no legacy source.

If ``git`` is not installed the whole module is skipped gracefully so the suite
remains runnable in minimal environments.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from zocai_migration import (
    GitVersionControl,
    MigrationController,
    MigrationStage,
    git_available,
)

pytestmark = pytest.mark.skipif(
    not git_available(), reason="git executable not available on PATH"
)


# ---------------------------------------------------------------------------
# Real on-disk filesystem adapter (records removal ordering)
# ---------------------------------------------------------------------------

CREATE = "create_branch"
COMMIT = "commit_branch"
REMOVE = "remove"


class RealFileSystem:
    """Filesystem port operating on a real workspace root.

    Removals are recorded into a shared, ordered event log so the test can
    assert the temporal relationship between git operations and deletions.
    """

    def __init__(self, root: Path, log: list[tuple[str, str]]) -> None:
        self._root = root
        self._log = log

    def exists(self, path: str) -> bool:
        return (self._root / path).exists()

    def remove_directory(self, path: str) -> None:
        self._log.append((REMOVE, path))
        shutil.rmtree(self._root / path)


class RecordingGitVersionControl(GitVersionControl):
    """Real git adapter that also records create/commit ordering events."""

    def __init__(
        self, repo_dir: Path, log: list[tuple[str, str]], **kwargs: object
    ) -> None:
        super().__init__(repo_dir, **kwargs)  # type: ignore[arg-type]
        self._log = log

    def create_branch(self, name: str) -> bool:
        ok = super().create_branch(name)
        if ok:
            self._log.append((CREATE, name))
        return ok

    def commit_branch(self, name: str, message: str) -> bool:
        ok = super().commit_branch(name, message)
        if ok:
            self._log.append((COMMIT, name))
        return ok


class GreenBuildRunner:
    """Build port whose builds always succeed (exit code 0)."""

    def run_build(self, build_id: str) -> int:
        return 0


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        check=True,
    )


def _init_repo(repo: Path) -> None:
    """Initialise a git repo with deterministic, non-interactive config."""
    repo.mkdir(parents=True, exist_ok=True)
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "migration@example.test")
    _git(repo, "config", "user.name", "Migration Bot")
    _git(repo, "config", "commit.gpgsign", "false")


def _seed_workspace(repo: Path) -> tuple[tuple[MigrationStage, ...], tuple[str, ...]]:
    """Create legacy dirs, replacements, and shared config, then commit them."""
    shared_config = ("package.json", "pyproject.toml")
    stages = (
        MigrationStage(
            legacy_dir="legacy_a",
            replacement="new_a",
            build_id="ts",
            build_label="TS build (new_a)",
        ),
        MigrationStage(
            legacy_dir="legacy_b",
            replacement="new_b",
            build_id="py",
            build_label="Python build (new_b)",
        ),
    )

    for stage in stages:
        legacy = repo / stage.legacy_dir
        legacy.mkdir(parents=True, exist_ok=True)
        (legacy / "old.txt").write_text("legacy implementation\n", encoding="utf-8")

        replacement = repo / stage.replacement
        replacement.mkdir(parents=True, exist_ok=True)
        (replacement / "new.txt").write_text("rebuilt component\n", encoding="utf-8")

    for config in shared_config:
        (repo / config).write_text("{}\n", encoding="utf-8")

    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "Seed legacy workspace")
    return stages, shared_config


# ---------------------------------------------------------------------------
# R13.2 -- branch created AND committed before any deletion
# ---------------------------------------------------------------------------


def test_preservation_branch_committed_before_any_deletion(tmp_path: Path) -> None:
    """Branch is created and committed in real git before legacy dirs are removed.

    **Validates: Requirements 13.2**
    """
    repo = tmp_path / "workspace"
    _init_repo(repo)
    stages, shared_config = _seed_workspace(repo)

    log: list[tuple[str, str]] = []
    vcs = RecordingGitVersionControl(repo, log)
    controller = MigrationController(
        vcs=vcs,
        build_runner=GreenBuildRunner(),
        filesystem=RealFileSystem(repo, log),
        stages=stages,
        branch_name="legacy-preservation",
        shared_build_config=shared_config,
    )

    result = controller.run()

    # The migration completed and removed every legacy directory.
    assert result.completed is True, result.failure
    assert result.preservation_branch_ready is True
    assert result.removed_directories == [s.legacy_dir for s in stages]

    # The preservation branch genuinely exists and has a commit in git.
    assert vcs.branch_exists("legacy-preservation") is True
    assert vcs.branch_has_commit("legacy-preservation") is True

    # Temporal invariant against the REAL git operations: at every removal a
    # create AND a commit appear strictly earlier in the shared event log.
    remove_indices = [i for i, (kind, _) in enumerate(log) if kind == REMOVE]
    assert remove_indices, "expected at least one removal to have occurred"
    for index in remove_indices:
        prior = {kind for kind, _ in log[:index]}
        assert CREATE in prior, "deletion happened before branch creation"
        assert COMMIT in prior, "deletion happened before branch commit"

    # Legacy directories are gone from disk; replacements and shared config stay.
    for stage in stages:
        assert not (repo / stage.legacy_dir).exists()
        assert (repo / stage.replacement).exists()
    for config in shared_config:
        assert (repo / config).exists()


def test_legacy_source_preserved_on_branch_after_deletion(tmp_path: Path) -> None:
    """The committed branch still contains the legacy source after deletion.

    This is the whole point of preservation: rollback must be possible. We
    confirm the deleted legacy file is recoverable from the preservation branch.

    **Validates: Requirements 13.2**
    """
    repo = tmp_path / "workspace"
    _init_repo(repo)
    stages, shared_config = _seed_workspace(repo)

    controller = MigrationController(
        vcs=GitVersionControl(repo),
        build_runner=GreenBuildRunner(),
        filesystem=RealFileSystem(repo, []),
        stages=stages,
        branch_name="legacy-preservation",
        shared_build_config=shared_config,
    )
    result = controller.run()
    assert result.completed is True, result.failure

    # The legacy file is gone from the working tree...
    assert not (repo / "legacy_a" / "old.txt").exists()
    # ...but recoverable from the committed preservation branch.
    show = subprocess.run(
        ["git", "-C", str(repo), "show", "legacy-preservation:legacy_a/old.txt"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert "legacy implementation" in show.stdout


# ---------------------------------------------------------------------------
# R13.3 -- branch cannot be created => halt, delete nothing
# ---------------------------------------------------------------------------


def test_branch_create_failure_deletes_no_legacy_source(tmp_path: Path) -> None:
    """If the preservation branch cannot be created, no legacy dir is removed.

    The branch name already exists in the repo, so ``git checkout -b`` fails;
    the controller must halt and leave every legacy directory intact.

    **Validates: Requirements 13.3**
    """
    repo = tmp_path / "workspace"
    _init_repo(repo)
    stages, shared_config = _seed_workspace(repo)

    # Pre-create the branch so a second create attempt fails in real git.
    _git(repo, "branch", "legacy-preservation")

    log: list[tuple[str, str]] = []
    controller = MigrationController(
        vcs=GitVersionControl(repo),
        build_runner=GreenBuildRunner(),
        filesystem=RealFileSystem(repo, log),
        stages=stages,
        branch_name="legacy-preservation",
        shared_build_config=shared_config,
    )

    result = controller.run()

    assert result.completed is False
    assert result.branch_created is False
    assert result.removed_directories == []
    assert not any(kind == REMOVE for kind, _ in log)
    # Every legacy directory survives untouched on disk.
    for stage in stages:
        assert (repo / stage.legacy_dir / "old.txt").exists()
