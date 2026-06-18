"""End-to-end tests for the single guard CLI entrypoint (task 1.1).

These wire the real :class:`zocai_migration.GitVersionControl` against a
throwaway git repo and the on-disk filesystem, exercising the ``verify-branch``
and ``delete`` commands the 9.x deletion tasks call. The CLI must exit non-zero
unless the committed ``legacy-preservation`` branch exists, and must refuse to
delete a legacy directory until its named replacement is present and importable.

If ``git`` is unavailable the module is skipped.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from zocai_migration import git_available
from zocai_migration.cli import main

pytestmark = pytest.mark.skipif(
    not git_available(), reason="git executable not available on PATH"
)


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], capture_output=True, check=True)


def _init_repo(repo: Path) -> None:
    repo.mkdir(parents=True, exist_ok=True)
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "migration@example.test")
    _git(repo, "config", "user.name", "Migration Bot")
    _git(repo, "config", "commit.gpgsign", "false")


def _seed_commit(repo: Path) -> None:
    (repo / "README.md").write_text("seed\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "seed")


# ---------------------------------------------------------------------------
# verify-branch
# ---------------------------------------------------------------------------


def test_verify_branch_exits_nonzero_without_preservation_branch(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    _init_repo(repo)
    _seed_commit(repo)

    code = main(["--repo", str(repo), "verify-branch"])
    assert code != 0


def test_verify_branch_exits_zero_with_committed_branch(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    _init_repo(repo)
    _seed_commit(repo)
    _git(repo, "branch", "legacy-preservation")

    code = main(["--repo", str(repo), "verify-branch"])
    assert code == 0


# ---------------------------------------------------------------------------
# delete
# ---------------------------------------------------------------------------


def test_delete_refuses_without_preservation_branch(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    _init_repo(repo)
    _seed_commit(repo)
    legacy = repo / "legacy"
    legacy.mkdir()
    (legacy / "old.txt").write_text("x\n", encoding="utf-8")

    code = main(
        [
            "--repo",
            str(repo),
            "delete",
            "--legacy",
            "legacy",
            "--replacement-module",
            "zocai_migration",
        ]
    )
    assert code == 3  # PRESERVATION_BRANCH_MISSING
    assert legacy.exists()  # nothing deleted


def test_delete_refuses_when_replacement_not_importable(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    _init_repo(repo)
    _seed_commit(repo)
    _git(repo, "branch", "legacy-preservation")
    legacy = repo / "legacy"
    legacy.mkdir()

    code = main(
        [
            "--repo",
            str(repo),
            "delete",
            "--legacy",
            "legacy",
            "--replacement-module",
            "definitely_not_a_real_module_xyz",
        ]
    )
    assert code == 4  # REPLACEMENT_NOT_READY
    assert legacy.exists()


def test_delete_removes_legacy_when_both_gates_pass(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    _init_repo(repo)
    _seed_commit(repo)
    _git(repo, "branch", "legacy-preservation")
    legacy = repo / "legacy"
    legacy.mkdir()
    (legacy / "old.txt").write_text("x\n", encoding="utf-8")
    replacement = repo / "replacement"
    replacement.mkdir()

    code = main(
        [
            "--repo",
            str(repo),
            "delete",
            "--legacy",
            "legacy",
            # zocai_migration is importable in this venv; the path also exists.
            "--replacement-module",
            "zocai_migration",
            "--replacement-path",
            "replacement",
        ]
    )
    assert code == 0
    assert not legacy.exists()  # removed
    assert replacement.exists()  # replacement retained


def test_delete_rejects_spec_without_replacement_reference(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    _init_repo(repo)
    _seed_commit(repo)
    _git(repo, "branch", "legacy-preservation")

    code = main(["--repo", str(repo), "delete", "--legacy", "legacy"])
    assert code == 2  # invalid request
