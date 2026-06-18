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

from zocai_gateway.context.rag_matcher import RagFragment

__all__ = [
    "CHARS_PER_TOKEN",
    "TokenEstimator",
    "TokenGateResult",
    "estimate_tokens",
    "fit_fragments",
]

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
