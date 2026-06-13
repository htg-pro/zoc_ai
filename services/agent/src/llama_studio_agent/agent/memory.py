"""Token-budget-aware working memory truncation.

Keeps conversation history within the model's context window by trimming
the oldest messages first while always preserving:

  - the system prompt (callers prepend it themselves; we just account for it)
  - a working window of the most-recent N turns
  - room for tool schemas and the response

Token estimation is intentionally a cheap heuristic (~4 chars/token) so
this module has zero runtime dependencies. Phase 3+ can swap in a real
tokenizer (tiktoken / model-specific) without changing the public API.
"""

from __future__ import annotations

from dataclasses import dataclass

from shared_schema.models import Message

from ..providers.base import ChatMessage, ToolSchema


@dataclass(slots=True)
class MemoryConfig:
    """Static budget knobs. All values are in tokens."""

    context_window: int
    output_reserve: int = 2048
    """Tokens left untouched so the model has room to reply."""

    tool_overhead_floor: int = 1024
    """Lower bound for tool-schema overhead even when no tools are wired."""

    working_window: int = 20
    """Most-recent N messages we always try to keep verbatim."""

    summary_reserve: int = 0
    """Tokens reserved for a Phase-3 episodic summary. 0 until Phase 3 lands."""


@dataclass(slots=True)
class MemoryStats:
    """What `fit_budget` decided. Surfaced to the UI for the memory indicator."""

    context_window: int
    tokens_used: int
    tokens_available: int
    messages_in_context: int
    total_messages: int
    dropped_messages: int


def estimate_tokens(text: str | None) -> int:
    """~4 chars per token. Cheap, deterministic, good enough for budgeting."""
    if not text:
        return 0
    # Add a small per-message overhead for role/separator tokens.
    return max(1, (len(text) + 3) // 4)


def message_tokens(m: Message | ChatMessage) -> int:
    """Per-message cost, including a small structural overhead (role tag etc)."""
    return estimate_tokens(getattr(m, "content", "")) + 8


def tool_schemas_tokens(schemas: list[ToolSchema]) -> int:
    """Estimate the JSON-schema overhead the provider will inline."""
    if not schemas:
        return 0
    total = 0
    for s in schemas:
        total += estimate_tokens(s.name)
        total += estimate_tokens(s.description)
        # `parameters` is a JSON-schema dict; rough size = its repr length.
        total += estimate_tokens(repr(s.parameters))
    return total


def fit_budget(
    messages: list[Message],
    cfg: MemoryConfig,
    *,
    system_prompt_tokens: int,
    tool_overhead: int = 0,
    current_user_prompt_tokens: int = 0,
) -> tuple[list[Message], list[Message], MemoryStats]:
    """Return ``(kept, dropped, stats)``.

    ``kept`` is the prefix of the working history that fits the budget;
    ``dropped`` is everything pushed out (oldest first). The caller is
    responsible for converting ``kept`` into ``ChatMessage`` and prepending
    the system prompt.

    Strategy:
      1. Compute a hard budget = ``context_window − output_reserve − tool_overhead
         − system_prompt − current_user_prompt − summary_reserve``.
      2. Always try to keep the last ``working_window`` messages.
      3. If that alone overflows, evict from the front of the working window
         until it fits — the oldest turns become ``dropped`` for Phase-3
         summarisation.
      4. Otherwise, walk older messages newest-first and keep what still
         fits, so a partial transcript survives instead of nothing.
    """
    overhead = max(tool_overhead, cfg.tool_overhead_floor)
    budget = (
        cfg.context_window
        - cfg.output_reserve
        - overhead
        - system_prompt_tokens
        - current_user_prompt_tokens
        - cfg.summary_reserve
    )
    if budget < 0:
        # Pathological config — nothing fits. Return empty kept set so the
        # caller can still send the new prompt without prior history.
        budget = 0

    total_messages = len(messages)
    if cfg.working_window > 0 and total_messages > cfg.working_window:
        working = list(messages[-cfg.working_window :])
        older = list(messages[: -cfg.working_window])
    else:
        working = list(messages)
        older = []

    # Step 1: shrink working window from the front until it fits.
    working_tokens = sum(message_tokens(m) for m in working)
    while working and working_tokens > budget:
        evicted = working.pop(0)
        working_tokens -= message_tokens(evicted)
        older.append(evicted)

    # Step 2: backfill with as many older messages as still fit, newest first.
    remaining = budget - working_tokens
    kept_older: list[Message] = []
    for m in reversed(older):
        cost = message_tokens(m)
        if cost > remaining:
            break
        kept_older.insert(0, m)
        remaining -= cost

    kept = kept_older + working
    dropped_set = {id(m) for m in kept}
    dropped = [m for m in messages if id(m) not in dropped_set]

    tokens_used = (
        system_prompt_tokens
        + overhead
        + cfg.output_reserve
        + cfg.summary_reserve
        + current_user_prompt_tokens
        + sum(message_tokens(m) for m in kept)
    )
    stats = MemoryStats(
        context_window=cfg.context_window,
        tokens_used=tokens_used,
        tokens_available=max(0, cfg.context_window - tokens_used),
        messages_in_context=len(kept),
        total_messages=total_messages,
        dropped_messages=len(dropped),
    )
    return kept, dropped, stats
