"""Tests for context-aware Ask Mode (§12.1)."""

from __future__ import annotations

from pathlib import Path

from zocai_gateway.context.rag_matcher import RagFragment
from zocai_gateway.context.steering_compiler import compile_steering
from zocai_gateway.mode_router import (
    ASK_ACTIVE_FILE_CHAR_LIMIT,
    ASK_RAG_TOP_K,
    AgentRunRequest,
    AskContext,
    Mode,
    RequestContext,
    build_ask_context,
)


class _Matcher:
    def __init__(self, fragments: tuple[RagFragment, ...]) -> None:
        self._fragments = fragments

    def extract(self, query: str) -> tuple[RagFragment, ...]:
        return self._fragments


def _fragments(count: int) -> tuple[RagFragment, ...]:
    return tuple(
        RagFragment(path=f"src/f{i}.py", content=f"body {i}", score=1.0 - i / 100)
        for i in range(count)
    )


def _empty_context(**kwargs: object) -> AskContext:
    return AskContext(steering=compile_steering(Path("/nonexistent")), **kwargs)  # type: ignore[arg-type]


# ── request schema ───────────────────────────────────────────────────────────


def test_request_accepts_camel_case_editor_context() -> None:
    request = AgentRunRequest.model_validate(
        {
            "prompt": "what does this do?",
            "mode": "ask",
            "context": {
                "activeFile": "src/app.py",
                "selection": "def handler(): pass",
                "cursorLine": 12,
            },
        }
    )
    assert request.context is not None
    assert request.context.active_file == "src/app.py"
    assert request.context.selection == "def handler(): pass"
    assert request.context.cursor_line == 12


def test_request_context_is_optional() -> None:
    request = AgentRunRequest(prompt="hi", mode=Mode.ASK)
    assert request.context is None


# ── context assembly ─────────────────────────────────────────────────────────


def test_build_ask_context_inlines_the_active_file(tmp_path: Path) -> None:
    (tmp_path / "app.py").write_text("print('hello')\n", encoding="utf-8")

    context = build_ask_context(
        "what does app.py print?",
        workspace_root=tmp_path,
        context=RequestContext(active_file="app.py"),
    )

    assert context.active_file == "app.py"
    assert context.active_file_content == "print('hello')\n"


def test_build_ask_context_truncates_a_large_active_file(tmp_path: Path) -> None:
    (tmp_path / "big.py").write_text("x" * (ASK_ACTIVE_FILE_CHAR_LIMIT + 500), encoding="utf-8")

    context = build_ask_context(
        "explain",
        workspace_root=tmp_path,
        context=RequestContext(active_file="big.py"),
    )

    assert context.active_file_content is not None
    assert context.active_file_content.endswith("… (truncated)")
    assert len(context.active_file_content) < ASK_ACTIVE_FILE_CHAR_LIMIT + 100


def test_build_ask_context_refuses_to_read_outside_the_workspace(tmp_path: Path) -> None:
    secret = tmp_path.parent / "secret.txt"
    secret.write_text("private", encoding="utf-8")
    workspace = tmp_path / "ws"
    workspace.mkdir()

    context = build_ask_context(
        "read it",
        workspace_root=workspace,
        context=RequestContext(active_file="../secret.txt"),
    )

    # The path is still reported (it is what the editor said), but never read.
    assert context.active_file == "../secret.txt"
    assert context.active_file_content is None


def test_build_ask_context_tolerates_a_missing_active_file(tmp_path: Path) -> None:
    context = build_ask_context(
        "explain",
        workspace_root=tmp_path,
        context=RequestContext(active_file="ghost.py"),
    )
    assert context.active_file_content is None


def test_build_ask_context_keeps_selection_and_cursor(tmp_path: Path) -> None:
    context = build_ask_context(
        "explain",
        workspace_root=tmp_path,
        context=RequestContext(selection="return 1", cursor_line=7),
    )
    assert context.selection == "return 1"
    assert context.cursor_line == 7


def test_build_ask_context_without_editor_context_is_unchanged(tmp_path: Path) -> None:
    context = build_ask_context("explain", workspace_root=tmp_path)
    assert context.active_file is None
    assert context.selection is None
    assert context.active_file_content is None


# ── prompt sections ──────────────────────────────────────────────────────────


def test_prompt_caps_rag_fragments_at_top_five() -> None:
    context = _empty_context(rag_fragments=_fragments(12))
    sections = context.system_prompt_sections()
    assert len(sections) == 1
    rendered = sections[0]
    for i in range(ASK_RAG_TOP_K):
        assert f"src/f{i}.py" in rendered
    assert "src/f5.py" not in rendered


def test_prompt_orders_selection_before_file_before_fragments() -> None:
    context = _empty_context(
        rag_fragments=_fragments(1),
        active_file="src/app.py",
        active_file_content="whole file",
        selection="the bit",
        cursor_line=3,
    )
    sections = context.system_prompt_sections()
    assert "selected" in sections[0]
    assert "the bit" in sections[0]
    assert "line 3" in sections[0]
    assert "currently viewing" in sections[1]
    assert "relevant code" in sections[2]


def test_prompt_reports_the_path_when_content_is_unavailable() -> None:
    context = _empty_context(active_file="src/app.py", active_file_content=None)
    sections = context.system_prompt_sections()
    assert sections == ("The user is currently viewing src/app.py.",)


def test_prompt_is_empty_without_any_context() -> None:
    assert _empty_context().system_prompt_sections() == ()


def test_ask_path_receives_the_request_context(tmp_path: Path) -> None:
    from zocai_gateway.mode_router import AskPath

    (tmp_path / "app.py").write_text("value = 42\n", encoding="utf-8")
    seen: list[AskContext] = []

    def generate(prompt: str, context: AskContext) -> str:
        seen.append(context)
        return "42"

    request = AgentRunRequest(
        prompt="what is value?",
        mode=Mode.ASK,
        context=RequestContext(active_file="app.py", selection="value"),
    )
    result = AskPath().execute(
        request,
        generate=generate,
        workspace_root=tmp_path,
        rag_matcher=_Matcher(_fragments(2)),
    )

    assert getattr(result, "text", None) == "42"
    assert seen[0].active_file == "app.py"
    assert seen[0].active_file_content == "value = 42\n"
    assert seen[0].selection == "value"
