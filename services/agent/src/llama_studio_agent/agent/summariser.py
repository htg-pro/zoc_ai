"""Episodic memory: compress dropped messages into a running summary.

Phase 3 of the conversation-memory plan. When `fit_budget` evicts older
messages from the working window, this module turns them into a compact
narrative the model can reuse on subsequent turns. The summary is
persisted per-session so it survives sidecar restarts.

Design choices:
  - Incremental: extends the prior summary instead of re-summarising the
    full transcript every turn. The repo stores the most-recent message id
    we've already covered (`covers_up_to_message_id`); we only feed
    messages newer than that into the summariser.
  - Provider-agnostic: takes the same `LLMProvider` the orchestrator uses,
    so cloud and local backends both work.
  - Best-effort: on any provider error we log and skip — the working
    window alone is still a usable conversation, just less informative.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING
from uuid import UUID

from shared_schema.models import Message, MessageRole

from ..providers.base import ChatMessage, ChatRequest, LLMProvider, ProviderError
from .memory import estimate_tokens

if TYPE_CHECKING:
    from ..persistence import SessionRepository


SUMMARY_SYSTEM_PROMPT = (
    "You are a conversation compactor. Given a chunk of an ongoing chat"
    " between a user and a coding assistant, produce a compressed summary"
    " that preserves only what later turns will need to stay coherent:\n"
    "  - User goals and explicit preferences.\n"
    "  - Decisions made and tradeoffs accepted.\n"
    "  - Files, functions, identifiers, or commands referenced.\n"
    "  - Errors encountered and the fixes that worked.\n"
    "Output 4-8 terse bullet points. No preamble, no apology, no markdown"
    " headers. If a prior summary is provided, MERGE it with the new chunk"
    " — do not just append; deduplicate, keep the most-recent fact when"
    " they conflict, drop anything no longer relevant."
)


@dataclass(slots=True)
class SummariserConfig:
    """Knobs for the summariser. Defaults aim for ~400 tokens of output."""

    max_tokens: int = 512
    temperature: float = 0.0
    # Hard cap on the summariser's input chunk: keep the prompt itself
    # within this many tokens so the summarisation call doesn't itself
    # blow the context window. We slice from the start of the dropped
    # chunk and rely on the next turn's call to backfill any leftover.
    input_token_budget: int = 6000


@dataclass(slots=True)
class SummaryUpdate:
    """Result of a summarisation pass. ``None`` summary means no-op."""

    summary: str
    covers_up_to_message_id: UUID
    token_estimate: int


def _trim_chunk(messages: list[Message], budget: int) -> list[Message]:
    """Take messages from the front until we hit the token budget.

    Older context is more compressible and arguably more important to
    summarise (it's about to be forgotten); newer dropped messages can
    wait for the next pass.
    """
    out: list[Message] = []
    used = 0
    for m in messages:
        cost = estimate_tokens(m.content) + 8
        if used + cost > budget:
            break
        out.append(m)
        used += cost
    return out


def _format_chunk(messages: list[Message], prior_summary: str | None) -> str:
    """Render the input prompt for the summariser model."""
    parts: list[str] = []
    if prior_summary:
        parts.append(f"Prior summary:\n{prior_summary}")
    parts.append("New conversation chunk to fold in:")
    for m in messages:
        # Cap each line so a single long tool result doesn't dominate.
        content = m.content if len(m.content) < 1200 else m.content[:1200] + "…"
        parts.append(f"[{m.role.value}] {content}")
    return "\n\n".join(parts)


async def summarise_messages(
    *,
    provider: LLMProvider,
    model: str,
    messages: list[Message],
    prior_summary: str | None,
    cfg: SummariserConfig | None = None,
) -> str | None:
    """Run one summarisation pass. Returns the new running summary, or
    ``None`` if there's nothing to do or the provider failed."""
    if not messages:
        return prior_summary
    cfg = cfg or SummariserConfig()
    chunk = _trim_chunk(messages, cfg.input_token_budget)
    if not chunk:
        return prior_summary
    user_text = _format_chunk(chunk, prior_summary)
    request = ChatRequest(
        messages=[
            ChatMessage(role="system", content=SUMMARY_SYSTEM_PROMPT),
            ChatMessage(role="user", content=user_text),
        ],
        model=model,
        temperature=cfg.temperature,
        max_tokens=cfg.max_tokens,
    )
    try:
        response = await provider.chat(request)
    except ProviderError:
        return None
    text = (response.text or "").strip()
    if not text:
        return None
    return text


async def update_session_summary(
    *,
    repo: SessionRepository,
    provider: LLMProvider,
    model: str,
    session_id: UUID,
    dropped: list[Message],
    cfg: SummariserConfig | None = None,
) -> SummaryUpdate | None:
    """End-to-end: load prior summary, summarise newly-dropped messages
    not yet covered by it, persist the new summary, return it.

    Idempotent: if `dropped` only contains messages already covered by the
    existing summary, this is a no-op and returns the cached value.
    """
    if not dropped:
        return None
    existing = repo.get_summary(session_id)
    prior_summary = existing["summary"] if existing else None
    last_covered = (
        UUID(existing["covers_up_to_message_id"]) if existing else None
    )

    # Skip messages already folded into the prior summary. Messages are
    # ordered by created_at, so once we've seen `last_covered` we know
    # everything newer is fresh.
    new_messages: list[Message] = []
    if last_covered is None:
        new_messages = list(dropped)
    else:
        seen = False
        for m in dropped:
            if seen:
                new_messages.append(m)
            elif m.id == last_covered:
                seen = True
        if not seen:
            # `last_covered` predates this batch — everything in `dropped`
            # is new (i.e. older but still uncovered).
            new_messages = list(dropped)

    if not new_messages:
        return None

    summary_text = await summarise_messages(
        provider=provider,
        model=model,
        messages=new_messages,
        prior_summary=prior_summary,
        cfg=cfg,
    )
    if summary_text is None:
        return None

    covers_up_to = new_messages[-1].id
    token_estimate = estimate_tokens(summary_text)
    repo.upsert_summary(
        session_id,
        summary=summary_text,
        covers_up_to_message_id=covers_up_to,
        token_estimate=token_estimate,
    )
    return SummaryUpdate(
        summary=summary_text,
        covers_up_to_message_id=covers_up_to,
        token_estimate=token_estimate,
    )


def summary_as_chat_message(summary: str) -> ChatMessage:
    """Render the running summary into a system message the orchestrator
    can prepend to history. Tagged so the model knows it's a digest, not
    fresh instruction."""
    return ChatMessage(
        role="system",
        content=(
            "[Conversation summary — older turns compressed]\n" + summary.strip()
        ),
    )


def summary_message_role() -> MessageRole:  # pragma: no cover — helper export
    return MessageRole.system
