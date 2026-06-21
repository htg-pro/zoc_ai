from __future__ import annotations

from pathlib import Path

from zocai_gateway.context_mentions import (
    expand_prompt_file_mentions,
    search_workspace_files,
)
from zocai_gateway.mode_router import AgentRunRequest, Mode
from zocai_gateway.run_pipeline import RunPipeline
from zocai_gateway.emit_gate import EmitGate


def test_selected_context_file_expands_exact_path_for_duplicate_basenames(tmp_path: Path) -> None:
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    (tmp_path / "a" / "config.ts").write_text("wrong\n", encoding="utf-8")
    (tmp_path / "b" / "config.ts").write_text("right\n", encoding="utf-8")

    expanded = expand_prompt_file_mentions(
        "explain @config.ts",
        tmp_path,
        [{"token": "config.ts", "path": str(tmp_path / "b" / "config.ts")}],
    )

    assert '<zoc_context_file path="b/config.ts">' in expanded
    assert "right" in expanded
    assert "wrong" not in expanded


def test_manual_mention_expands_by_workspace_basename(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.py").write_text("print('hi')\n", encoding="utf-8")

    expanded = expand_prompt_file_mentions("read @main.py", tmp_path)

    assert '<zoc_context_file path="src/main.py">' in expanded
    assert "print('hi')" in expanded


def test_large_mention_uses_bounded_snippet(tmp_path: Path) -> None:
    path = tmp_path / "large.txt"
    path.write_text("x" * 100, encoding="utf-8")

    expanded = expand_prompt_file_mentions(
        "summarize @large.txt",
        tmp_path,
        char_limit=12,
    )

    assert "x" * 12 in expanded
    assert "truncated; file is 100 characters" in expanded
    assert "x" * 40 not in expanded


def test_run_pipeline_expands_mentions_before_ask_generation(tmp_path: Path) -> None:
    (tmp_path / "notes.md").write_text("architecture notes\n", encoding="utf-8")
    chunks: list[str] = []

    result = RunPipeline(
        AgentRunRequest(prompt="what is in @notes.md?", mode=Mode.ASK),
        "run-mention",
        gate=EmitGate(sink=lambda _event: None),
        text_sink=chunks.append,
        close=lambda: None,
        workspace_root=tmp_path,
    ).run()

    assert result.ask_text is not None
    assert '<zoc_context_file path="notes.md">' in result.ask_text
    assert "architecture notes" in result.ask_text
    assert chunks == [result.ask_text]


def test_search_workspace_files_skips_heavy_directories(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "src" / "app.ts").write_text("ok\n", encoding="utf-8")
    (tmp_path / "node_modules" / "app.ts").write_text("skip\n", encoding="utf-8")

    matches = search_workspace_files(tmp_path, "app")

    assert [path.relative_to(tmp_path).as_posix() for path in matches] == ["src/app.ts"]

