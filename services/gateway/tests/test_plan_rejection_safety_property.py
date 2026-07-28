"""Property test for plan rejection safety (zoc-ai-agent-chat-overhaul, Property 17).

Feature: zoc-ai-agent-chat-overhaul, Property 17: A rejected proposal changes no
file.

**Validates: Requirements 7.8, 12.5**

A Plan-mode run is driven to the approval gate with a plan that *would* overwrite
real files; the gate is rejected; and every file under the workspace root is
asserted byte-identical to its pre-proposal content, with the run reaching a
terminal state that applied nothing.
"""

from __future__ import annotations

import tempfile
from dataclasses import dataclass
from pathlib import Path

from hypothesis import given, settings
from hypothesis import strategies as st
from zocai_gateway.edits import EditPlan, PlannedChange
from zocai_gateway.emit_gate import EmitGate
from zocai_gateway.mode_router import AgentRunRequest, Mode
from zocai_gateway.plan import AgentPlan, EditStep
from zocai_gateway.run_pipeline import DefaultAgentBrain, RunContext, RunPipeline
from zocai_gateway.stages import Stage


@dataclass
class _RejectDecision:
    """A control-channel decision that rejects the plan."""

    decision: str = "reject"
    accepted_paths: tuple[str, ...] = ()


# Workspace-relative file names (no separators / traversal, so they stay in root).
_names = st.text(alphabet="abcdefghijklmnopqrstuvwxyz_", min_size=1, max_size=12)
_contents = st.text(max_size=80)


class _ProposingBrain(DefaultAgentBrain):
    """A brain that proposes to overwrite every target file."""

    def __init__(self, targets: dict[str, str]) -> None:
        self._targets = targets

    def think(self, request: AgentRunRequest, context: RunContext) -> str:
        return ""

    def structured_plan(self, request: AgentRunRequest, context: RunContext) -> AgentPlan:
        return AgentPlan(
            steps=[
                EditStep(file=name, action="modify", rationale="overwrite it")
                for name in self._targets
            ],
            verification_command=None,
            confidence=0.9,
        )

    def edit_plan(self, request: AgentRunRequest, context: RunContext) -> EditPlan:
        return EditPlan(
            reasoning="apply the overwrite",
            changes=tuple(
                PlannedChange(
                    path=name,
                    content="OVERWRITTEN-BY-REJECTED-PLAN",
                    diff=f"--- a/{name}\n+++ b/{name}\n@@\n-old\n+OVERWRITTEN-BY-REJECTED-PLAN\n",
                )
                for name in self._targets
            ),
        )


@settings(max_examples=100, deadline=None)
@given(files=st.dictionaries(_names, _contents, min_size=1, max_size=4))
def test_rejected_plan_changes_no_file(files: dict[str, str]) -> None:
    """Property 17: rejecting a plan leaves every workspace file byte-identical.

    Feature: zoc-ai-agent-chat-overhaul, Property 17

    **Validates: Requirements 7.8, 12.5**
    """
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        for name, content in files.items():
            (root / name).write_text(content, encoding="utf-8")
        before = {name: (root / name).read_bytes() for name in files}

        events: list[dict[str, object]] = []
        result = RunPipeline(
            AgentRunRequest(prompt="change everything", mode=Mode.PLAN),
            "reject-safety",
            gate=EmitGate(sink=lambda event: events.append(dict(event))),
            text_sink=lambda _chunk: None,
            close=lambda: None,
            workspace_root=root,
            brain=_ProposingBrain(dict(files)),
            wait_for_approval_decision=lambda _timeout: _RejectDecision(),
        ).run()

        # R7.8/R12.5: no file under the workspace root changed.
        after = {name: (root / name).read_bytes() for name in files}
        assert after == before

        # The run reached a terminal state and applied nothing.
        assert result.stage is not Stage.DONE
        # A rejected plan never emits an applied edit-file frame.
        applied = [
            e
            for e in events
            if e.get("type") == "edit-file" and e.get("status") == "done"
        ]
        assert applied == []
