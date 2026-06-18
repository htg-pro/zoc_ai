"""Unit tests for the ``RAG_Matcher`` (task 8.1, R8.1 + R1.7 + R1.8).

Example-based coverage of the three behaviors the task calls out: the relevance
threshold (>= 0.7) and the 50-fragment cap on the scan, and tier-aware
injection (active-target-only for Local SLM; multi-file source/dependency maps
plus steering for Cloud). The exhaustive property tests live in tasks 8.6
(Property 7) and 8.7 (Property 33).
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

import pytest

from zocai_gateway.context.rag_matcher import (
    MAX_FRAGMENTS,
    RELEVANCE_THRESHOLD,
    FragmentSource,
    OpenBuffer,
    RagFragment,
    RagMatcher,
    WorkspaceRagMatcher,
    default_scorer,
)
from zocai_gateway.model_interface import ModelTier


def _frag(path: str, score: float, content: str = "x") -> RagFragment:
    return RagFragment(
        path=path, content=content, score=score, source=FragmentSource.BUFFER
    )


# -- scoring ---------------------------------------------------------------


def test_default_scorer_is_unit_ranged() -> None:
    assert default_scorer("auth login user", "auth login user token") == 1.0
    assert default_scorer("", "anything") == 0.0
    assert default_scorer("auth", "") == 0.0
    assert default_scorer("auth login", "login here") == pytest.approx(0.5)


# -- scan threshold and cap (R8.1) -----------------------------------------


def test_scan_returns_only_fragments_at_or_above_threshold() -> None:
    matcher = WorkspaceRagMatcher()
    buffers = [
        OpenBuffer(path="hit.py", content="parse token auth session login"),
        OpenBuffer(path="miss.py", content="completely unrelated prose here"),
    ]
    results = matcher.scan("token auth session", open_buffers=buffers)

    assert [f.path for f in results] == ["hit.py"]
    assert all(f.score >= RELEVANCE_THRESHOLD for f in results)


def test_scan_orders_by_descending_score() -> None:
    matcher = WorkspaceRagMatcher()
    buffers = [
        # 3/4 query tokens -> 0.75 (clears the 0.7 threshold).
        OpenBuffer(path="partial.py", content="alpha beta gamma"),
        # 4/4 query tokens -> 1.0.
        OpenBuffer(path="full.py", content="alpha beta gamma delta"),
    ]
    results = matcher.scan("alpha beta gamma delta", open_buffers=buffers)

    assert [f.path for f in results] == ["full.py", "partial.py"]
    assert results[0].score > results[1].score


def test_scan_caps_at_max_fragments() -> None:
    matcher = WorkspaceRagMatcher()
    # Every buffer fully matches the query, so all clear the threshold; the cap
    # must still bound the output at 50.
    buffers = [
        OpenBuffer(path=f"f{i:03d}.py", content="match")
        for i in range(MAX_FRAGMENTS + 25)
    ]
    results = matcher.scan("match", open_buffers=buffers)

    assert len(results) == MAX_FRAGMENTS


def test_scan_uses_injected_rust_hook() -> None:
    seen: list[tuple[str, str]] = []

    def fake_rust_hook(
        query: str, candidates: Sequence[tuple[str, str]]
    ) -> list[float]:
        seen.extend(candidates)
        # Score every candidate just above threshold regardless of content.
        return [0.9 for _ in candidates]

    matcher = WorkspaceRagMatcher(scan_hook=fake_rust_hook)
    buffers = [OpenBuffer(path="a.py", content="irrelevant text")]
    results = matcher.scan("does-not-matter", open_buffers=buffers)

    assert seen == [("a.py", "irrelevant text")]
    assert [f.path for f in results] == ["a.py"]
    assert results[0].score == pytest.approx(0.9)


def test_scan_hook_wrong_length_raises() -> None:
    def short_hook(
        query: str, candidates: Sequence[tuple[str, str]]
    ) -> list[float]:
        return [0.9]

    matcher = WorkspaceRagMatcher(scan_hook=short_hook)
    buffers = [
        OpenBuffer(path="a.py", content="a"),
        OpenBuffer(path="b.py", content="b"),
    ]
    with pytest.raises(ValueError):
        matcher.scan("q", open_buffers=buffers)


def test_scan_reads_folder_files(tmp_path: Path) -> None:
    (tmp_path / "match.py").write_text("auth token session", encoding="utf-8")
    (tmp_path / "nope.py").write_text("unrelated words only", encoding="utf-8")

    matcher = WorkspaceRagMatcher()
    results = matcher.scan("auth token session", folders=[tmp_path])

    assert [f.path for f in results] == [str(tmp_path / "match.py")]
    assert results[0].source is FragmentSource.FOLDER


def test_scan_skips_unreadable_files(tmp_path: Path) -> None:
    (tmp_path / "good.py").write_text("auth token", encoding="utf-8")
    (tmp_path / "binary.py").write_bytes(b"\xff\xfe\x00auth token")

    matcher = WorkspaceRagMatcher()
    results = matcher.scan("auth token", folders=[tmp_path])

    assert [f.path for f in results] == [str(tmp_path / "good.py")]


def test_open_buffer_shadows_on_disk_file(tmp_path: Path) -> None:
    target = tmp_path / "live.py"
    target.write_text("stale unrelated content", encoding="utf-8")
    matcher = WorkspaceRagMatcher()

    results = matcher.scan(
        "auth token session",
        folders=[tmp_path],
        open_buffers=[OpenBuffer(path=str(target), content="auth token session")],
    )

    assert [f.path for f in results] == [str(target)]
    assert results[0].source is FragmentSource.BUFFER


def test_extract_uses_configured_folders_and_buffers() -> None:
    matcher = WorkspaceRagMatcher(
        open_buffers=[OpenBuffer(path="a.py", content="auth token session")]
    )
    results = matcher.extract("auth token session")
    assert [f.path for f in results] == ["a.py"]


def test_workspace_matcher_satisfies_protocol() -> None:
    matcher: RagMatcher = WorkspaceRagMatcher()
    assert isinstance(matcher, RagMatcher)


# -- tier-aware injection (R1.7 / R1.8) ------------------------------------


def test_local_slm_injects_only_active_target_fragments() -> None:
    matcher = WorkspaceRagMatcher()
    fragments = [
        _frag("active.py", 0.9),
        _frag("other.py", 0.95),
        _frag("active.py", 0.8),
    ]
    injected = matcher.inject(
        ModelTier.LOCAL_SLM, fragments, active_target="active.py"
    )

    assert injected.tier is ModelTier.LOCAL_SLM
    assert {f.path for f in injected.fragments} == {"active.py"}
    assert injected.source_maps == {}
    assert injected.dependency_maps == {}
    assert injected.steering == ""


def test_local_slm_without_active_target_injects_nothing() -> None:
    matcher = WorkspaceRagMatcher()
    injected = matcher.inject(ModelTier.LOCAL_SLM, [_frag("a.py", 0.9)])
    assert injected.fragments == ()


def test_cloud_injects_source_maps_dependency_maps_and_steering() -> None:
    matcher = WorkspaceRagMatcher()
    fragments = [
        RagFragment(
            path="app.py",
            content="from auth import login\nimport os\nprint('hi')",
            score=0.9,
            source=FragmentSource.FOLDER,
        ),
        RagFragment(
            path="ui.ts",
            content="import { Button } from './button'\nconst x = require('lodash')",
            score=0.85,
            source=FragmentSource.FOLDER,
        ),
    ]
    injected = matcher.inject(
        ModelTier.CLOUD, fragments, steering="# steering rules"
    )

    assert injected.tier is ModelTier.CLOUD
    assert set(injected.source_maps) == {"app.py", "ui.ts"}
    assert "from auth import login" in injected.source_maps["app.py"]
    assert injected.dependency_maps["app.py"] == ("auth", "os")
    assert injected.dependency_maps["ui.ts"] == ("./button", "lodash")
    assert injected.steering == "# steering rules"


def test_edge_injects_matched_fragments_unchanged() -> None:
    matcher = WorkspaceRagMatcher()
    fragments = [_frag("a.py", 0.9), _frag("b.py", 0.8)]
    injected = matcher.inject(ModelTier.EDGE, fragments)

    assert {f.path for f in injected.fragments} == {"a.py", "b.py"}
    assert injected.source_maps == {}
    assert injected.steering == ""


def test_enrich_scans_then_injects_for_local_slm() -> None:
    matcher = WorkspaceRagMatcher()
    injected = matcher.enrich(
        "auth token session",
        ModelTier.LOCAL_SLM,
        open_buffers=[
            OpenBuffer(path="active.py", content="auth token session handler"),
            OpenBuffer(path="other.py", content="auth token session helper"),
        ],
        active_target="active.py",
    )

    assert {f.path for f in injected.fragments} == {"active.py"}


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-v"]))
