"""Hybrid retrieval properties for the Advanced Context Engine."""

from __future__ import annotations

import math
from itertools import pairwise

from hypothesis import given, settings
from hypothesis import strategies as st
from zocai_gateway.context.rag_matcher import (
    BM25Index,
    hybrid_rank,
    hybrid_search,
    rrf,
)

_SCORE = st.one_of(
    st.floats(
        min_value=-10,
        max_value=10,
        allow_nan=False,
        allow_infinity=False,
    ),
    st.sampled_from([float("nan"), float("inf"), float("-inf")]),
)


@st.composite
def _score_pairs(draw: st.DrawFn) -> tuple[list[float], list[float]]:
    size = draw(st.integers(min_value=0, max_value=30))
    return (
        draw(st.lists(_SCORE, min_size=size, max_size=size)),
        draw(st.lists(_SCORE, min_size=size, max_size=size)),
    )


@settings(max_examples=100, deadline=None)
@given(scores=_score_pairs())
def test_rrf_is_deterministic_and_excludes_non_positive_scores(
    scores: tuple[list[float], list[float]],
) -> None:
    """Feature: advanced-context-engine, Property 7: deterministic RRF.

    **Validates: Requirements 3.2, 3.4, 3.5**
    """
    lexical, semantic = scores
    first = rrf(lexical, semantic, k=60)
    second = rrf(lexical, semantic, k=60)
    assert first == second

    participating = {
        index
        for index, pair in enumerate(zip(lexical, semantic, strict=True))
        if any(math.isfinite(score) and score > 0 for score in pair)
    }
    assert {index for index, score in enumerate(first) if score > 0} == participating

    ranked = sorted(
        ((index, score) for index, score in enumerate(first) if score > 0),
        key=lambda item: (-item[1], item[0]),
    )
    for (left_index, left_score), (right_index, right_score) in pairwise(ranked):
        assert left_score >= right_score
        if left_score == right_score:
            assert left_index < right_index


@st.composite
def _hybrid_case(
    draw: st.DrawFn,
) -> tuple[list[bool], list[float], int]:
    size = draw(st.integers(min_value=0, max_value=30))
    lexical = draw(st.lists(st.booleans(), min_size=size, max_size=size))
    semantic = draw(
        st.lists(
            st.floats(
                min_value=0,
                max_value=1,
                allow_nan=False,
                allow_infinity=False,
            ),
            min_size=size,
            max_size=size,
        )
    )
    limit = draw(st.integers(min_value=-5, max_value=40))
    return lexical, semantic, limit


@settings(max_examples=100, deadline=None)
@given(case=_hybrid_case())
def test_hybrid_search_is_a_bounded_deterministic_prefix(
    case: tuple[list[bool], list[float], int],
) -> None:
    """Feature: advanced-context-engine, Property 8: hybrid result contract.

    **Validates: Requirements 3.3, 3.8**
    """
    lexical_flags, semantic_values, limit = case
    documents = [
        f"needle document {index}" if matches else f"other document {index}"
        for index, matches in enumerate(lexical_flags)
    ]
    embeddings = [
        (value, 1.0 - value) for value in semantic_values
    ]
    chunks = tuple(range(len(documents)))
    bm25 = BM25Index(documents)
    embed_query = lambda _query: (1.0, 0.0)  # noqa: E731

    full = hybrid_rank(
        "needle",
        bm25_index=bm25,
        embeddings=embeddings,
        embed_query=embed_query,
        limit=len(documents) + 1,
    )
    result = hybrid_search(
        "needle",
        chunks,
        bm25_index=bm25,
        embeddings=embeddings,
        embed_query=embed_query,
        k=limit,
    )
    expected = [] if limit <= 0 else [index for index, _score in full[:limit]]
    assert result == expected
    assert len(result) <= max(limit, 0)
    assert result == hybrid_search(
        "needle",
        chunks,
        bm25_index=bm25,
        embeddings=embeddings,
        embed_query=embed_query,
        k=limit,
    )

    for (left_index, left_score), (right_index, right_score) in pairwise(full):
        assert left_score >= right_score
        if left_score == right_score:
            assert left_index < right_index

    default_result = hybrid_search(
        "needle",
        chunks,
        bm25_index=bm25,
        embeddings=embeddings,
        embed_query=embed_query,
    )
    assert default_result == [index for index, _score in full[:20]]
    assert len(default_result) <= 20
