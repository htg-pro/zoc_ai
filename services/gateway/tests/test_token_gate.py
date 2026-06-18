"""Unit tests for the scale-adaptive token gate (task 8.4, R8.5).

These example-based tests cover the behaviors the task calls out: a
deterministic token-count estimate, sizing the payload to the allocated
context window, and truncating the lowest-relevance fragments first. The
exhaustive property test lives in task 8.10 (Property 36).
"""

from __future__ import annotations

from zocai_gateway.context.rag_matcher import FragmentSource, RagFragment
from zocai_gateway.context.token_gate import (
    CHARS_PER_TOKEN,
    TokenGateResult,
    estimate_tokens,
    fit_fragments,
)


def _fragment(path: str, score: float, content: str) -> RagFragment:
    return RagFragment(
        path=path, content=content, score=score, source=FragmentSource.FOLDER
    )


# -- estimate_tokens --------------------------------------------------------


def test_estimate_tokens_empty_is_zero() -> None:
    assert estimate_tokens("") == 0


def test_estimate_tokens_rounds_up() -> None:
    # CHARS_PER_TOKEN chars -> 1 token; one extra char rounds up to 2.
    assert estimate_tokens("a" * CHARS_PER_TOKEN) == 1
    assert estimate_tokens("a" * (CHARS_PER_TOKEN + 1)) == 2


def test_estimate_tokens_is_deterministic_and_monotonic() -> None:
    text = "the quick brown fox"
    assert estimate_tokens(text) == estimate_tokens(text)
    assert estimate_tokens(text) <= estimate_tokens(text + "!")


# -- fit_fragments ----------------------------------------------------------


def test_empty_input_yields_empty_result() -> None:
    result = fit_fragments([], window=100)
    assert result == TokenGateResult(
        fragments=(), dropped=(), token_count=0, window=100
    )


def test_all_fragments_fit_when_window_is_large() -> None:
    frags = [
        _fragment("a.py", 0.9, "alpha"),
        _fragment("b.py", 0.8, "beta"),
    ]
    result = fit_fragments(frags, window=1_000)

    assert result.dropped == ()
    assert {f.path for f in result.fragments} == {"a.py", "b.py"}
    assert result.token_count <= result.window


def test_lowest_relevance_fragment_is_truncated_first() -> None:
    # Each fragment costs 5 tokens (20 chars / 4). A window of 12 tokens fits
    # two fragments; the lowest-relevance one is dropped.
    content = "x" * (CHARS_PER_TOKEN * 5)
    frags = [
        _fragment("low.py", 0.71, content),
        _fragment("high.py", 0.99, content),
        _fragment("mid.py", 0.85, content),
    ]
    result = fit_fragments(frags, window=12)

    kept_paths = [f.path for f in result.fragments]
    dropped_paths = [f.path for f in result.dropped]

    assert kept_paths == ["high.py", "mid.py"]
    assert dropped_paths == ["low.py"]
    assert result.token_count <= result.window


def test_dropped_fragments_are_never_higher_relevance_than_kept() -> None:
    content = "x" * (CHARS_PER_TOKEN * 4)  # 4 tokens each
    frags = [
        _fragment("a.py", 0.95, content),
        _fragment("b.py", 0.90, content),
        _fragment("c.py", 0.75, content),
    ]
    result = fit_fragments(frags, window=9)  # room for exactly two fragments

    assert [f.path for f in result.fragments] == ["a.py", "b.py"]
    assert [f.path for f in result.dropped] == ["c.py"]
    if result.fragments and result.dropped:
        min_kept = min(f.score for f in result.fragments)
        max_dropped = max(f.score for f in result.dropped)
        assert max_dropped <= min_kept


def test_single_oversized_fragment_is_dropped() -> None:
    frags = [_fragment("big.py", 0.99, "x" * (CHARS_PER_TOKEN * 100))]
    result = fit_fragments(frags, window=10)

    assert result.fragments == ()
    assert [f.path for f in result.dropped] == ["big.py"]
    assert result.token_count == 0


def test_non_positive_window_admits_nothing() -> None:
    frags = [_fragment("a.py", 0.9, "alpha")]
    result = fit_fragments(frags, window=0)

    assert result.fragments == ()
    assert [f.path for f in result.dropped] == ["a.py"]
    assert result.window == 0


def test_kept_payload_never_exceeds_window() -> None:
    frags = [
        _fragment(f"f{i}.py", 0.7 + i / 100, "y" * (CHARS_PER_TOKEN * (i + 1)))
        for i in range(10)
    ]
    result = fit_fragments(frags, window=15)

    total = sum(estimate_tokens(f.content) for f in result.fragments)
    assert total == result.token_count
    assert result.token_count <= result.window
