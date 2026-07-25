"""Tests for the ``--lazy-index`` startup flag (§9.1)."""

from __future__ import annotations

from pathlib import Path

from zocai_gateway.app import create_app
from zocai_gateway.run_pipeline import default_workspace_rag_matcher
from zocai_gateway.scripts.launch import LAZY_INDEX_FLAG, resolve_lazy_index


def test_flag_absent_defaults_to_eager() -> None:
    assert resolve_lazy_index([], {}) is False


def test_flag_enables_lazy_index() -> None:
    assert resolve_lazy_index([LAZY_INDEX_FLAG], {}) is True


def test_env_var_enables_lazy_index() -> None:
    for value in ("1", "true", "TRUE", "yes", "on"):
        assert resolve_lazy_index([], {"ZOC_STUDIO_LAZY_INDEX": value}) is True


def test_env_var_falsey_values_stay_eager() -> None:
    for value in ("", "0", "false", "no", "maybe"):
        assert resolve_lazy_index([], {"ZOC_STUDIO_LAZY_INDEX": value}) is False


def test_create_app_propagates_lazy_index_to_the_workspace_indexer(
    tmp_path: Path,
) -> None:
    eager = create_app(workspace_root=tmp_path, drive=False)
    lazy = create_app(workspace_root=tmp_path, drive=False, lazy_index=True)

    assert eager.state.workspace_indexer.lazy is False
    assert lazy.state.workspace_indexer.lazy is True


def test_default_matcher_factory_honours_lazy(tmp_path: Path) -> None:
    assert default_workspace_rag_matcher(tmp_path).shard_index is None
    assert default_workspace_rag_matcher(tmp_path, lazy=True).shard_index is not None
