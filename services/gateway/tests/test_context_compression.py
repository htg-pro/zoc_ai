"""Unit tests for intelligent context compression (§2.2).

Covers the token-counting helpers, the tier→tokenizer mapping, the
``model_summarizer`` adapter, and — the core of the feature — the four-step
``ConversationMemory.compress`` contract:

1. count the full history's tokens,
2. no-op below ``max_tokens * 0.7``,
3. preserve the system prompt + last four turns + current-stage tool results
   while summarising the middle into one ``[COMPRESSED HISTORY]`` message and
   emitting a :class:`ContextCompressedEvent`,
4. be idempotent on an already-compressed history.

Token counts use the deterministic LOCAL (4-chars/token) tokenizer so the
assertions are exact and platform-independent.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from zocai_gateway.memory.matrix import (
    COMPRESSED_HISTORY_PREFIX,
    COMPRESSION_TRIGGER_RATIO,
    PRESERVED_TAIL_TURNS,
    SUMMARY_INSTRUCTION,
    CompressionError,
    ContextCompressedEvent,
    ConversationMemory,
    Message,
    Role,
    TokenizerKind,
    count_history_tokens,
    count_tokens,
    model_summarizer,
    tokenizer_kind_for_tier,
)
from zocai_gateway.model_interface import (
    ModelRequest,
    ModelResponse,
    ModelTier,
    TokenChunk,
)

_LOCAL = TokenizerKind.LOCAL


def _fill(tag: str, length: int = 40) -> str:
    """A unique message body of exactly ``length`` chars (for exact token math).

    Under the LOCAL tokenizer a 40-char body is ceil(40/4) = 10 tokens and a
    20-char body is 5 tokens.
    """
    return tag.ljust(length, "x")[:length]


class _RecordingModel:
    """Minimal :class:`ModelInterface` stub: echoes a reply, records requests."""

    def __init__(self, reply: str = "SUMMARY", window: int = 128_000) -> None:
        self.reply = reply
        self._window = window
        self.requests: list[ModelRequest] = []

    def generate(self, req: ModelRequest) -> ModelResponse:
        self.requests.append(req)
        return ModelResponse(text=self.reply, tier=ModelTier.CLOUD)

    def stream(self, req: ModelRequest) -> Iterator[TokenChunk]:
        yield TokenChunk(text=self.reply, done=True)

    @property
    def tier(self) -> ModelTier:
        return ModelTier.CLOUD

    @property
    def context_window(self) -> int:
        return self._window


def _over_threshold_history() -> list[Message]:
    """A history that trips compression at ``max_tokens=100`` (105 LOCAL tokens).

    Layout (index: role/stage): 0 system prompt; 1-2 ANALYZE user/assistant;
    3 ANALYZE tool_result (old stage); 4-5 APPLY user/assistant; 6 APPLY
    tool_result (current stage); 7-10 APPLY user/assistant (the recent tail).
    """
    return [
        Message(Role.SYSTEM, _fill("sys", 20)),  # 0 — prefix, 5 tok
        Message(Role.USER, _fill("u1", 40), "ANALYZE"),  # 1 — middle
        Message(Role.ASSISTANT, _fill("a1", 40), "ANALYZE"),  # 2 — middle
        Message(Role.TOOL_RESULT, _fill("told", 40), "ANALYZE"),  # 3 — middle
        Message(Role.USER, _fill("u2", 40), "APPLY"),  # 4 — middle
        Message(Role.ASSISTANT, _fill("a2", 40), "APPLY"),  # 5 — middle
        Message(Role.TOOL_RESULT, _fill("tcur", 40), "APPLY"),  # 6 — current tool
        Message(Role.USER, _fill("u3", 40), "APPLY"),  # 7 — tail
        Message(Role.ASSISTANT, _fill("a3", 40), "APPLY"),  # 8 — tail
        Message(Role.USER, _fill("u4", 40), "APPLY"),  # 9 — tail
        Message(Role.ASSISTANT, _fill("a4", 40), "APPLY"),  # 10 — tail
    ]


# -- token counting (step 1) ------------------------------------------------


def test_count_tokens_empty_is_zero() -> None:
    assert count_tokens("", TokenizerKind.LOCAL) == 0
    assert count_tokens("", TokenizerKind.GPT) == 0


def test_count_tokens_local_uses_four_chars_per_token() -> None:
    assert count_tokens("x" * 8, _LOCAL) == 2
    assert count_tokens("x" * 9, _LOCAL) == 3  # rounds up


def test_count_tokens_gpt_is_positive_and_deterministic() -> None:
    # Works whether tiktoken is installed (exact) or not (char-estimate fallback).
    first = count_tokens("hello world", TokenizerKind.GPT)
    assert first > 0
    assert count_tokens("hello world", TokenizerKind.GPT) == first


def test_count_history_tokens_sums_message_contents() -> None:
    messages = [
        Message(Role.SYSTEM, _fill("s", 20)),
        Message(Role.USER, _fill("u", 40)),
    ]
    expected = count_tokens(messages[0].content, _LOCAL) + count_tokens(messages[1].content, _LOCAL)
    assert count_history_tokens(messages, _LOCAL) == expected == 15


def test_tokenizer_kind_for_tier() -> None:
    assert tokenizer_kind_for_tier(ModelTier.LOCAL_SLM) is TokenizerKind.LOCAL
    assert tokenizer_kind_for_tier(ModelTier.EDGE) is TokenizerKind.GPT
    assert tokenizer_kind_for_tier(ModelTier.CLOUD) is TokenizerKind.GPT


# -- model_summarizer adapter (step 3b) -------------------------------------


def test_model_summarizer_calls_model_deterministically() -> None:
    model = _RecordingModel(reply="THE SUMMARY")
    summarise = model_summarizer(model)

    out = summarise("please summarise this")

    assert out == "THE SUMMARY"
    assert len(model.requests) == 1
    request = model.requests[0]
    assert request.prompt == "please summarise this"
    assert request.temperature == 0.0  # deterministic
    assert request.max_tokens == 400  # default safety ceiling
    assert request.context_window == model.context_window


def test_model_summarizer_honours_window_and_token_overrides() -> None:
    model = _RecordingModel()
    summarise = model_summarizer(model, context_window=2048, max_tokens=128)

    summarise("prompt")

    request = model.requests[0]
    assert request.context_window == 2048
    assert request.max_tokens == 128


# -- compress: below the trigger (step 2) -----------------------------------


def test_under_threshold_returns_none_and_leaves_history_unchanged() -> None:
    memory = ConversationMemory(
        messages=[
            Message(Role.SYSTEM, _fill("s", 8)),
            Message(Role.USER, _fill("u", 8), "ANALYZE"),
            Message(Role.ASSISTANT, _fill("a", 8), "ANALYZE"),
        ],
        tokenizer_kind=_LOCAL,
        summarizer=lambda _prompt: "unused",
    )
    before = list(memory.messages)

    # 6 tokens total, well under 1000 * 0.7 = 700.
    assert memory.compress(1000) is None
    assert memory.messages == before


def test_trigger_ratio_is_seventy_percent() -> None:
    assert COMPRESSION_TRIGGER_RATIO == 0.7


# -- compress: above the trigger (step 3) -----------------------------------


def test_over_threshold_preserves_prompt_tail_and_current_stage_tool() -> None:
    memory = ConversationMemory(
        messages=_over_threshold_history(),
        tokenizer_kind=_LOCAL,
        summarizer=lambda _prompt: "SUMMARY",
    )
    original = list(memory.messages)

    event = memory.compress(100)

    assert event is not None
    # The middle (indices 1-5, including the old ANALYZE tool_result) collapses
    # into exactly one [COMPRESSED HISTORY] system message.
    assert len(memory.messages) == 7

    # System prompt preserved verbatim at the head.
    assert memory.messages[0] == original[0]

    # The synthetic compressed message replaces the middle.
    compressed = memory.messages[1]
    assert compressed.role is Role.SYSTEM
    assert compressed.content == f"{COMPRESSED_HISTORY_PREFIX} SUMMARY"
    assert compressed.content.startswith(COMPRESSED_HISTORY_PREFIX)

    # Current-stage (APPLY) tool_result is preserved; last four turns are kept
    # verbatim and in order.
    assert memory.messages[2] == original[6]  # APPLY tool_result
    assert memory.messages[3:] == original[7:11]  # last 4 user/assistant turns
    assert len(original[7:11]) == PRESERVED_TAIL_TURNS

    # The summarised middle is gone: older turns and the old-stage tool_result.
    for gone in (original[1], original[2], original[3], original[4], original[5]):
        assert gone not in memory.messages


def test_summary_prompt_uses_instruction_and_only_the_middle() -> None:
    captured: dict[str, str] = {}

    def recording_summarizer(prompt: str) -> str:
        captured["prompt"] = prompt
        return "SUMMARY"

    memory = ConversationMemory(
        messages=_over_threshold_history(),
        tokenizer_kind=_LOCAL,
        summarizer=recording_summarizer,
    )
    memory.compress(100)

    prompt = captured["prompt"]
    assert prompt.startswith(SUMMARY_INSTRUCTION)
    # Middle contents are summarised...
    assert _fill("u1", 40) in prompt  # a middle turn
    assert _fill("told", 40) in prompt  # the old-stage tool_result
    # ...preserved messages are NOT sent to the summarizer.
    assert _fill("tcur", 40) not in prompt  # current-stage tool_result
    assert _fill("u3", 40) not in prompt  # a preserved tail turn


def test_compressed_history_shrinks_token_count() -> None:
    memory = ConversationMemory(
        messages=_over_threshold_history(),
        tokenizer_kind=_LOCAL,
        summarizer=lambda _prompt: "SUMMARY",
    )
    original_tokens = count_history_tokens(memory.messages, _LOCAL)

    event = memory.compress(100)

    assert event is not None
    assert event.original_tokens == original_tokens == 105
    assert event.compressed_tokens == count_history_tokens(memory.messages, _LOCAL)
    assert event.compressed_tokens < event.original_tokens


# -- compress: event emission (step 3d) -------------------------------------


def test_emits_context_compressed_event_with_ratio() -> None:
    events: list[ContextCompressedEvent] = []
    memory = ConversationMemory(
        messages=_over_threshold_history(),
        tokenizer_kind=_LOCAL,
        summarizer=lambda _prompt: "SUMMARY",
        emit=events.append,
    )

    event = memory.compress(100)

    assert event is not None
    assert events == [event]
    assert isinstance(event, ContextCompressedEvent)
    expected_ratio = event.compressed_tokens / event.original_tokens
    assert event.compression_ratio == expected_ratio
    assert 0.0 < event.compression_ratio < 1.0


def test_no_event_emitted_when_below_threshold() -> None:
    events: list[ContextCompressedEvent] = []
    memory = ConversationMemory(
        messages=[Message(Role.SYSTEM, _fill("s", 8))],
        tokenizer_kind=_LOCAL,
        summarizer=lambda _prompt: "SUMMARY",
        emit=events.append,
    )

    assert memory.compress(1000) is None
    assert events == []


# -- compress: idempotency (step 4) -----------------------------------------


def test_second_compress_is_a_noop() -> None:
    events: list[ContextCompressedEvent] = []
    memory = ConversationMemory(
        messages=_over_threshold_history(),
        tokenizer_kind=_LOCAL,
        summarizer=lambda _prompt: "SUMMARY",
        emit=events.append,
    )

    first = memory.compress(100)
    assert first is not None
    snapshot = list(memory.messages)

    second = memory.compress(100)

    assert second is None
    assert memory.messages == snapshot  # unchanged
    assert events == [first]  # not re-emitted


def test_already_compressed_history_short_circuits_before_summarizer() -> None:
    # A history that already carries the marker is a no-op even when it is over
    # budget and no summarizer is configured — the marker check comes first.
    memory = ConversationMemory(
        messages=[
            Message(Role.SYSTEM, "system prompt"),
            Message(Role.SYSTEM, f"{COMPRESSED_HISTORY_PREFIX} earlier summary"),
            Message(Role.USER, _fill("u", 400), "APPLY"),
        ],
        tokenizer_kind=_LOCAL,
        summarizer=None,
    )
    before = list(memory.messages)

    assert memory.compress(10) is None
    assert memory.messages == before


# -- compress: error and edge behaviour -------------------------------------


def test_raises_when_summarizer_missing_and_compression_needed() -> None:
    memory = ConversationMemory(
        messages=[
            Message(Role.SYSTEM, _fill("s", 20)),
            *[
                Message(
                    Role.USER if i % 2 == 0 else Role.ASSISTANT,
                    _fill(f"t{i}", 40),
                    "APPLY",
                )
                for i in range(6)
            ],
        ],
        tokenizer_kind=_LOCAL,
        summarizer=None,
    )

    with pytest.raises(CompressionError):
        memory.compress(10)


def test_nothing_in_middle_returns_none_even_over_threshold() -> None:
    # System prompt + only two turns: both fall inside the preserved tail, so
    # there is no middle to summarise even though the history is over budget.
    memory = ConversationMemory(
        messages=[
            Message(Role.SYSTEM, _fill("s", 200)),
            Message(Role.USER, _fill("u", 200), "APPLY"),
            Message(Role.ASSISTANT, _fill("a", 200), "APPLY"),
        ],
        tokenizer_kind=_LOCAL,
        summarizer=lambda _prompt: "SUMMARY",
    )
    before = list(memory.messages)

    # 150 tokens >= 100 * 0.7, so the trigger fires, but the middle is empty.
    assert memory.compress(100) is None
    assert memory.messages == before


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-v"]))
