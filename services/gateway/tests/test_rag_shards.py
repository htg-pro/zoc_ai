"""Tests for the 64-shard, lazily-loaded fragment index (§9.1).

The point of sharding is a memory claim: a search that can narrow its candidate
set touches only the shards those candidates hash into, so resident memory is
roughly ``1/SHARD_COUNT`` of the full index. These tests assert that claim
directly by inspecting :meth:`ShardedFragmentIndex.stats` rather than trusting
the code path by inspection.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from zocai_gateway.context.rag_matcher import (
    SHARD_COUNT,
    FragmentSource,
    RagFragment,
    ShardedFragmentIndex,
    WorkspaceRagMatcher,
    shard_for_path,
)


def _fragment(path: str, content: str) -> RagFragment:
    return RagFragment(path=path, content=content, score=0.0)


def _index(paths: dict[str, str], **kwargs: object) -> ShardedFragmentIndex:
    """A shard index whose loader serves ``paths`` from memory."""

    def loader(shard_paths):  # type: ignore[no-untyped-def]
        return [_fragment(p, paths[p]) for p in shard_paths if p in paths]

    index = ShardedFragmentIndex(loader=loader, **kwargs)  # type: ignore[arg-type]
    index.register(paths)
    return index


def test_shard_assignment_is_stable_and_in_range() -> None:
    for path in ("a.py", "src/deep/nested/module.rs", "", "unicode/ünïcødé.txt"):
        first = shard_for_path(path)
        assert first == shard_for_path(path), "assignment must be deterministic"
        assert 0 <= first < SHARD_COUNT


def test_shard_assignment_spreads_paths_across_shards() -> None:
    paths = [f"src/module_{i}.py" for i in range(1000)]
    used = {shard_for_path(p) for p in paths}
    # A degenerate hash would collapse everything into a few buckets; require
    # that a thousand paths reach most of the 64 shards.
    assert len(used) >= SHARD_COUNT - 4


def test_shard_count_must_be_positive() -> None:
    with pytest.raises(ValueError):
        shard_for_path("a.py", 0)
    with pytest.raises(ValueError):

        def _loader(_paths):  # type: ignore[no-untyped-def]
            return []

        ShardedFragmentIndex(loader=_loader, shard_count=0)


def test_register_loads_nothing() -> None:
    index = _index({f"f{i}.py": "content" for i in range(200)})
    stats = index.stats()
    assert stats.registered_paths == 200
    # The whole point of lazy: registration performs zero loads.
    assert stats.resident_shards == 0
    assert stats.shard_loads == 0


def test_search_loads_only_the_candidate_shards() -> None:
    paths = {f"src/module_{i}.py": f"def handler_{i}(): pass" for i in range(500)}
    index = _index(paths)
    target = "src/module_7.py"

    found = index.search("handler_7", candidate_paths=[target], threshold=0.0)

    assert [f.path for f in found] == [target]
    stats = index.stats()
    # Exactly one shard was materialised, not all 64.
    assert stats.resident_shards == 1
    assert stats.shard_loads == 1
    assert index.is_resident(shard_for_path(target))


def test_full_search_without_candidates_loads_every_populated_shard() -> None:
    paths = {f"src/module_{i}.py": "shared token" for i in range(500)}
    index = _index(paths)

    index.search("shared token", candidate_paths=None, threshold=0.0)

    stats = index.stats()
    assert stats.resident_shards == stats.populated_shards
    # Sanity: the unnarrowed path really is the expensive one.
    assert stats.populated_shards > 1


def test_repeat_search_reuses_resident_shard() -> None:
    index = _index({"a.py": "alpha beta"})
    index.search("alpha", candidate_paths=["a.py"], threshold=0.0)
    index.search("beta", candidate_paths=["a.py"], threshold=0.0)
    assert index.stats().shard_loads == 1


def test_residency_cap_evicts_least_recently_used_shard() -> None:
    paths = {f"m{i}.py": "token" for i in range(400)}
    index = _index(paths, max_resident_shards=2)

    for path in paths:
        index.search("token", candidate_paths=[path], threshold=0.0)

    assert index.stats().resident_shards <= 2


def test_search_respects_threshold_and_cap() -> None:
    paths = {f"f{i}.py": "alpha" for i in range(10)}
    index = _index(paths)

    # default_scorer gives full coverage for "alpha", so all pass a 0.7 gate.
    permissive = index.search("alpha", candidate_paths=list(paths), threshold=0.7)
    assert len(permissive) == 10

    capped = index.search(
        "alpha", candidate_paths=list(paths), threshold=0.7, max_fragments=3
    )
    assert len(capped) == 3

    strict = index.search("zulu", candidate_paths=list(paths), threshold=0.7)
    assert strict == ()


def test_search_with_empty_candidate_set_is_empty() -> None:
    index = _index({"a.py": "alpha"})
    assert index.search("alpha", candidate_paths=[]) == ()
    assert index.stats().shard_loads == 0


def test_fragments_for_paths_only_touches_owning_shards() -> None:
    paths = {f"m{i}.py": f"body {i}" for i in range(300)}
    index = _index(paths)
    wanted = ["m5.py", "m6.py"]

    got = index.fragments_for_paths(wanted)

    assert sorted(f.path for f in got) == sorted(wanted)
    assert index.stats().resident_shards <= 2


def test_loader_failure_yields_empty_shard_not_an_exception() -> None:
    def exploding(_paths):  # type: ignore[no-untyped-def]
        raise OSError("disk gone")

    index = ShardedFragmentIndex(loader=exploding)
    index.register(["a.py"])

    assert index.load_shard(shard_for_path("a.py")) == ()
    assert index.search("a", candidate_paths=["a.py"]) == ()


# ── WorkspaceRagMatcher lazy mode ────────────────────────────────────────────


def test_lazy_matcher_defers_reads_until_extract(tmp_path: Path) -> None:
    for i in range(120):
        (tmp_path / f"module_{i}.py").write_text(
            f"def widget_{i}():\n    return {i}\n", encoding="utf-8"
        )

    matcher = WorkspaceRagMatcher(folders=(tmp_path,), lazy=True)
    index = matcher.shard_index
    assert index is not None
    # Nothing is registered or read before the first query.
    assert index.stats().registered_paths == 0

    fragments = matcher.extract("widget_7")

    assert any("module_7.py" in f.path for f in fragments)
    stats = index.stats()
    assert stats.registered_paths == 120
    # The path-name prefilter narrowed the query, so only a few shards loaded.
    assert stats.resident_shards < stats.populated_shards


def test_lazy_matcher_matches_eager_recall_for_content_only_hits(
    tmp_path: Path,
) -> None:
    (tmp_path / "alpha.py").write_text("magicsentinel = 1\n", encoding="utf-8")
    (tmp_path / "beta.py").write_text("unrelated = 2\n", encoding="utf-8")

    eager = WorkspaceRagMatcher(folders=(tmp_path,))
    lazy = WorkspaceRagMatcher(folders=(tmp_path,), lazy=True)

    # "magicsentinel" appears in no path, so the prefilter finds nothing and the
    # lazy matcher must fall back to a full scan rather than lose the hit.
    eager_paths = sorted(f.path for f in eager.extract("magicsentinel"))
    lazy_paths = sorted(f.path for f in lazy.extract("magicsentinel"))
    assert eager_paths == lazy_paths
    assert any("alpha.py" in p for p in lazy_paths)


def test_lazy_matcher_scores_open_buffers_without_a_shard(tmp_path: Path) -> None:
    from zocai_gateway.context.rag_matcher import OpenBuffer

    matcher = WorkspaceRagMatcher(
        folders=(tmp_path,),
        open_buffers=(OpenBuffer(path="unsaved.py", content="draftsymbol = 1"),),
        lazy=True,
    )

    fragments = matcher.extract("draftsymbol")

    assert [f.path for f in fragments] == ["unsaved.py"]
    assert fragments[0].source is FragmentSource.BUFFER


def test_register_paths_is_a_noop_for_eager_matchers(tmp_path: Path) -> None:
    matcher = WorkspaceRagMatcher(folders=(tmp_path,))
    matcher.register_paths(["late.py"])  # must not raise
    assert matcher.shard_index is None
