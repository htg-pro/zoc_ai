"""Property-based coverage for intelligent conversation compression."""

from __future__ import annotations

import math

from hypothesis import given, settings
from hypothesis import strategies as st
from zocai_gateway.memory.matrix import (
    COMPRESSED_HISTORY_PREFIX,
    ContextCompressedEvent,
    ConversationMemory,
    Message,
    Role,
    TokenizerKind,
    count_history_tokens,
    count_tokens,
)

_LOCAL = TokenizerKind.LOCAL


@settings(max_examples=100, deadline=None)
@given(
    text=st.text(max_size=500),
    contents=st.lists(st.text(max_size=120), max_size=30),
)
def test_local_counting_is_char_quarters_and_history_additive(
    text: str, contents: list[str]
) -> None:
    """Feature: advanced-context-engine, Property 11: local token additivity.

    **Validates: Requirements 7.2, 7.4**
    """
    assert count_tokens(text, _LOCAL) == math.ceil(len(text) / 4)
    messages = [Message(Role.USER, content, "ANALYZE") for content in contents]
    assert count_history_tokens(messages, _LOCAL) == sum(
        math.ceil(len(content) / 4) for content in contents
    )
    if not messages:
        assert count_history_tokens(messages, _LOCAL) == 0


def _exact_token_history(total_tokens: int) -> list[Message]:
    """Build prompt + one large middle + four tail turns with an exact count."""
    middle_tokens = total_tokens - 5
    assert middle_tokens > 0
    return [
        Message(Role.SYSTEM, "s" * 4),
        Message(Role.USER, "m" * (middle_tokens * 4), "ANALYZE"),
        Message(Role.USER, "1" * 4, "APPLY"),
        Message(Role.ASSISTANT, "2" * 4, "APPLY"),
        Message(Role.USER, "3" * 4, "APPLY"),
        Message(Role.ASSISTANT, "4" * 4, "APPLY"),
    ]


@settings(max_examples=100, deadline=None)
@given(multiplier=st.integers(min_value=5, max_value=80))
def test_compression_triggers_exactly_at_seventy_percent(
    multiplier: int,
) -> None:
    """Feature: advanced-context-engine, Property 12: exact 0.7 trigger.

    **Validates: Requirements 8.1, 8.2**
    """
    limit = 10 * multiplier

    below = ConversationMemory(
        messages=_exact_token_history(7 * multiplier - 1),
        tokenizer_kind=_LOCAL,
        summarizer=lambda _prompt: "summary",
    )
    before = list(below.messages)
    assert below.compress(limit) is None
    assert below.messages == before

    at_threshold = ConversationMemory(
        messages=_exact_token_history(7 * multiplier),
        tokenizer_kind=_LOCAL,
        summarizer=lambda _prompt: "summary",
    )
    event = at_threshold.compress(limit)
    assert event is not None
    assert any(
        message.content.startswith(COMPRESSED_HISTORY_PREFIX)
        for message in at_threshold.messages
    )


@settings(max_examples=100, deadline=None)
@given(
    system_count=st.integers(min_value=1, max_value=3),
    old_count=st.integers(min_value=1, max_value=5),
    current_tool_count=st.integers(min_value=1, max_value=3),
    turn_count=st.integers(min_value=0, max_value=8),
)
def test_compression_preserves_prompt_recent_turns_and_current_tools(
    system_count: int,
    old_count: int,
    current_tool_count: int,
    turn_count: int,
) -> None:
    """Feature: advanced-context-engine, Property 13: preservation.

    **Validates: Requirements 8.3, 8.4, 8.5, 8.6**
    """
    systems = [Message(Role.SYSTEM, f"system-{index}") for index in range(system_count)]
    old = [
        Message(Role.TOOL_RESULT, f"old-{index}-" + "x" * 120, "ANALYZE")
        for index in range(old_count)
    ]
    current_tools = [
        Message(Role.TOOL_RESULT, f"current-{index}", "APPLY")
        for index in range(current_tool_count)
    ]
    turns = [
        Message(
            Role.USER if index % 2 == 0 else Role.ASSISTANT,
            f"turn-{index}",
            "APPLY",
        )
        for index in range(turn_count)
    ]
    original = [*systems, *old, *current_tools, *turns]
    memory = ConversationMemory(
        messages=list(original),
        tokenizer_kind=_LOCAL,
        summarizer=lambda _prompt: "summary",
    )

    assert memory.compress(1) is not None
    assert memory.messages[:system_count] == systems
    marker = memory.messages[system_count]
    assert marker.role is Role.SYSTEM
    assert marker.content.startswith(COMPRESSED_HISTORY_PREFIX)
    assert memory.messages[system_count + 1 :] == [
        *current_tools,
        *turns[-4:],
    ]
    assert all(message not in memory.messages for message in old)


