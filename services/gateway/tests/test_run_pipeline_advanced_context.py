"""Advanced Context Engine RunPipeline unit and integration coverage."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
import zocai_gateway.run_pipeline as run_pipeline_module
from shared_schema.models import IndexChunk, IndexQueryResult
from zocai_gateway.context.rag_matcher import FragmentSource, RagFragment
from zocai_gateway.context.steering_compiler import (
    MapFilesError,
    runtime_file_selector,
)
from zocai_gateway.edits import EditPlan, PlannedChange
from zocai_gateway.emit_gate import EmitGate
from zocai_gateway.memory.matrix import (
    COMPRESSED_HISTORY_PREFIX,
    ConversationMemory,
    Message,
    Role,
    TokenizerKind,
    runtime_summarizer,
)
from zocai_gateway.mode_router import AgentRunRequest, Mode
from zocai_gateway.model_runtime import ModelRuntimeError
from zocai_gateway.plan import AgentPlan, EditStep
from zocai_gateway.run_pipeline import DefaultAgentBrain, RunContext, RunPipeline
from zocai_gateway.stages import Stage


def _gate() -> tuple[list[dict[str, object]], EmitGate]:
    events: list[dict[str, object]] = []
    return events, EmitGate(sink=lambda event: events.append(dict(event)))


def _request(*, provider: bool = False) -> AgentRunRequest:
    values: dict[str, object] = {"prompt": "implement feature", "mode": Mode.AGENT}
    if provider:
        values.update(
            provider="mock",
            model="mock-model",
            base_url="http://model.test",
        )
    return AgentRunRequest(**values)


def _compression_history() -> list[Message]:
    return [
        Message(Role.SYSTEM, "system"),
        Message(Role.USER, "m" * 400, "ANALYZE"),
        Message(Role.TOOL_RESULT, "current", "APPLY"),
        Message(Role.USER, "one", "APPLY"),
        Message(Role.ASSISTANT, "two", "APPLY"),
        Message(Role.USER, "three", "APPLY"),
        Message(Role.ASSISTANT, "four", "APPLY"),
    ]


def test_runtime_context_adapters_use_model_runtime(monkeypatch) -> None:
    calls: list[tuple[str, float]] = []

    def generate(request: AgentRunRequest, *, timeout: float, **_kwargs: object) -> str:
        calls.append((request.prompt, timeout))
        return "provider response"

    monkeypatch.setattr("zocai_gateway.model_runtime.generate_text", generate)
    request = _request(provider=True)

    assert runtime_summarizer(request)("summary prompt") == "provider response"
    assert runtime_file_selector(request)("selection prompt") == "provider response"
    assert calls == [("summary prompt", 60.0), ("selection prompt", 120.0)]


def test_runtime_context_adapters_reject_empty_provider_text(monkeypatch) -> None:
    monkeypatch.setattr(
        "zocai_gateway.model_runtime.generate_text",
        lambda *_args, **_kwargs: "   ",
    )
    request = _request(provider=True)

    with pytest.raises(Exception, match="no text"):
        runtime_summarizer(request)("summary")
    with pytest.raises(MapFilesError, match="no response"):
        runtime_file_selector(request)("selection")


def test_compression_without_provider_continues_uncompressed(tmp_path: Path) -> None:
    events, gate = _gate()
    pipeline = RunPipeline(
        _request(),
        "compress-none",
        gate=gate,
        text_sink=lambda _chunk: None,
        close=lambda: None,
        workspace_root=tmp_path,
        brain=DefaultAgentBrain(),
    )
    memory = ConversationMemory(
        messages=_compression_history(),
        tokenizer_kind=TokenizerKind.LOCAL,
    )
    snapshot = list(memory.messages)

    pipeline._maybe_compress(memory, 10)

    assert memory.messages == snapshot
    assert not any(event["type"] == "context-compressed" for event in events)


def test_compression_provider_failure_continues_uncompressed(
    tmp_path: Path, monkeypatch
) -> None:
    events, gate = _gate()
    pipeline = RunPipeline(
        _request(provider=True),
        "compress-failure",
        gate=gate,
        text_sink=lambda _chunk: None,
        close=lambda: None,
        workspace_root=tmp_path,
        brain=DefaultAgentBrain(),
    )

    def failing_summarizer(_request: AgentRunRequest):
        def fail(_prompt: str) -> str:
            raise ModelRuntimeError("summary failed")

        return fail

    monkeypatch.setattr(run_pipeline_module, "runtime_summarizer", failing_summarizer)
    memory = ConversationMemory(
        messages=_compression_history(),
        tokenizer_kind=TokenizerKind.LOCAL,
    )
    snapshot = list(memory.messages)

    pipeline._maybe_compress(memory, 10)

    assert memory.messages == snapshot
    assert not any(event["type"] == "context-compressed" for event in events)


def test_successful_compression_continues_and_emits_once(
    tmp_path: Path, monkeypatch
) -> None:
    events, gate = _gate()
    pipeline = RunPipeline(
        _request(provider=True),
        "compress-success",
        gate=gate,
        text_sink=lambda _chunk: None,
        close=lambda: None,
        workspace_root=tmp_path,
        brain=DefaultAgentBrain(),
    )
    monkeypatch.setattr(
        run_pipeline_module,
        "runtime_summarizer",
        lambda _request: lambda _prompt: "concise summary",
    )
    memory = ConversationMemory(
        messages=_compression_history(),
        tokenizer_kind=TokenizerKind.LOCAL,
    )

    pipeline._maybe_compress(memory, 10)
    pipeline._maybe_compress(memory, 10)

    compressed = [
        event for event in events if event["type"] == "context-compressed"
    ]
    assert len(compressed) == 1
    assert any(
        message.content.startswith(COMPRESSED_HISTORY_PREFIX)
        for message in memory.messages
    )
    assert compressed[0]["compressedTokens"] <= compressed[0]["originalTokens"]


@pytest.mark.parametrize(
    "selector",
    [
        lambda _prompt: "not-json",
        lambda _prompt: "",
        lambda _prompt: (_ for _ in ()).throw(ModelRuntimeError("provider failed")),
    ],
    ids=["unparseable", "empty", "runtime-error"],
)
def test_map_files_failures_transition_to_error_closed(
    tmp_path: Path, selector
) -> None:
    events, gate = _gate()
    result = RunPipeline(
        _request(),
        "map-failure",
        gate=gate,
        text_sink=lambda _chunk: None,
        close=lambda: None,
        workspace_root=tmp_path,
        brain=DefaultAgentBrain(),
        file_selector=selector,
    ).run()

    assert result.stage is Stage.ERROR_CLOSED
    assert not any(event["type"] == "map-files" for event in events)
    assert not list(tmp_path.iterdir())


def test_well_formed_empty_map_selection_proceeds(tmp_path: Path) -> None:
    events, gate = _gate()
    result = RunPipeline(
        _request(),
        "map-empty",
        gate=gate,
        text_sink=lambda _chunk: None,
        close=lambda: None,
        workspace_root=tmp_path,
        brain=DefaultAgentBrain(),
        file_selector=lambda _prompt: json.dumps(
            {"read": [], "write": [], "rationale": "no files needed"}
        ),
    ).run()

    assert result.stage is Stage.DONE
    map_event = next(event for event in events if event["type"] == "map-files")
    assert map_event["readList"] == []
    assert map_event["writeList"] == []


class _RecordingMatcher:
    def __init__(self) -> None:
        self.calls = 0

    def extract(self, query: str) -> tuple[RagFragment, ...]:
        self.calls += 1
        return (
            RagFragment(
                path="rag.py",
                content="rag candidate",
                score=1.0,
                source=FragmentSource.FOLDER,
            ),
        )


class _FakeReadyIndexer:
    def __init__(self, ready: bool) -> None:
        self.ready = ready
        self.queries: list[tuple[str, str, int]] = []

    def is_ready(self, session_id: str) -> bool:
        return self.ready

    def query(self, session_id: str, query: str, top_k: int = 20):
        self.queries.append((session_id, query, top_k))
        return [
            IndexQueryResult(
                chunk=IndexChunk(
                    id="hybrid",
                    file="hybrid.py",
                    start_line=1,
                    end_line=1,
                    text="hybrid candidate",
                ),
                score=1.0,
            )
        ]


def test_candidate_source_switches_only_for_ready_enabled_index(
    tmp_path: Path,
) -> None:
    def run_case(*, enabled: bool, ready: bool) -> tuple[str, _RecordingMatcher, _FakeReadyIndexer]:
        captured: list[str] = []
        matcher = _RecordingMatcher()
        indexer = _FakeReadyIndexer(ready)
        _events, gate = _gate()
        RunPipeline(
            _request(),
            f"candidate-{enabled}-{ready}",
            gate=gate,
            text_sink=lambda _chunk: None,
            close=lambda: None,
            workspace_root=tmp_path,
            brain=DefaultAgentBrain(),
            rag_matcher=matcher,
            file_selector=lambda prompt: (
                captured.append(prompt)
                or '{"read":[],"write":[],"rationale":"ok"}'
            ),
            workspace_indexer=indexer,  # type: ignore[arg-type]
            index_session_id="editor-session",
            hybrid_candidate_source=enabled,
        ).run()
        return captured[0], matcher, indexer

    hybrid_prompt, hybrid_matcher, hybrid_indexer = run_case(enabled=True, ready=True)
    assert "- hybrid.py" in hybrid_prompt
    assert hybrid_indexer.queries == [
        ("editor-session", "implement feature", 20)
    ]
    assert hybrid_matcher.calls == 1  # context build only

    fallback_prompt, fallback_matcher, fallback_indexer = run_case(
        enabled=True, ready=False
    )
    assert "- rag.py" in fallback_prompt
    assert fallback_indexer.queries == []
    assert fallback_matcher.calls == 2  # context build + MAP_FILES candidates


class _EndToEndBrain(DefaultAgentBrain):
    def __init__(self) -> None:
        self.seen_read_payload = ""
        self.seen_history = ""

    def structured_plan(
        self, request: AgentRunRequest, context: RunContext
    ) -> AgentPlan:
        self.seen_read_payload = context.read_files_payload
        self.seen_history = context.conversation_history
        return AgentPlan(
            steps=[
                EditStep(
                    file="out.txt",
                    action="create",
                    rationale="write the requested output",
                )
            ],
            verification_command=None,
            confidence=1.0,
        )

    def edit_plan(self, request: AgentRunRequest, context: RunContext) -> EditPlan:
        self.seen_read_payload = context.read_files_payload
        self.seen_history = context.conversation_history
        return EditPlan(
            reasoning="use selected input",
            changes=(
                PlannedChange(path="out.txt", content="generated\n", diff="+generated"),
            ),
        )


def test_full_map_read_plan_apply_pipeline(tmp_path: Path) -> None:
    (tmp_path / "input.txt").write_text("selected source\n", encoding="utf-8")
    matcher = _RecordingMatcher()
    brain = _EndToEndBrain()
    events, gate = _gate()

    result = RunPipeline(
        _request(),
        "advanced-e2e",
        gate=gate,
        text_sink=lambda _chunk: None,
        close=lambda: None,
        workspace_root=tmp_path,
        brain=brain,
        rag_matcher=matcher,
        file_selector=lambda _prompt: json.dumps(
            {
                "read": ["input.txt"],
                "write": ["out.txt"],
                "rationale": "read input and create output",
            }
        ),
    ).run()

    assert result.stage is Stage.DONE
    assert (tmp_path / "out.txt").read_text(encoding="utf-8") == "generated\n"
    assert "=== FILE: input.txt ===\nselected source\n" in brain.seen_read_payload
    assert "selected source" in brain.seen_history
    types = [event["type"] for event in events]
    assert types.index("map-files") < types.index("read-files")
    assert types.index("read-files") < types.index("plan")
    assert types.index("plan") < types.index("edit-file")
    read_event = next(event for event in events if event["type"] == "read-files")
    assert read_event["files"] == [{"path": "input.txt", "span": None}]


class _ApprovalBrain(DefaultAgentBrain):
    def edit_plan(self, request: AgentRunRequest, context: RunContext) -> EditPlan:
        return EditPlan(
            reasoning="write declared then undeclared",
            changes=(
                PlannedChange(path="declared.txt", content="declared"),
                PlannedChange(path="undeclared.txt", content="undeclared"),
            ),
        )


@pytest.mark.parametrize(
    ("verdict", "expected_stage"),
    [("approve", Stage.DONE), ("reject", Stage.PAUSED)],
)
def test_undeclared_write_approval_resumes_or_pauses(
    tmp_path: Path, verdict: str, expected_stage: Stage
) -> None:
    events, gate = _gate()
    decisions: list[str] = []

    def wait_for_approval(_timeout: float | None = None) -> object:
        decisions.append(verdict)
        return SimpleNamespace(decision=verdict)

    result = RunPipeline(
        _request(),
        f"approval-{verdict}",
        gate=gate,
        text_sink=lambda _chunk: None,
        close=lambda: None,
        workspace_root=tmp_path,
        brain=_ApprovalBrain(),
        file_selector=lambda _prompt: json.dumps(
            {
                "read": [],
                "write": ["declared.txt"],
                "rationale": "declare first write only",
            }
        ),
        wait_for_approval_decision=wait_for_approval,
    ).run()

    assert result.stage is expected_stage
    assert (tmp_path / "declared.txt").read_text(encoding="utf-8") == "declared"
    assert decisions == [verdict]
    approvals = [event for event in events if event["type"] == "approval"]
    assert len(approvals) == 1
    assert "undeclared.txt" in str(approvals[0]["prompt"])
    if verdict == "approve":
        assert (tmp_path / "undeclared.txt").read_text(encoding="utf-8") == (
            "undeclared"
        )
        assert result.paused is False
    else:
        assert not (tmp_path / "undeclared.txt").exists()
        assert result.paused is True
