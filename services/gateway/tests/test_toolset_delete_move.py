"""Unit tests for confined delete/rename on the Agent_Toolset (task 8.2).

_Requirements: 9.5, 9.6, 10.1_
"""

from __future__ import annotations

from pathlib import Path

import pytest
from zocai_gateway.toolsets import FullToolset, ReadOnlyViolation


def test_delete_file_in_workspace_succeeds(tmp_path: Path) -> None:
    toolset = FullToolset(tmp_path)
    (tmp_path / "a.txt").write_text("hello", encoding="utf-8")
    toolset.delete_file("a.txt")
    assert not (tmp_path / "a.txt").exists()


def test_delete_file_out_of_workspace_raises_read_only_violation(tmp_path: Path) -> None:
    toolset = FullToolset(tmp_path)
    with pytest.raises(ReadOnlyViolation):
        toolset.delete_file("../escape.txt")


def test_delete_missing_file_raises_underlying_error(tmp_path: Path) -> None:
    toolset = FullToolset(tmp_path)
    with pytest.raises(FileNotFoundError):
        toolset.delete_file("nope.txt")


def test_move_file_in_workspace_succeeds(tmp_path: Path) -> None:
    toolset = FullToolset(tmp_path)
    (tmp_path / "a.txt").write_text("hello", encoding="utf-8")
    toolset.move_file("a.txt", "sub/b.txt")
    assert not (tmp_path / "a.txt").exists()
    assert (tmp_path / "sub" / "b.txt").read_text(encoding="utf-8") == "hello"


def test_move_out_of_workspace_source_raises(tmp_path: Path) -> None:
    toolset = FullToolset(tmp_path)
    with pytest.raises(ReadOnlyViolation):
        toolset.move_file("../escape.txt", "b.txt")


def test_move_out_of_workspace_destination_raises_and_keeps_source(tmp_path: Path) -> None:
    toolset = FullToolset(tmp_path)
    (tmp_path / "a.txt").write_text("hello", encoding="utf-8")
    with pytest.raises(ReadOnlyViolation):
        toolset.move_file("a.txt", "../escape.txt")
    # The confinement guard rejects before any effect: the source is untouched.
    assert (tmp_path / "a.txt").read_text(encoding="utf-8") == "hello"


def test_move_missing_source_raises_underlying_error(tmp_path: Path) -> None:
    toolset = FullToolset(tmp_path)
    with pytest.raises(FileNotFoundError):
        toolset.move_file("nope.txt", "b.txt")


def test_move_onto_existing_destination_raises_underlying_error(tmp_path: Path) -> None:
    toolset = FullToolset(tmp_path)
    (tmp_path / "a.txt").write_text("source", encoding="utf-8")
    (tmp_path / "b.txt").write_text("target", encoding="utf-8")
    with pytest.raises(FileExistsError):
        toolset.move_file("a.txt", "b.txt")
    # Neither file is clobbered by the rejected move.
    assert (tmp_path / "a.txt").read_text(encoding="utf-8") == "source"
    assert (tmp_path / "b.txt").read_text(encoding="utf-8") == "target"
