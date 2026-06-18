"""Example tests for Ask streaming and the switch-to-Agent instruction (task 4.5).

These example-based tests pin three observable behaviours of the Ask path,
exercising :meth:`zocai_gateway.mode_router.AskPath.execute` together with the
Ask-Mode text-only bus (:class:`zocai_gateway.channel.AskChannel`):

- **First chunk emitted (R2.2).** An Ask answer is streamed as markdown text
  token chunks over the Ask channel, and the *first* chunk is emitted (and
  reaches the bus first), so a Developer sees output begin before the full
  answer is assembled.
- **Switch-to-Agent on edit requests (R2.4).** An edit/implementation request
  returns the switch-to-Agent message without generating or streaming any
  answer and without touching the workspace.
- **Steering + RAG compiled first (R2.5, R2.6).** Steering is compiled and RAG
  extraction is run into the context payload *before* the response is
  generated, for both the answer and the switch-to-Agent outcomes.

The exhaustive read-only property is the dedicated property test (task 4.4,
Property 9); the first-chunk latency bound is the timing check (task 4.6).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from zocai_gateway.channel import AskChannel
from zocai_gateway.context.rag_matcher import RagFragment
from zocai_gateway.mode_router import (
    SWITCH_TO_AGENT_MESSAGE,
    AgentRunRequest,
    AskContext,
    AskPath,
    AskResponse,
    Mode,
    SwitchToAgentMessage,
)


# --- Test doubles -----------------------------------------------------------


class _CollectingTextSink:
    """The Ask-Mode bus end: records raw markdown text token chunks in order."""

    def __init__(self) -> None:
        self.chunks: list[str] = []

    def __call__(self, chunk: str) -> None:
        self.chunks.append(chunk)


class _OrderRecordingRagMatcher:
    """A RAG_Matcher double that appends to a shared op-order log on extract.

    Lets a test assert that RAG extraction ran *before* response generation by
    comparing the order of recorded operations.
    """

    def __init__(
        self, log: list[str], fragments: tuple[RagFragment, ...] = ()
    ) -> None:
        self._log = log
        self.fragments = fragments
        self.queries: list[str] = []

    def extract(self, query: str) -> tuple[RagFragment, ...]:
        self._log.append("rag-extract")
        self.queries.append(query)
        return self.fragments


def _ask(prompt: str) -> AgentRunRequest:
    return AgentRunRequest(prompt=prompt, mode=Mode.ASK)


def _write_steering(workspace: Path, name: str, content: str) -> None:
    steering_dir = workspace / ".zoc" / "steering"
    steering_dir.mkdir(parents=True, exist_ok=True)
    (steering_dir / name).write_text(content, encoding="utf-8")


# --- R2.2: Ask answer streams, first chunk emitted --------------------------


def test_ask_response_streams_chunks_and_emits_first_chunk(tmp_path: Path) -> None:
    _write_steering(tmp_path, "00-rules.md", "Be concise.")
    matcher = _OrderRecordingRagMatcher(
        log=[],
        fragments=(RagFragment(path="a.py", content="def a(): ...", score=0.9),),
    )
    sink = _CollectingTextSink()
    channel = AskChannel(sink)
    answer_chunks = ["# Answer\n", "It ", "works", "."]

    def generate(prompt: str, context: AskContext) -> str:
        # The answer is produced as token chunks and streamed as it is built,
        # so the first chunk leaves the bus before the whole answer exists.
        for chunk in answer_chunks:
            channel.emit_text(chunk)
        return "".join(answer_chunks)

    path = AskPath()
    result = path.execute(
        _ask("how does a work?"),
        generate=generate,
        workspace_root=tmp_path,
        rag_matcher=matcher,
    )

    assert isinstance(result, AskResponse)
    # R2.2: a first chunk was emitted, and it reached the bus first, in order.
    assert sink.chunks, "expected at least one streamed text chunk"
    assert sink.chunks[0] == "# Answer\n"
    assert sink.chunks == answer_chunks
    # The assembled answer matches the concatenation of the streamed chunks.
    assert result.text == "# Answer\nIt works."


def test_ask_first_chunk_emitted_before_remaining_chunks(tmp_path: Path) -> None:
    matcher = _OrderRecordingRagMatcher(log=[])
    sink = _CollectingTextSink()
    channel = AskChannel(sink)

    def generate(prompt: str, context: AskContext) -> str:
        channel.emit_text("first ")
        # At this point only the first chunk has reached the bus (R2.2): the
        # Developer sees output begin before the rest is produced.
        assert sink.chunks == ["first "]
        channel.emit_text("second")
        return "first second"

    path = AskPath()
    result = path.execute(
        _ask("what is this?"),
        generate=generate,
        workspace_root=tmp_path,
        rag_matcher=matcher,
    )

    assert isinstance(result, AskResponse)
    assert sink.chunks == ["first ", "second"]


# --- R2.4: edit/implementation request -> switch-to-Agent, no stream --------


def test_edit_request_returns_switch_message_without_streaming(
    tmp_path: Path,
) -> None:
    sentinel = tmp_path / "keep.txt"
    sentinel.write_text("original", encoding="utf-8")
    before = sorted(p.name for p in tmp_path.iterdir())

    matcher = _OrderRecordingRagMatcher(log=[])
    sink = _CollectingTextSink()
    channel = AskChannel(sink)

    def generate(prompt: str, context: AskContext) -> str:  # pragma: no cover
        raise AssertionError("generate must not run for an edit request")

    path = AskPath()
    result = path.execute(
        _ask("implement the cache layer"),
        generate=generate,
        workspace_root=tmp_path,
        rag_matcher=matcher,
    )

    assert isinstance(result, SwitchToAgentMessage)
    assert result.message == SWITCH_TO_AGENT_MESSAGE
    # R2.4: no answer streamed, and no file/directory/workspace state changed.
    assert sink.chunks == []
    assert sentinel.read_text(encoding="utf-8") == "original"
    assert sorted(p.name for p in tmp_path.iterdir()) == before


# --- R2.5, R2.6: steering + RAG compiled BEFORE the response is generated ---


def test_steering_and_rag_compiled_before_generation(tmp_path: Path) -> None:
    _write_steering(tmp_path, "00-rules.md", "Be concise.")
    log: list[str] = []
    matcher = _OrderRecordingRagMatcher(
        log=log,
        fragments=(RagFragment(path="a.py", content="def a(): ...", score=0.9),),
    )

    def generate(prompt: str, context: AskContext) -> str:
        log.append("generate")
        # The context handed to generation already carries compiled steering
        # (R2.5) and the RAG-extracted fragments (R2.6).
        assert context.steering.text == "Be concise."
        assert context.rag_fragments == matcher.fragments
        return "answer"

    path = AskPath()
    result = path.execute(
        _ask("how does a work?"),
        generate=generate,
        workspace_root=tmp_path,
        rag_matcher=matcher,
    )

    assert isinstance(result, AskResponse)
    # R2.5/R2.6: RAG extraction (and steering compilation) ran before generation.
    assert log == ["rag-extract", "generate"]


def test_steering_and_rag_compiled_first_even_for_switch_to_agent(
    tmp_path: Path,
) -> None:
    _write_steering(tmp_path, "00-rules.md", "Be concise.")
    log: list[str] = []
    matcher = _OrderRecordingRagMatcher(log=log)

    def generate(prompt: str, context: AskContext) -> str:  # pragma: no cover
        raise AssertionError("generate must not run for an edit request")

    path = AskPath()
    result = path.execute(
        _ask("create a new module"),
        generate=generate,
        workspace_root=tmp_path,
        rag_matcher=matcher,
    )

    assert isinstance(result, SwitchToAgentMessage)
    # Steering + RAG are still compiled first (R2.5, R2.6); generation is then
    # skipped for the edit request (R2.4), so no "generate" op is recorded.
    assert log == ["rag-extract"]
    assert matcher.queries == ["create a new module"]
    assert result.context.steering.text == "Be concise."


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-v"]))
