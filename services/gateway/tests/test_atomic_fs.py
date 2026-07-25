from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from zocai_gateway.atomic_fs import (
    AtomicFileTransaction,
    CheckpointError,
    TransactionError,
    git_checkpoint,
)


def test_commit_applies_multiple_writes_delete_and_nested_parent(tmp_path: Path) -> None:
    (tmp_path / "old.txt").write_text("old", encoding="utf-8")
    (tmp_path / "gone.txt").write_text("gone", encoding="utf-8")
    transaction = AtomicFileTransaction()
    transaction.add_write(tmp_path / "old.txt", b"new")
    transaction.add_write(tmp_path / "new/deep/file.txt", b"nested")
    transaction.add_delete(tmp_path / "gone.txt")
    transaction.add_delete(tmp_path / "missing.txt")

    result = transaction.commit()

    assert result.written == 2
    assert result.deleted == 1
    assert (tmp_path / "old.txt").read_text(encoding="utf-8") == "new"
    assert (tmp_path / "new/deep/file.txt").read_text(encoding="utf-8") == "nested"
    assert not (tmp_path / "gone.txt").exists()


def test_stage_failure_leaves_files_and_directories_unchanged(tmp_path: Path) -> None:
    (tmp_path / "keep.txt").write_text("original", encoding="utf-8")
    (tmp_path / "blocker").write_text("file", encoding="utf-8")
    transaction = AtomicFileTransaction()
    transaction.add_write(tmp_path / "keep.txt", b"modified")
    transaction.add_write(tmp_path / "blocker/child.txt", b"never")

    with pytest.raises(TransactionError) as raised:
        transaction.commit()

    assert raised.value.path == tmp_path / "blocker/child.txt"
    assert (tmp_path / "keep.txt").read_text(encoding="utf-8") == "original"
    assert (tmp_path / "blocker").read_text(encoding="utf-8") == "file"
    assert not list(tmp_path.glob(".*.zoc_tmp_*"))


def test_delete_failure_rolls_back_renames_and_created_directories(tmp_path: Path) -> None:
    (tmp_path / "keep.txt").write_text("original", encoding="utf-8")
    transaction = AtomicFileTransaction()
    transaction.add_write(tmp_path / "keep.txt", b"modified")
    transaction.add_write(tmp_path / "new/deep/child.txt", b"created")
    transaction.add_delete(tmp_path / "new")  # unlink(directory) fails after renames

    with pytest.raises(TransactionError) as raised:
        transaction.commit()

    assert raised.value.path == tmp_path / "new"
    assert raised.value.rollback_errors == ()
    assert (tmp_path / "keep.txt").read_text(encoding="utf-8") == "original"
    assert not (tmp_path / "new").exists()
    assert not list(tmp_path.rglob("*.zoc_tmp_*"))


def _git(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=root,
        check=False,
        capture_output=True,
        text=True,
    )


def test_git_checkpoint_commits_dirty_tree_and_skips_clean_tree(tmp_path: Path) -> None:
    assert _git(tmp_path, "init").returncode == 0
    assert _git(tmp_path, "config", "user.email", "test@example.com").returncode == 0
    assert _git(tmp_path, "config", "user.name", "Test").returncode == 0
    assert _git(tmp_path, "config", "commit.gpgsign", "false").returncode == 0
    (tmp_path / "changed.txt").write_text("changed\n", encoding="utf-8")

    checkpoint = git_checkpoint(tmp_path, "zoc: pre-run checkpoint")

    assert checkpoint
    assert _git(tmp_path, "log", "-1", "--pretty=%s").stdout.strip() == ("zoc: pre-run checkpoint")
    assert _git(tmp_path, "status", "--porcelain").stdout.strip() == ""
    assert git_checkpoint(tmp_path, "zoc: pre-run checkpoint") is None


def test_git_checkpoint_skips_non_repository(tmp_path: Path) -> None:
    assert git_checkpoint(tmp_path, "zoc: pre-run checkpoint") is None


def test_git_checkpoint_surfaces_failure_after_repository_detection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = 0

    def fake_git(_root: Path, *args: str) -> str:
        nonlocal calls
        calls += 1
        if args[:2] == ("rev-parse", "--is-inside-work-tree"):
            return "true\n"
        if args[:2] == ("status", "--porcelain"):
            return " M changed.txt\n"
        raise CheckpointError("git failed: commit blocked")

    monkeypatch.setattr("zocai_gateway.atomic_fs._git", fake_git)

    with pytest.raises(CheckpointError, match="commit blocked"):
        git_checkpoint(tmp_path, "zoc: pre-run checkpoint")
    assert calls == 3