@settings(max_examples=100, deadline=None)
@given(extra_turns=st.integers(min_value=0, max_value=12))
def test_compression_is_idempotent(extra_turns: int) -> None:
    """Feature: advanced-context-engine, Property 14: compression idempotence.

    **Validates: Requirements 10.1, 10.2, 10.3**
    """
    marked_events: list[ContextCompressedEvent] = []
    marked = ConversationMemory(
        messages=[
            Message(Role.SYSTEM, "prompt"),
            Message(Role.SYSTEM, f"{COMPRESSED_HISTORY_PREFIX} existing"),
            *[
                Message(Role.USER, f"turn-{index}", "APPLY")
                for index in range(extra_turns)
            ],
        ],
        tokenizer_kind=_LOCAL,
        summarizer=lambda _prompt: "must not run",
        emit=marked_events.append,
    )
    marked_snapshot = list(marked.messages)
    assert marked.compress(1) is None
    assert marked.messages == marked_snapshot
    assert marked_events == []

    fresh_events: list[ContextCompressedEvent] = []
    fresh = ConversationMemory(
        messages=_exact_token_history(80),
        tokenizer_kind=_LOCAL,
        summarizer=lambda _prompt: "summary",
        emit=fresh_events.append,
    )
    first = fresh.compress(10)
    assert first is not None
    snapshot = list(fresh.messages)
    assert fresh.compress(10) is None
    assert fresh.messages == snapshot
    assert fresh_events == [first]


@settings(max_examples=100, deadline=None)
@given(
    middle_tokens=st.integers(min_value=30, max_value=200),
    summary_size=st.integers(min_value=1, max_value=2000),
)
def test_compression_event_has_consistent_bounded_counts(
    middle_tokens: int, summary_size: int
) -> None:
    """Feature: advanced-context-engine, Property 15: event bounds.

    **Validates: Requirements 11.1, 11.2**
    """
    messages = [
        Message(Role.SYSTEM, "prompt"),
        Message(Role.USER, "m" * (middle_tokens * 4), "ANALYZE"),
        Message(Role.TOOL_RESULT, "current", "APPLY"),
        Message(Role.USER, "one", "APPLY"),
        Message(Role.ASSISTANT, "two", "APPLY"),
        Message(Role.USER, "three", "APPLY"),
        Message(Role.ASSISTANT, "four", "APPLY"),
    ]
    emitted: list[ContextCompressedEvent] = []
    memory = ConversationMemory(
        messages=messages,
        tokenizer_kind=_LOCAL,
        summarizer=lambda _prompt: "z" * summary_size,
        emit=emitted.append,
    )
    original = count_history_tokens(messages, _LOCAL)

    event = memory.compress(1)
    assert event is not None
    assert emitted == [event]
    assert event.original_tokens == original > 0
    assert event.compressed_tokens == count_history_tokens(memory.messages, _LOCAL)
    assert 0 <= event.compressed_tokens <= event.original_tokens
    assert event.compression_ratio == event.compressed_tokens / event.original_tokens
    assert 0 <= event.compression_ratio <= 1
