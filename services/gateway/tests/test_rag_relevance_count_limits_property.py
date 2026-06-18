"""Property test for RAG relevance/count limits (task 8.7).

Feature: zocai-ecosystem-rebuild, Property 33: RAG results respect relevance
and count limits.

**Validates: Requirements 8.1**

Design Property 33 (verbatim intent): *For any* workspace scan, every returned
fragment has a relevance score of at least ``0.7`` and the total number of
fragments is at most ``50``.

Requirement 8.1: when the INTAKE/ANALYZE stage runs, the RAG_Matcher scans
local workspace folders and open editor buffers and extracts code fragments
whose relevance score is ``>= 0.7`` on a ``0.0``-to-``1.0`` scale, up to a
maximum of ``50`` fragments.

Strategy
--------
We drive :meth:`WorkspaceRagMatcher.scan` over a generated set of open buffers
and control each buffer's relevance through an injected ``scan_hook`` (the
Rust-acceleration seam). Raw scores are drawn from a range that deliberately
straddles the ``0.7`` threshold and overshoots the ``[0.0, 1.0]`` scale, so the
clamp-then-threshold logic is exercised. Candidate counts run well past the
``50`` cap so the count limit and descending-score ordering are both stressed.
"""

from __future__ import annotations

from collections.abc import Sequence

from hypothesis import given, settings
from hypothesis import strategies as st

from zocai_gateway.context.rag_matcher import (
    MAX_FRAGMENTS,
    RELEVANCE_THRESHOLD,
    OpenBuffer,
    WorkspaceRagMatcher,
)


@st.composite
def _scored_buffers(draw: st.DrawFn) -> list[tuple[OpenBuffer, float]]:
    """Generate ``(buffer, raw_score)`` pairs with unique buffer paths.

    Counts run past the ``MAX_FRAGMENTS`` cap so the count limit is exercised,
    and raw scores straddle the ``0.7`` threshold while overshooting the unit
    scale so the matcher's clamp-then-filter behaviour is covered.
    """
    size = draw(st.integers(min_value=0, max_value=80))
    pairs: list[tuple[OpenBuffer, float]] = []
    for index in range(size):
        raw_score = draw(
            st.floats(
                min_value=-0.5,
                max_value=1.5,
                allow_nan=False,
                allow_infinity=False,
            )
        )
        content = draw(st.text(max_size=32))
        # Unique path per buffer keeps the score lookup unambiguous.
        pairs.append((OpenBuffer(path=f"buf_{index}.py", content=content), raw_score))
    return pairs


def _clamp_unit(value: float) -> float:
    """Mirror the matcher's clamp into ``[0.0, 1.0]`` for expectations."""
    return max(0.0, min(1.0, value))


@settings(max_examples=200)
@given(scored=_scored_buffers(), query=st.text(min_size=1, max_size=16))
def test_scan_respects_relevance_and_count_limits(
    scored: Sequence[tuple[OpenBuffer, float]],
    query: str,
) -> None:
    """Property 33: scan results respect the relevance and count limits.

    Feature: zocai-ecosystem-rebuild, Property 33

    **Validates: Requirements 8.1**
    """
    buffers = [buffer for buffer, _ in scored]
    raw_by_path = {buffer.path: raw for buffer, raw in scored}

    def scan_hook(
        _query: str, candidates: Sequence[tuple[str, str]]
    ) -> list[float]:
        # Return the controlled raw score for each candidate, in order.
        return [raw_by_path[path] for path, _content in candidates]

    matcher = WorkspaceRagMatcher(scan_hook=scan_hook)
    fragments = matcher.scan(query, open_buffers=buffers)

    # Relevance limit: every returned fragment scores >= 0.7 and stays on scale.
    for fragment in fragments:
        assert fragment.score >= RELEVANCE_THRESHOLD
        assert 0.0 <= fragment.score <= 1.0

    # Count limit: never more than the 50-fragment cap.
    assert len(fragments) <= MAX_FRAGMENTS

    # Ordering: fragments are sorted by descending relevance score.
    scores = [fragment.score for fragment in fragments]
    assert scores == sorted(scores, reverse=True)

    # Count correctness: exactly the qualifying candidates, capped at the limit.
    qualifying = sum(
        1 for raw in raw_by_path.values() if _clamp_unit(raw) >= RELEVANCE_THRESHOLD
    )
    assert len(fragments) == min(qualifying, MAX_FRAGMENTS)


if __name__ == "__main__":  # pragma: no cover
    import pytest

    raise SystemExit(pytest.main([__file__, "-v"]))
