"""Tests for the ``execute_run`` wiring seam (desktop endpoint composition).

These guard the parameters the FastAPI ``/v1/agent/run`` handler now threads
through the single ``execute_run`` entrypoint so the desktop app actually
reaches the iterative ReAct apply loop and the real Context Bus matcher:

* ``apply_strategy`` reaches the pipeline, so a REACT run drives the scripted
  tool model and writes files via tool calls (previously unreachable — the
  handler defaulted to SINGLE_PASS because ``execute_run`` did not forward it).
* ``rag_matcher`` reaches the pipeline's Context Bus, so injected workspace
  fragments feed the run (previously always the no-op ``NullRagMatcher``).
* Omitting both preserves the exact legacy SINGLE_PASS / no-RAG behavior.

The model boundary is a scripted ``run_with_tools``; the toolset runs against a
real temp workspace so writes are genuine.
"""

from __future__ import annotations

from pathlib import Path

from zocai_gateway.context.rag_matcher import RagFragment, RagMatcher
from zocai_gateway.edits import EditPlan
from zocai_gateway.emit_gate import EmitGate
from zocai_gateway.mode_router import AgentRunRequest, Mode
from zocai_gateway.model_runtime import ModelToolResponse, ToolCall
from zocai_gateway.plan import AgentPlan, EditStep
from zocai_gateway.run_pipeline import (
    ApplyStrategy,
    DefaultAgentBrain,
    RunContext,
    execute_run,
)
from zocai_gateway.stages import Stage

_PLAN = AgentPlan(
    steps=[EditStep(file="a.py", action="create", rationale="create module a")],
    confidence=1.0,
)


class _StructuredBrain(DefaultAgentBrain):
    """Supplies a non-empty structured plan so ReAct is eligible."""

    def structured_plan(self, request: AgentRunRequest, context: RunContext) -> AgentPlan:
        return _PLAN

    def run_checks(
        self, request: AgentRunRequest, plan: EditPlan
    ) -> tuple[int, str, str]:
        return (0, "noop-check", "")


def _run(
    tmp_path: Path,
    *,
    apply_strategy: ApplyStrategy,
    rag_matcher: RagMatcher | None,
    run_with_tools,
    events: list[dict],
):
    return execute_run(
        AgentRunRequest(
            prompt="build module a",
            mode=Mode.AGENT,
            provider="mock",
            model="mock-model",
            base_url="http://model.test",
        ),
        "execute-run-wiring",
        gate=EmitGate(sink=lambda event: events.append(dict(event))),
        text_sink=lambda _chunk: None,
        close=lambda: None,
        workspace_root=tmp_path,
        brain=_StructuredBrain(),
        rag_matcher=rag_matcher,
        apply_strategy=apply_strategy,
        run_with_tools=run_with_tools,
    )


def _scripted_write(*, content: str = "print(1)\n"):
    """A run_with_tools that writes ``a.py`` via a tool call then stops."""
    responses = iter(
        [
            ModelToolResponse(
                text="",
                tool_calls=(
                    ToolCall(
                        id="w1",
                        name="write_file",
                        arguments={"path": "a.py", "content": content},
                    ),
                ),
                finish_reason="tool_calls",
            ),
            ModelToolResponse(text="done", tool_calls=(), finish_reason="stop"),
        ]
    )

    def tool_model(request: AgentRunRequest, **_kwargs: object) -> ModelToolResponse:
        try:
            return next(responses)
        except StopIteration:
            return ModelToolResponse(text="done", tool_calls=(), finish_reason="stop")

    return tool_model


def test_execute_run_forwards_react_strategy(tmp_path: Path) -> None:
    """execute_run(apply_strategy=REACT) reaches the ReAct loop and writes files."""
    events: list[dict] = []
    result = _run(
        tmp_path,
        apply_strategy=ApplyStrategy.REACT,
        rag_matcher=None,
        run_with_tools=_scripted_write(),
        events=events,
    )

    assert result.stage is Stage.DONE
    types = [e["type"] for e in events]
    assert "edit-file" in types  # the write surfaced as an edit-file row
    # The file was written by the scripted tool call, not a pre-computed plan.
    assert (tmp_path / "a.py").read_text(encoding="utf-8") == "print(1)\n"


def test_execute_run_defaults_to_single_pass(tmp_path: Path) -> None:
    """Omitting apply_strategy preserves legacy SINGLE_PASS (no tool loop)."""
    events: list[dict] = []
    tool_calls_seen = 0

    def tool_model(request: AgentRunRequest, **_kwargs: object) -> ModelToolResponse:
        nonlocal tool_calls_seen
        tool_calls_seen += 1
        return ModelToolResponse(text="", tool_calls=(), finish_reason="stop")

    # Brain plans no edit changes → empty-plan skip; the ReAct loop must NOT run.
    result = execute_run(
        AgentRunRequest(prompt="build module a", mode=Mode.AGENT),
        "execute-run-single-pass",
        gate=EmitGate(sink=lambda event: events.append(dict(event))),
        text_sink=lambda _chunk: None,
        close=lambda: None,
        workspace_root=tmp_path,
        brain=_StructuredBrain(),
        run_with_tools=tool_model,
        # apply_strategy omitted → SINGLE_PASS default.
    )

    assert result.stage is Stage.DONE
    # SINGLE_PASS with an empty edit plan never invokes the tool model.
    assert tool_calls_seen == 0


def test_execute_run_forwards_rag_matcher(tmp_path: Path) -> None:
    """execute_run forwards a rag_matcher whose fragments feed the run context."""
    extracted: list[str] = []

    class _RecordingMatcher:
        def extract(self, query: str) -> tuple[RagFragment, ...]:
            extracted.append(query)
            return (
                RagFragment(path="ctx.py", content="def helper(): ...", score=0.9),
            )

    events: list[dict] = []
    result = _run(
        tmp_path,
        apply_strategy=ApplyStrategy.REACT,
        rag_matcher=_RecordingMatcher(),
        run_with_tools=_scripted_write(),
        events=events,
    )

    assert result.stage is Stage.DONE
    # The injected matcher was consulted for this run's prompt (not the no-op).
    assert extracted and "build module a" in extracted[0]
