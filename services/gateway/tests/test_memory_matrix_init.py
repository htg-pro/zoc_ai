"""Unit tests for ``.zocai/`` initialization (task 9.1, R9.1 + R9.2).

These example-based tests run the matrix against a ``tmp_path`` temp root and
assert that initialization (a) confines every store under ``.zocai/`` (R9.1) and
(b) creates every missing directory and tier sub-store (R9.2). The dedicated
property test for "init creates all missing stores" lives in task 9.6
(Property 38).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from zocai_gateway.memory import MemoryMatrix


def test_initialize_creates_all_directories(tmp_path: Path) -> None:
    matrix = MemoryMatrix(tmp_path)
    matrix.initialize()

    for directory in matrix.directories():
        assert directory.is_dir()


def test_initialize_creates_all_substores(tmp_path: Path) -> None:
    matrix = MemoryMatrix(tmp_path)
    matrix.initialize()

    for store in matrix.files():
        assert store.is_file()


def test_initialize_seeds_json_stores_with_valid_documents(tmp_path: Path) -> None:
    matrix = MemoryMatrix(tmp_path)
    matrix.initialize()

    assert json.loads(matrix.state_wrapper_path.read_text(encoding="utf-8")) == {}
    assert json.loads(matrix.gepa_state_path.read_text(encoding="utf-8")) == {}


def test_initialize_seeds_appendonly_and_markdown_stores_empty(tmp_path: Path) -> None:
    matrix = MemoryMatrix(tmp_path)
    matrix.initialize()

    assert matrix.session_diary_path.read_text(encoding="utf-8") == ""
    assert matrix.skill_path.read_text(encoding="utf-8") == ""


def test_is_initialized_reflects_state(tmp_path: Path) -> None:
    matrix = MemoryMatrix(tmp_path)
    assert matrix.is_initialized() is False
    matrix.initialize()
    assert matrix.is_initialized() is True


def test_initialize_recreates_only_missing_substores(tmp_path: Path) -> None:
    matrix = MemoryMatrix(tmp_path)
    matrix.initialize()

    # Remove a single sub-store and re-init: only the missing one is recreated.
    matrix.gepa_state_path.unlink()
    assert matrix.is_initialized() is False

    matrix.initialize()
    assert matrix.gepa_state_path.is_file()
    assert matrix.is_initialized() is True


def test_initialize_is_idempotent_and_preserves_content(tmp_path: Path) -> None:
    matrix = MemoryMatrix(tmp_path)
    matrix.initialize()

    # Existing history must never be truncated by a re-init (R9.2 creates only
    # what is missing).
    matrix.session_diary_path.write_text('{"seq": 0}\n', encoding="utf-8")
    matrix.state_wrapper_path.write_text('{"stage": "INTAKE"}\n', encoding="utf-8")

    matrix.initialize()

    assert matrix.session_diary_path.read_text(encoding="utf-8") == '{"seq": 0}\n'
    assert json.loads(matrix.state_wrapper_path.read_text(encoding="utf-8")) == {
        "stage": "INTAKE"
    }


def test_initialize_confines_all_data_under_zocai(tmp_path: Path) -> None:
    # R9.1: nothing is created outside the workspace ``.zocai/`` subtree.
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    matrix = MemoryMatrix(workspace)
    matrix.initialize()

    # The only entry created directly under the workspace root is ``.zocai``.
    assert [p.name for p in workspace.iterdir()] == [".zocai"]

    # Every owned path is a descendant of ``.zocai/``.
    for path in (*matrix.directories(), *matrix.files()):
        assert matrix.zocai_dir in path.parents or path == matrix.zocai_dir


def test_workspace_root_is_injectable_and_resolved(tmp_path: Path) -> None:
    matrix = MemoryMatrix(str(tmp_path))
    assert matrix.workspace_root == tmp_path.resolve()
    assert matrix.zocai_dir == tmp_path.resolve() / ".zocai"


@pytest.mark.parametrize("call_count", [2, 3])
def test_repeated_initialize_keeps_matrix_initialized(
    tmp_path: Path, call_count: int
) -> None:
    matrix = MemoryMatrix(tmp_path)
    for _ in range(call_count):
        matrix.initialize()
    assert matrix.is_initialized() is True
