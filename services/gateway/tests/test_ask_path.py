"""Unit tests for Ask Mode execution (task 4.2, R2.3–R2.6).

These example-based tests pin the Ask-path execution contract added in task
4.2 on top of the routing fixed in task 4.1:

- Steering is compiled and RAG extraction is run into the context payload
  *before* the Ask response is generated (R2.5, R2.6).
- An edit/implementation request returns a switch-to-Agent message without
  generating a response and without touching the workspace (R2.4).
- A :class:`ReadOnlyViolation` raised while generating is converted into an
  error naming the rejected operation type, workspace untouched (R2.3).

The exhaustive read-only property lives in the dedicated property test (task
4.4, Property 9); the Ask-streaming/first-chunk example is task 4.5.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from zocai_gateway.context.rag_matcher import RagFragment, RagMatcher
from zocai_gateway.mode_router import (
    SWITCH_TO_AGENT_MESSAGE,
    AgentRunRequest,
    AskContext,
    AskError,
    AskPath,
    AskResponse,
    Mode,
    SwitchToAgentMessage,
    build_ask_context,
    is_edit_request,
)
from zocai_gateway.toolsets import ReadOnlyViolation


# --- Test doubles -----------------------------------------------------------


class _RecordingRagMatcher:
    """A RAG_Matcher double that records queries and returns fixed fragments."""

    def __init__(self, fragments: tuple[RagFragment, ...] = ()) -> None:
        self.fragments = fragments
        self.queries: list[str] = []

    def extract(self, query: str) -> tuple[RagFragment, ...]:
        self.queries.append(query)
        return self.fragments


def _ask(prompt: str) -> AgentRunRequest:
    return AgentRunRequest(prompt=prompt, mode=Mode.ASK)


def _write_steering(workspace: Path, name: str, content: str) -> None:
    steering_dir = workspace / ".zoc" / "steering"
    steering_dir.mkdir(parents=True, exist_ok=True)
    (steering_dir / name).write_text(content, encoding="utf-8")


# --- is_edit_request (R2.4 classifier) --------------------------------------


@pytest.mark.parametrize(
    "prompt",
    [
        "implement a binary search",
        "create a new module for auth",
        "please create a config file",
        "can you add a logging helper",
        "could you fix the failing test",
        "I want you to write unit tests",
        "refactor the parser",
        "delete the unused import",
        "Edit the README to add a section",
        "rename the variable foo to bar",
    ],
)
def test_is_edit_request_true_for_edit_intents(prompt: str) -> None:
    assert is_edit_request(prompt) is True


@pytest.mark.parametrize(
    "prompt",
    [
        "how do I implement a binary search?",
        "what does this function do?",
        "why is the build slow?",
        "explain the architecture",
        "describe how the allocator picks a tier",
        "where is the FSM defined?",
        "is this thread safe?",
        "summarize the design doc",
        "",
        "   ",
    ],
)
def test_is_edit_request_false_for_questions(prompt: str) -> None:
    assert is_edit_request(prompt) is False


# --- build_ask_context (R2.5, R2.6) -----------------------------------------


def test_build_ask_context_compiles_steering_and_runs_rag(tmp_path: Path) -> None:
    _write_steering(tmp_path, "00-rules.md", "Be concise.")
    fragments = (RagFragment(path="src/a.py", content="def a(): ...", score=0.9),)
    matcher = _RecordingRagMatcher(fragments)

    context = build_ask_context(
        "how does a work?", workspace_root=tmp_path, rag_matcher=matcher
    )

    assert isinstance(context, AskContext)
    assert context.steering.text == "Be concise."
    assert context.rag_fragments == fragments
    assert matcher.queries == ["how does a work?"]


def test_build_ask_context_defaults_to_null_matcher(tmp_path: Path) -> None:
    context = build_ask_context("anything", workspace_root=tmp_path)
    assert context.rag_fragments == ()
    assert context.steering.fragments == ()


# --- AskPath.execute outcomes -----------------------------------------------


def test_execute_returns_response_for_a_question(tmp_path: Path) -> None:
    _write_steering(tmp_path, "rules.md", "steer")
    matcher = _RecordingRagMatcher(
        (RagFragment(path="m.py", content="x", score=0.8),)
    )
    seen: dict[str, AskContext] = {}

    def generate(prompt: str, context: AskContext) -> str:
        seen["ctx"] = context
        return f"answer to {prompt}"

    path = AskPath()
    result = path.execute(
        _ask("what is this?"),
        generate=generate,
        workspace_root=tmp_path,
        rag_matcher=matcher,
    )

    assert isinstance(result, AskResponse)
    assert result.text == "answer to what is this?"
    # R2.5/R2.6: steering + RAG were compiled BEFORE generation and handed in.
    assert seen["ctx"].steering.text == "steer"
    assert seen["ctx"].rag_fragments == matcher.fragments
    assert matcher.queries == ["what is this?"]


def test_execute_switches_to_agent_for_edit_request_without_generating(
    tmp_path: Path,
) -> None:
    matcher = _RecordingRagMatcher()
    generate_calls: list[str] = []

    def generate(prompt: str, context: AskContext) -> str:
        generate_calls.append(prompt)
        return "should not be called"

    path = AskPath()
    result = path.execute(
        _ask("implement the cache layer"),
        generate=generate,
        workspace_root=tmp_path,
        rag_matcher=matcher,
    )

    assert isinstance(result, SwitchToAgentMessage)
    assert result.message == SWITCH_TO_AGENT_MESSAGE
    # No response is generated for an edit request (R2.4) ...
    assert generate_calls == []
    # ... but steering + RAG were still compiled first (R2.5, R2.6).
    assert matcher.queries == ["implement the cache layer"]


def test_execute_switch_to_agent_leaves_workspace_untouched(tmp_path: Path) -> None:
    sentinel = tmp_path / "keep.txt"
    sentinel.write_text("original", encoding="utf-8")
    before = sorted(p.name for p in tmp_path.iterdir())

    def generate(prompt: str, context: AskContext) -> str:  # pragma: no cover
        raise AssertionError("generate must not run for an edit request")

    path = AskPath()
    result = path.execute(
        _ask("create a new file please"),
        generate=generate,
        workspace_root=tmp_path,
    )

    assert isinstance(result, SwitchToAgentMessage)
    # R2.4: no file, directory, or workspace state changed.
    assert sentinel.read_text(encoding="utf-8") == "original"
    assert sorted(p.name for p in tmp_path.iterdir()) == before


def test_execute_converts_read_only_violation_to_error(tmp_path: Path) -> None:
    sentinel = tmp_path / "keep.txt"
    sentinel.write_text("original", encoding="utf-8")

    def generate(prompt: str, context: AskContext) -> str:
        # A mutating attempt reaching the read-only boundary.
        raise ReadOnlyViolation("write_file")

    path = AskPath()
    result = path.execute(
        _ask("tell me about the design"),
        generate=generate,
        workspace_root=tmp_path,
    )

    assert isinstance(result, AskError)
    # R2.3: the error names the rejected operation type ...
    assert result.operation == "write_file"
    assert "write_file" in result.message
    # ... and the workspace is left untouched.
    assert sentinel.read_text(encoding="utf-8") == "original"


def test_ask_path_satisfies_rag_matcher_protocol() -> None:
    # The recording double is a structural RagMatcher (sanity check).
    matcher: RagMatcher = _RecordingRagMatcher()
    assert isinstance(matcher, RagMatcher)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-v"]))
