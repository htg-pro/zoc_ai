"""Property test for the token gate fit/truncation order (task 8.10).

Feature: zocai-ecosystem-rebuild, Property 36: Token gate fits the window and
truncates lowest relevance first.

**Validates: Requirements 8.5**

Design Property 36 (verbatim intent): *For any* fragment set and allocated
window, the injected payload's token count does not exceed the window, and any
dropped fragments are the lowest-relevance fragments (R8.5).

This is made precise against
:func:`zocai_gateway.context.token_gate.fit_fragments` by asserting three
invariants that together capture "fits the window" and "lowest relevance
truncated first":

1. **Fit** — the kept payload's estimated ``token_count`` never exceeds the
   window, and equals the sum of the kept fragments' token estimates.
2. **Truncation order** — every dropped fragment has a score ``<=`` every kept
   fragment's score (the lowest-relevance fragments are the ones dropped).
3. **Relevance prefix** — the kept fragments are in non-increasing relevance
   order (a descending-relevance prefix of the sorted candidates).

Strategy
--------
We generate fragment lists with widely varying scores *and* content lengths so
both the relevance ordering and the per-fragment token cost are exercised, and
we draw window sizes spanning "admits nothing", "admits a prefix", and "admits
everything". Scores are drawn across the full ``0.0``–``1.0`` range (not just
post-threshold) since the gate's contract is independent of the retention
threshold.
"""

from __future__ import annotations

from collections.abc import Sequence

from hypothesis import given, settings
from hypothesis import strategies as st

from zocai_gateway.context.rag_matcher import FragmentSource, RagFragment
from zocai_gateway.context.token_gate import (
    TokenGateResult,
    estimate_tokens,
    fit_fragments,
)


@st.composite
def _fragments(draw: st.DrawFn) -> list[RagFragment]:
    """A list of scored fragments with varied scores and content lengths."""
    size = draw(st.integers(min_value=0, max_value=15))
    fragments: list[RagFragment] = []
    for index in range(size):
        # Content length varies widely so per-fragment token cost spans empty
        # through multi-token fragments.
        content = draw(
            st.text(
                alphabet=st.characters(min_codepoint=33, max_codepoint=126),
                min_size=0,
                max_size=80,
            )
        )
        fragments.append(
            RagFragment(
                # Distinct paths keep the ordering tie-break deterministic and
                # let us identify fragments uniquely.
                path=f"frag_{index}.py",
                content=content,
                score=draw(
                    st.floats(
                        min_value=0.0,
                        max_value=1.0,
                        allow_nan=False,
                        allow_infinity=False,
                    )
                ),
                source=draw(st.sampled_from(list(FragmentSource))),
            )
        )
    return fragments


# Windows span "admits nothing" (incl. negative), small prefixes, and large
# enough to admit everything the strategy can produce.
_windows = st.integers(min_value=-5, max_value=400)


@settings(max_examples=200)
@given(fragments=_fragments(), window=_windows)
def test_token_gate_fits_and_truncates_lowest_relevance_first(
    fragments: Sequence[RagFragment],
    window: int,
) -> None:
    """Property 36: payload fits the window; lowest relevance truncated first.

    Feature: zocai-ecosystem-rebuild, Property 36

    **Validates: Requirements 8.5**
    """
    result = fit_fragments(fragments, window=window)

    assert isinstance(result, TokenGateResult)

    safe_window = max(window, 0)
    assert result.window == safe_window

    # (1) Fit: the kept payload never exceeds the window and token_count is the
    # exact sum of the kept fragments' deterministic token estimates.
    assert result.token_count <= result.window
    assert result.token_count == sum(
        estimate_tokens(f.content) for f in result.fragments
    )

    # Kept and dropped partition the input exactly (no loss, no duplication).
    assert len(result.fragments) + len(result.dropped) == len(fragments)
    by_path = lambda items: sorted(f.path for f in items)  # noqa: E731
    assert by_path(list(result.fragments) + list(result.dropped)) == by_path(
        fragments
    )

    # (2) Truncation order: every dropped fragment is of lower-or-equal
    # relevance than every kept fragment (lowest relevance truncated first).
    if result.fragments and result.dropped:
        min_kept_score = min(f.score for f in result.fragments)
        max_dropped_score = max(f.score for f in result.dropped)
        assert max_dropped_score <= min_kept_score

    # (3) Relevance prefix: kept fragments are in non-increasing score order.
    kept_scores = [f.score for f in result.fragments]
    assert kept_scores == sorted(kept_scores, reverse=True)


if __name__ == "__main__":  # pragma: no cover
    import pytest

    raise SystemExit(pytest.main([__file__, "-v"]))
