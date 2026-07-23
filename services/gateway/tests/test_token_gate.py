"""Unit tests for the scale-adaptive token gate (task 8.4, R8.5).

These example-based tests cover the behaviors the task calls out: a
deterministic token-count estimate, sizing the payload to the allocated
context window, and truncating the lowest-relevance fragments first. The
exhaustive property test lives in task 8.10 (Property 36).
"""

from __future__ import annotations

from dataclasses import dataclass

from zocai_gateway.context.rag_matcher import BM25Index, FragmentSource, RagFragment
from zocai_gateway.context.token_gate import (
    CHARS_PER_TOKEN,
    ChunkBudgetResult,
    TokenGateResult,
    estimate_tokens,
    fit_chunks,
    fit_fragments,
    hybrid_search_within_budget,
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


# -- fit_chunks -------------------------------------------------------------


@dataclass(frozen=True)
class _Chunk:
    """A minimal non-string chunk used to exercise the ``text`` accessor."""

    path: str
    content: str


def test_fit_chunks_empty_input_yields_empty_result() -> None:
    result = fit_chunks([], budget=100)
    assert result == ChunkBudgetResult(chunks=(), total_tokens=0, budget=100)


def test_fit_chunks_keeps_all_when_budget_is_large() -> None:
    chunks = ["alpha", "beta", "gamma"]
    result = fit_chunks(chunks, budget=1_000)

    assert result.chunks == ("alpha", "beta", "gamma")
    assert result.total_tokens == sum(estimate_tokens(c) for c in chunks)
    assert result.total_tokens <= result.budget


def test_fit_chunks_keeps_relevance_prefix_until_budget_reached() -> None:
    # Each chunk costs exactly 1 token; a 2-token budget keeps the first two
    # (in retrieval order) and stops before the third.
    chunks = [c * CHARS_PER_TOKEN for c in ("a", "b", "c")]
    result = fit_chunks(chunks, budget=2)

    assert result.chunks == ("a" * CHARS_PER_TOKEN, "b" * CHARS_PER_TOKEN)
    assert result.total_tokens == 2
    assert result.budget == 2


def test_fit_chunks_preserves_retrieval_order() -> None:
    # Retrieval order is deliberately not relevance-sorted here; fit_chunks must
    # keep the supplied order because hybrid_search already ranked the chunks.
    chunks = ["one", "two", "three", "four"]
    result = fit_chunks(chunks, budget=1_000)

    assert list(result.chunks) == chunks


def test_fit_chunks_admits_chunk_that_exactly_fills_budget() -> None:
    # A chunk costing exactly the remaining budget is admitted (boundary <=).
    exact = "x" * (CHARS_PER_TOKEN * 5)
    result = fit_chunks([exact], budget=5)

    assert result.chunks == (exact,)
    assert result.total_tokens == 5


def test_fit_chunks_first_chunk_over_budget_yields_empty() -> None:
    result = fit_chunks(["x" * (CHARS_PER_TOKEN * 100)], budget=10)

    assert result.chunks == ()
    assert result.total_tokens == 0


def test_fit_chunks_stops_at_first_overflow_without_backfilling() -> None:
    # A 3-token chunk ahead of a 1-token chunk with a 2-token budget: the gate
    # stops at the oversized chunk rather than skipping it to admit the smaller
    # one, so the kept set stays a strict prefix of the ranking.
    big = "x" * (CHARS_PER_TOKEN * 3)
    small = "y" * CHARS_PER_TOKEN
    result = fit_chunks([big, small], budget=2)

    assert result.chunks == ()
    assert result.total_tokens == 0


def test_fit_chunks_non_positive_budget_admits_nothing() -> None:
    zero = fit_chunks(["alpha", "beta"], budget=0)
    assert zero.chunks == ()
    assert zero.total_tokens == 0
    assert zero.budget == 0

    negative = fit_chunks(["alpha"], budget=-5)
    assert negative.chunks == ()
    assert negative.total_tokens == 0
    assert negative.budget == 0  # clamped to zero


def test_fit_chunks_uses_custom_text_accessor() -> None:
    chunks = [
        _Chunk("a.py", "a" * CHARS_PER_TOKEN),  # 1 token
        _Chunk("b.py", "b" * (CHARS_PER_TOKEN * 3)),  # 3 tokens
    ]
    result = fit_chunks(chunks, budget=2, text=lambda chunk: chunk.content)

    assert result.chunks == (chunks[0],)
    assert result.total_tokens == 1


def test_fit_chunks_total_never_exceeds_budget_and_is_a_prefix() -> None:
    chunks = ["z" * (CHARS_PER_TOKEN * (i + 1)) for i in range(10)]
    result = fit_chunks(chunks, budget=15)

    assert result.total_tokens <= result.budget
    assert result.total_tokens == sum(estimate_tokens(c) for c in result.chunks)
    assert list(result.chunks) == chunks[: len(result.chunks)]


# -- hybrid_search_within_budget (Phase D wiring) ---------------------------


def _auth_hybrid_fixture() -> tuple[BM25Index, list[list[float]], list[str]]:
    """The BM25 + embedding setup shared by the wiring tests.

    Mirrors ``test_rag_matcher``'s hybrid-search fixture: ``hybrid_search``
    ranks these chunks as ``["fused", "lexical"]`` for ``k=2``, and each of
    those two chunks estimates to 2 tokens.
    """
    index = BM25Index(["auth token auth", "auth helper", "unrelated"])
    embeddings = [[0.0, 1.0], [1.0, 0.0], [0.8, 0.2]]
    chunks = ["lexical", "fused", "semantic"]
    return index, embeddings, chunks


def test_hybrid_search_within_budget_returns_ranked_prefix_that_fits() -> None:
    index, embeddings, chunks = _auth_hybrid_fixture()

    # 2-token budget admits only the top-ranked "fused" (2 tokens); the next
    # ranked chunk "lexical" (2 tokens) would overflow, so the gate stops.
    result = hybrid_search_within_budget(
        "auth token",
        chunks,
        budget=2,
        bm25_index=index,
        embeddings=embeddings,
        embed_query=lambda _query: [1.0, 0.0],
        k=2,
    )

    assert result.chunks == ("fused",)
    assert result.total_tokens == 2
    assert result.total_tokens <= result.budget


def test_hybrid_search_within_budget_keeps_full_prefix_when_budget_large() -> None:
    index, embeddings, chunks = _auth_hybrid_fixture()

    result = hybrid_search_within_budget(
        "auth token",
        chunks,
        budget=1_000,
        bm25_index=index,
        embeddings=embeddings,
        embed_query=lambda _query: [1.0, 0.0],
        k=2,
    )

    # A generous budget keeps the entire ranked prefix, in ranked order.
    assert result.chunks == ("fused", "lexical")
    assert result.total_tokens == estimate_tokens("fused") + estimate_tokens("lexical")
    assert result.total_tokens <= result.budget


def test_hybrid_search_within_budget_zero_budget_admits_nothing() -> None:
    index, embeddings, chunks = _auth_hybrid_fixture()

    result = hybrid_search_within_budget(
        "auth token",
        chunks,
        budget=0,
        bm25_index=index,
        embeddings=embeddings,
        embed_query=lambda _query: [1.0, 0.0],
        k=2,
    )

    assert result.chunks == ()
    assert result.total_tokens == 0
