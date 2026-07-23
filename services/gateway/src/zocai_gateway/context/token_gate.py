"""The scale-adaptive ``Token Gate`` (Layer 3, R8.5).

When the Context_Bus assembles a context payload it must fit inside the
context window the :class:`~zocai_gateway.model_allocator.Allocation` sized for
the selected tier. The token gate takes a list of
:class:`~zocai_gateway.context.rag_matcher.RagFragment` and an allocated window
size (in tokens) and returns the largest payload that fits, **truncating the
lowest-relevance fragments first** (R8.5).

The gate keeps a *relevance prefix*: fragments are ordered by descending
relevance (ties broken deterministically by path then content), and fragments
are admitted in that order until the next fragment would exceed the window. At
that point that fragment and every lower-relevance fragment after it are
dropped. This guarantees two things at once (Property 36):

* the retained payload's estimated token count never exceeds the window, and
* every dropped fragment is of lower-or-equal relevance than every kept
  fragment — i.e. only the lowest-relevance fragments are ever truncated.

Token counting is a deterministic *estimate* (see :func:`estimate_tokens`): the
gate never needs a real tokenizer to decide what fits, so its decisions are
stable and reproducible across runs and platforms.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Generic, TypeVar

from zocai_gateway.context.rag_matcher import (
    BM25Index,
    QueryEmbedder,
    RagFragment,
    hybrid_search,
)

__all__ = [
    "CHARS_PER_TOKEN",
    "ChunkBudgetResult",
    "TokenEstimator",
    "TokenGateResult",
    "estimate_tokens",
    "fit_chunks",
    "fit_fragments",
    "hybrid_search_within_budget",
]

# A retrieved chunk can be any object (a string, a fragment, …); the gate only
# needs a way to read its text to estimate cost. ``ChunkT`` keeps the budget
# helper generic over whatever ``hybrid_search`` was asked to rank.
ChunkT = TypeVar("ChunkT")

# Extracts the token-bearing text from a chunk. Defaults to ``str`` so plain
# string chunks (the common ``hybrid_search`` case) work with no wiring.
ChunkText = Callable[["ChunkT"], str]

# Average characters per token used by the deterministic estimate. Four
# characters per token is the widely used rough heuristic for English-like
# source text; it keeps the estimate stable without a real tokenizer.
CHARS_PER_TOKEN = 4

# A token estimator maps a piece of text to a non-negative token-count
# estimate. Injectable so a tier-specific tokenizer can replace the default
# heuristic without changing the gate's selection logic.
TokenEstimator = Callable[[str], int]


def estimate_tokens(text: str) -> int:
    """Return a deterministic token-count estimate for ``text``.

    The estimate is ``ceil(len(text) / CHARS_PER_TOKEN)`` characters per token,
    which is monotonic in length, never negative, and ``0`` for empty text.
    It is intentionally tokenizer-free so the gate's fit decisions are
    reproducible across runs and platforms.
    """
    length = len(text)
    if length <= 0:
        return 0
    return (length + CHARS_PER_TOKEN - 1) // CHARS_PER_TOKEN


@dataclass(frozen=True, slots=True)
class TokenGateResult:
    """The outcome of sizing a fragment payload to a context window (R8.5).

    :attr:`fragments` are the kept fragments in descending-relevance order;
    :attr:`dropped` are the truncated fragments (the lowest-relevance ones),
    also in descending-relevance order. :attr:`token_count` is the estimated
    token total of the kept payload and is always ``<= window``.
    """

    fragments: tuple[RagFragment, ...]
    dropped: tuple[RagFragment, ...]
    token_count: int
    window: int


def _relevance_order_key(fragment: RagFragment) -> tuple[float, str, str]:
    """Sort key placing the highest-relevance fragment first.

    Negating the score yields descending relevance; path and content break
    ties so the ordering is total and deterministic even when scores collide.
    """
    return (-fragment.score, fragment.path, fragment.content)


def fit_fragments(
    fragments: Sequence[RagFragment],
    window: int,
    *,
    estimate: TokenEstimator = estimate_tokens,
) -> TokenGateResult:
    """Size ``fragments`` to fit ``window`` tokens, truncating lowest relevance first.

    Fragments are considered in descending relevance order. Each is admitted
    while the running token total stays ``<= window``; the first fragment that
    would overflow the window — and every lower-relevance fragment after it —
    is dropped (R8.5). The kept payload is therefore a relevance prefix, so its
    token count never exceeds ``window`` and only the lowest-relevance
    fragments are ever truncated (Property 36).

    :param fragments: Candidate fragments (any order; sorted internally).
    :param window: Allocated context window size in tokens. Non-positive
        windows admit nothing.
    :param estimate: Deterministic per-fragment token estimator. Defaults to
        :func:`estimate_tokens`.
    """
    safe_window = max(window, 0)
    ordered = sorted(fragments, key=_relevance_order_key)

    kept: list[RagFragment] = []
    dropped: list[RagFragment] = []
    used = 0
    overflowed = False

    for fragment in ordered:
        if overflowed:
            # Once the prefix overflows, every remaining (lower-relevance)
            # fragment is truncated so the kept set stays a relevance prefix.
            dropped.append(fragment)
            continue

        cost = max(estimate(fragment.content), 0)
        if used + cost <= safe_window:
            kept.append(fragment)
            used += cost
        else:
            overflowed = True
            dropped.append(fragment)

    return TokenGateResult(
        fragments=tuple(kept),
        dropped=tuple(dropped),
        token_count=used,
        window=safe_window,
    )


@dataclass(frozen=True, slots=True)
class ChunkBudgetResult(Generic[ChunkT]):
    """The outcome of enforcing a token budget on ranked chunks (R8.5).

    :attr:`chunks` are the retained chunks **in the order they were supplied**
    (i.e. the relevance order produced by
    :func:`~zocai_gateway.context.rag_matcher.hybrid_search`), forming a prefix
    of that ranking. :attr:`total_tokens` is the estimated token total of the
    retained chunks and is always ``<= budget``.
    """

    chunks: tuple[ChunkT, ...]
    total_tokens: int
    budget: int


def fit_chunks(
    chunks: Sequence[ChunkT],
    budget: int,
    *,
    estimate: TokenEstimator = estimate_tokens,
    text: ChunkText[ChunkT] = str,
) -> ChunkBudgetResult[ChunkT]:
    """Enforce a token ``budget`` on the ranked output of ``hybrid_search``.

    ``chunks`` are assumed to already be in descending-relevance order — exactly
    what :func:`~zocai_gateway.context.rag_matcher.hybrid_search` returns. The
    gate walks that order accumulating each chunk's estimated token cost, and
    keeps adding chunks until the running total would exceed ``budget``, at
    which point it **stops** (R8.5). Because retrieval order is preserved, the
    kept chunks are always the most relevant prefix that fits.

    :param chunks: Ranked chunks from ``hybrid_search`` (most relevant first).
    :param budget: Token budget for the context payload. Non-positive budgets
        admit nothing.
    :param estimate: Deterministic token estimator. Defaults to
        :func:`estimate_tokens`.
    :param text: Reads the token-bearing text from a chunk. Defaults to ``str``
        so plain string chunks work without configuration.
    :returns: A :class:`ChunkBudgetResult` with the retained chunks (in
        retrieval order) and their estimated ``total_tokens``.
    """
    safe_budget = max(budget, 0)
    if budget <= 0 or not chunks:
        return ChunkBudgetResult(chunks=(), total_tokens=0, budget=safe_budget)

    kept: list[ChunkT] = []
    used = 0

    for chunk in chunks:
        cost = max(estimate(text(chunk)), 0)
        if used + cost > safe_budget:
            # The budget limit is reached: stop admitting chunks so the kept
            # payload stays a relevance-ordered prefix that fits the window.
            break
        kept.append(chunk)
        used += cost

    return ChunkBudgetResult(
        chunks=tuple(kept),
        total_tokens=used,
        budget=safe_budget,
    )


def hybrid_search_within_budget(
    query: str,
    chunks: Sequence[ChunkT],
    budget: int,
    *,
    bm25_index: BM25Index,
    embeddings: Sequence[Sequence[float]],
    embed_query: QueryEmbedder,
    k: int = 20,
    rrf_k: int = 60,
    estimate: TokenEstimator = estimate_tokens,
    text: ChunkText[ChunkT] = str,
) -> ChunkBudgetResult[ChunkT]:
    """Rank ``chunks`` with hybrid search, then enforce a token ``budget`` (R8.5).

    This is the wired context-budget path (Layer 3, Phase D): it runs
    :func:`~zocai_gateway.context.rag_matcher.hybrid_search` to order ``chunks``
    most-relevant-first, then feeds that ranking straight into
    :func:`fit_chunks`, which keeps admitting chunks until the next one would
    exceed ``budget`` and then stops. The returned :class:`ChunkBudgetResult`
    carries the retained chunks in retrieval order together with their estimated
    ``total_tokens`` — i.e. the most relevant prefix that fits the window.

    :param query: The task/query text ranked against ``chunks``.
    :param chunks: Candidate chunks to rank and budget. Their count must match
        ``bm25_index.document_count`` (``hybrid_search``'s contract).
    :param budget: Token budget for the context payload. Non-positive budgets
        admit nothing.
    :param bm25_index: Lexical BM25 index built over the same ``chunks``, in the
        same order.
    :param embeddings: One embedding vector per chunk, aligned with ``chunks``.
    :param embed_query: Embeds ``query`` into the ``embeddings`` vector space.
    :param k: Maximum number of chunks hybrid search returns before budgeting.
    :param rrf_k: Reciprocal-rank-fusion constant passed to hybrid search.
    :param estimate: Deterministic token estimator. Defaults to
        :func:`estimate_tokens`.
    :param text: Reads the token-bearing text from a chunk. Defaults to ``str``
        so plain string chunks work without configuration.
    :returns: A :class:`ChunkBudgetResult` with the retained chunks (in
        retrieval order) and their estimated ``total_tokens`` (always
        ``<= budget``).
    """
    ranked = hybrid_search(
        query,
        chunks,
        bm25_index=bm25_index,
        embeddings=embeddings,
        embed_query=embed_query,
        k=k,
        rrf_k=rrf_k,
    )
    return fit_chunks(ranked, budget, estimate=estimate, text=text)
