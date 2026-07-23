"""Integration test for the APPLY_EDITS strategy seam (task 11.4).

_Requirements: 8.1, 9.1, 9.2, 10.1, 10.4_

Drives a full INTAKE→…→DONE agent run under ``ApplyStrategy.REACT`` with a
scripted tool model that writes a file, runs a shell check, and finishes with a
``stop`` — asserting the edit-file / command / plan-update / budget rows and the
DONE terminal — and a companion run under the default ``SINGLE_PASS`` strategy
that asserts the unchanged legacy behavior (coexistence).
"""

from __future__ import annotations

from pathlib import Path

from zocai_gateway.edits import EditPlan, PlannedChange
from zocai_gateway.emit_gate import EmitGate
from zocai_gateway.mode_router import AgentRunRequest, Mode
from zocai_gateway.model_runtime import ModelToolResponse, ToolCall
from zocai_gateway.plan import AgentPlan, EditStep
from zocai_gateway.run_pipeline import (
    ApplyStrategy,
    DefaultAgentBrain,
    RunContext,
    RunPipeline,
)
from zocai_gateway.stages import Stage

_PLAN = AgentPlan(
    steps=[
        EditStep(file="a.py", action="create", rationale="create module a"),
        EditStep(file="b.py", action="create", rationale="create module b"),
    ],
    confidence=1.0,
)


class _StructuredBrain(DefaultAgentBrain):
    """Supplies the structured plan; think/checks are deterministic no-ops."""

    def structured_plan(self, request: AgentRunRequest, context: RunContext) -> AgentPlan:
        return _PLAN

    def run_checks(
        self, request: AgentRunRequest, plan: EditPlan
    ) -> tuple[int, str, str]:
        return (0, "noop-check", "")


def test_react_strategy_drives_full_run(tmp_path: Path) -> None:
    """A scripted tool model drives a full REACT run to DONE with trace rows."""
    responses = iter(
        [
            # Step 1: write a.py (satisfies edit-1).
            ModelToolResponse(
                text="",
                tool_calls=(
                    ToolCall(id="w1", name="write_file", arguments={"path": "a.py", "content": "print(1)\n"}),
                ),
                finish_reason="tool_calls",
            ),
            # A shell check surfaces as a command row.
            ModelToolResponse(
                text="",
                tool_calls=(ToolCall(id="s1", name="run_shell", arguments={"argv": ["echo", "ok"]}),),
                finish_reason="tool_calls",
            ),
            # Finish with a stop finish reason.
            ModelToolResponse(text="all done", tool_calls=(), finish_reason="stop"),
        ]
    )

    def tool_model(request: AgentRunRequest, **_kwargs: object) -> ModelToolResponse:
        try:
            return next(responses)
        except StopIteration:
            return ModelToolResponse(text="done", tool_calls=(), finish_reason="stop")

    events: list[dict] = []
    result = RunPipeline(
        AgentRunRequest(
            prompt="build modules",
            mode=Mode.AGENT,
            provider="mock",
            model="mock-model",
            base_url="http://model.test",
        ),
        "react-integration",
        gate=EmitGate(sink=lambda event: events.append(dict(event))),
        text_sink=lambda _chunk: None,
        close=lambda: None,
        workspace_root=tmp_path,
        brain=_StructuredBrain(),
        apply_strategy=ApplyStrategy.REACT,
        run_with_tools=tool_model,
    ).run()

    types = [e["type"] for e in events]
    assert result.stage is Stage.DONE
    assert "edit-file" in types  # R9.1 file mutation surfaced
    assert "command" in types  # R9.2 shell call surfaced
    assert "budget" in types  # R10.1/10.4 budget emitted on the counted write
    assert any(
        e["type"] == "plan-update" and e["id"] == "edit-1" and e["status"] == "done"
        for e in events
    )
    edit_paths = [e["path"] for e in events if e["type"] == "edit-file"]
    assert "a.py" in edit_paths
    assert (tmp_path / "a.py").read_text(encoding="utf-8") == "print(1)\n"
    # The ReAct loop produced the file content via a tool call, not a pre-plan.
    assert any(e["type"] == "command" and e["command"] == "echo ok" for e in events)


def test_single_pass_strategy_preserves_legacy_behavior(tmp_path: Path) -> None:
    """The default SINGLE_PASS run applies the EditPlan directly (coexistence)."""

    class _SinglePassBrain(_StructuredBrain):
        def edit_plan(self, request: AgentRunRequest, context: RunContext) -> EditPlan:
            return EditPlan(
                reasoning="apply both modules",
                changes=(
                    PlannedChange(path="a.py", content="print(1)\n", diff="+print(1)"),
                    PlannedChange(path="b.py", content="print(2)\n", diff="+print(2)"),
                ),
            )

    events: list[dict] = []
    result = RunPipeline(
        AgentRunRequest(prompt="build modules", mode=Mode.AGENT),
        "single-pass-integration",
        gate=EmitGate(sink=lambda event: events.append(dict(event))),
        text_sink=lambda _chunk: None,
        close=lambda: None,
        workspace_root=tmp_path,
        brain=_SinglePassBrain(),
        # apply_strategy defaults to SINGLE_PASS.
    ).run()

    types = [e["type"] for e in events]
    assert result.stage is Stage.DONE
    assert "edit-file" in types
    edit_paths = sorted(e["path"] for e in events if e["type"] == "edit-file")
    assert edit_paths == ["a.py", "b.py"]
    # Both applied steps are marked done (legacy plan-update mapping).
    done_ids = {
        e["id"]
        for e in events
        if e["type"] == "plan-update" and e["status"] == "done" and str(e["id"]).startswith("edit-")
    }
    assert done_ids == {"edit-1", "edit-2"}
    assert (tmp_path / "a.py").read_text(encoding="utf-8") == "print(1)\n"
    assert (tmp_path / "b.py").read_text(encoding="utf-8") == "print(2)\n"
