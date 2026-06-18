"""Property test for tier-aware context injection (task 8.6).

Feature: zocai-ecosystem-rebuild, Property 7: Tier-aware context injection.

**Validates: Requirements 1.7, 1.8**

Design Property 7 (verbatim intent): *For any* list of scored fragments and a
selected ``Model_Tier``, :meth:`WorkspaceRagMatcher.inject` shapes the payload
per tier:

* **Local SLM** — injects *only* the fragments whose path matches the active
  target file, and nothing else (R1.7).
* **Cloud** — injects the full multi-file fragment set together with
  multi-file source maps, dependency maps, and the compiled steering
  directives in one payload (R1.8).
* **Edge** (the unconstrained middle tier) — passes the matched fragments
  through unchanged.

Strategy
--------
We generate lists of :class:`RagFragment` over a small, shared pool of paths so
that active-target collisions (and multiple fragments per path) actually occur,
together with realistic import-bearing content so the Cloud dependency map is
exercised. Scores are drawn at or above the ``0.7`` retention threshold, which
is the domain the matcher operates on post-scan. For each drawn fragment list
we exercise every tier and assert the tier-specific shaping invariant.
"""

from __future__ import annotations

from collections.abc import Sequence

from hypothesis import given, settings
from hypothesis import strategies as st

from zocai_gateway.context.rag_matcher import (
    FragmentSource,
    InjectedContext,
    RagFragment,
    WorkspaceRagMatcher,
)
from zocai_gateway.model_interface import ModelTier

# A small, shared path pool so generated fragment lists collide on paths and
# the chosen ``active_target`` frequently matches one or more fragments.
_PATHS = ["app.py", "auth.py", "ui.ts", "lib/util.py", "other.py"]

# Content snippets, some bearing import/dependency references so the Cloud
# dependency map (R1.8) is exercised across many examples.
_CONTENTS = [
    "from auth import login\nimport os\nprint('hi')",
    "import { Button } from './button'\nconst x = require('lodash')",
    "def f():\n    return 1",
    "from lib.util import helper\nx = helper()",
    "plain prose with no imports at all",
    "",
]

_matcher = WorkspaceRagMatcher()


@st.composite
def _fragments(draw: st.DrawFn) -> list[RagFragment]:
    """A list of scored fragments drawn over the shared path/content pools."""
    size = draw(st.integers(min_value=0, max_value=12))
    fragments: list[RagFragment] = []
    for _ in range(size):
        fragments.append(
            RagFragment(
                path=draw(st.sampled_from(_PATHS)),
                content=draw(st.sampled_from(_CONTENTS)),
                # Post-scan domain: at or above the 0.7 retention threshold.
                score=draw(
                    st.floats(
                        min_value=0.7,
                        max_value=1.0,
                        allow_nan=False,
                        allow_infinity=False,
                    )
                ),
                source=draw(st.sampled_from(list(FragmentSource))),
            )
        )
    return fragments


# active_target may match a pooled path, be an unmatched path, or be absent.
_active_target = st.one_of(
    st.none(),
    st.sampled_from(_PATHS),
    st.just("does/not/exist.py"),
)

_steering = st.text(max_size=64)


@settings(max_examples=200)
@given(fragments=_fragments(), active_target=_active_target, steering=_steering)
def test_local_slm_injects_only_active_target_fragments(
    fragments: Sequence[RagFragment],
    active_target: str | None,
    steering: str,
) -> None:
    """Property 7 (Local SLM): only active-target fragments are injected (R1.7).

    Feature: zocai-ecosystem-rebuild, Property 7

    **Validates: Requirements 1.7**
    """
    injected = _matcher.inject(
        ModelTier.LOCAL_SLM,
        fragments,
        active_target=active_target,
        steering=steering,
    )

    assert isinstance(injected, InjectedContext)
    assert injected.tier is ModelTier.LOCAL_SLM

    # Every injected fragment references the active target, and exactly the
    # active-target fragments are injected (order/multiplicity preserved).
    expected = (
        [f for f in fragments if f.path == active_target]
        if active_target is not None
        else []
    )
    assert list(injected.fragments) == expected
    assert all(f.path == active_target for f in injected.fragments)

    # Local SLM gets no source/dependency maps and no steering payload (R1.7).
    assert injected.source_maps == {}
    assert injected.dependency_maps == {}
    assert injected.steering == ""


@settings(max_examples=200)
@given(fragments=_fragments(), active_target=_active_target, steering=_steering)
def test_cloud_injects_source_dependency_maps_and_steering(
    fragments: Sequence[RagFragment],
    active_target: str | None,
    steering: str,
) -> None:
    """Property 7 (Cloud): full maps + steering injected in one payload (R1.8).

    Feature: zocai-ecosystem-rebuild, Property 7

    **Validates: Requirements 1.8**
    """
    injected = _matcher.inject(
        ModelTier.CLOUD,
        fragments,
        active_target=active_target,
        steering=steering,
    )

    assert injected.tier is ModelTier.CLOUD

    # Cloud receives the full multi-file fragment set unchanged.
    assert list(injected.fragments) == list(fragments)

    # Source and dependency maps cover exactly the set of fragment paths (R1.8).
    fragment_paths = {f.path for f in fragments}
    assert set(injected.source_maps) == fragment_paths
    assert set(injected.dependency_maps) == fragment_paths

    # Every dependency reference appears in the corresponding fragment content,
    # so the dependency map is derived from (not invented beyond) the sources.
    for path, refs in injected.dependency_maps.items():
        joined = "\n".join(f.content for f in fragments if f.path == path)
        for ref in refs:
            assert ref in joined

    # The compiled steering directives are injected verbatim (R1.8).
    assert injected.steering == steering


@settings(max_examples=200)
@given(fragments=_fragments(), active_target=_active_target, steering=_steering)
def test_edge_passes_matched_fragments_through_unchanged(
    fragments: Sequence[RagFragment],
    active_target: str | None,
    steering: str,
) -> None:
    """Property 7 (Edge): matched fragments pass through unchanged.

    Feature: zocai-ecosystem-rebuild, Property 7

    **Validates: Requirements 1.7, 1.8**
    """
    injected = _matcher.inject(
        ModelTier.EDGE,
        fragments,
        active_target=active_target,
        steering=steering,
    )

    assert injected.tier is ModelTier.EDGE

    # The middle tier is unconstrained by R1.7/R1.8: fragments are unchanged
    # and none of the Cloud-only shaping is applied.
    assert list(injected.fragments) == list(fragments)
    assert injected.source_maps == {}
    assert injected.dependency_maps == {}
    assert injected.steering == ""


if __name__ == "__main__":  # pragma: no cover
    import pytest

    raise SystemExit(pytest.main([__file__, "-v"]))
