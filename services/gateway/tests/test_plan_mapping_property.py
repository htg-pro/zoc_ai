"""Property tests for the structured-plan → plan-row mapping (Epic 3).

Feature: agent-reasoning-engine, Properties 7, 8, 9.

These lock the mapping of each AgentPlan EditStep onto exactly one
``edit-{index}`` PlanItem, the plan row preceding any edit, and plan-update
``done`` being emitted exactly for successfully applied steps.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from hypothesis import given, settings
from hypothesis import strategies as st
from zocai_gateway.edits import EditPlan, PlannedChange
from zocai_gateway.emit_gate import EmitGate
from zocai_gateway.mode_router import AgentRunRequest, Mode
from zocai_gateway.plan import AgentPlan
from zocai_gateway.run_pipeline import DefaultAgentBrain, RunContext, RunPipeline

_VALID_FILE = st.sampled_from(["a.py", "b/c.py", "d.txt", "e/f/g.md", "h", "pkg/m.py"])
_ACTION = st.sampled_from(["create", "modify", "delete", "rename"])
_RATIONALE = st.one_of(st.just(""), st.just("   "), st.text(min_size=1, max_size=25))


def _agent_plan(steps: list[dict]) -> AgentPlan:
    return AgentPlan.model_validate({"steps": steps, "confidence": 1.0})


def _events_sink() -> tuple[list[dict], EmitGate]:
    events: list[dict] = []
    return events, EmitGate(sink=lambda event: events.append(dict(event)))


def _pipeline(root: Path, brain: DefaultAgentBrain | None, gate: EmitGate) -> RunPipeline:
    return RunPipeline(
        AgentRunRequest(prompt="do the task", mode=Mode.AGENT),
        "plan-map",
        gate=gate,
        text_sink=lambda _chunk: None,
        close=lambda: None,
        workspace_root=root,
        brain=brain if brain is not None else DefaultAgentBrain(),
    )


# ── Property 7: structured plan maps one-to-one onto plan items ──────────────


@st.composite
def _steps(draw: st.DrawFn) -> list[dict]:
    return [
        {"file": draw(_VALID_FILE), "action": draw(_ACTION), "rationale": draw(_RATIONALE)}
        for _ in range(draw(st.integers(min_value=0, max_value=5)))
    ]


@settings(max_examples=150, deadline=None)
@given(steps=_steps())
def test_structured_plan_maps_one_to_one(steps: list[dict]) -> None:
    """Property 7: one ``edit-{index}`` item per step, in order, pending, labeled.

    Feature: agent-reasoning-engine, Property 7

    **Validates: Requirements 5.2, 5.4, 5.5**
    """
    plan = _agent_plan(steps)
    with tempfile.TemporaryDirectory() as tmp:
        events, gate = _events_sink()
        _pipeline(Path(tmp), None, gate)._emit_plan(EditPlan(reasoning="r"), plan)

    plan_event = next(e for e in events if e["type"] == "plan")
    edit_items = [it for it in plan_event["items"] if str(it["id"]).startswith("edit-")]

    assert len(edit_items) == len(plan.steps)
    ids = [it["id"] for it in edit_items]
    assert ids == [f"edit-{i}" for i in range(1, len(plan.steps) + 1)]
    assert len(set(ids)) == len(ids)
    for item, step in zip(edit_items, plan.steps, strict=True):
        assert item["status"] == "pending"
        assert step.action.capitalize() in item["label"]
        assert step.file in item["label"]
        if step.rationale.strip():
            assert step.rationale.strip() in item["label"]
        else:
            assert item["label"] == f"{step.action.capitalize()} {step.file}"


# ── Property 8: the plan row precedes any edit ───────────────────────────────


@settings(max_examples=100, deadline=None)
@given(files=st.lists(_VALID_FILE, min_size=1, max_size=4, unique=True))
def test_plan_row_precedes_any_edit(files: list[str]) -> None:
    """Property 8: the ``plan`` event's seq is lower than every ``edit-file`` seq.

    Feature: agent-reasoning-engine, Property 8

    **Validates: Requirements 5.1**
    """

    class _Brain(DefaultAgentBrain):
        def structured_plan(self, request: AgentRunRequest, context: RunContext) -> AgentPlan:
            return _agent_plan(
                [{"file": f, "action": "create", "rationale": "make"} for f in files]
            )

        def edit_plan(self, request: AgentRunRequest, context: RunContext) -> EditPlan:
            return EditPlan(
                reasoning="apply",
                changes=tuple(
                    PlannedChange(path=f, content="x\n", diff="+x") for f in files
                ),
            )

        def run_checks(
            self, request: AgentRunRequest, plan: EditPlan
        ) -> tuple[int, str, str]:
            return (0, "noop-check", "")

    with tempfile.TemporaryDirectory() as tmp:
        events, gate = _events_sink()
        _pipeline(Path(tmp), _Brain(), gate).run()

    plan_seq = next(e["seq"] for e in events if e["type"] == "plan")
    edit_seqs = [e["seq"] for e in events if e["type"] == "edit-file"]
    assert edit_seqs, "expected the run to emit edit-file events"
    assert all(plan_seq < seq for seq in edit_seqs)


# ── Property 9: plan-update done is emitted exactly for applied steps ─────────


@st.composite
def _files_and_applied(draw: st.DrawFn) -> tuple[list[str], list[str]]:
    files = draw(st.lists(_VALID_FILE, min_size=1, max_size=5, unique=True))
    applied = [f for f in files if draw(st.booleans())]
    return files, applied


@settings(max_examples=100, deadline=None)
@given(_files_and_applied())
def test_plan_update_done_iff_applied(case: tuple[list[str], list[str]]) -> None:
    """Property 9: an ``edit-{index}`` plan-update done ⇔ that step was applied.

    Feature: agent-reasoning-engine, Property 9

    **Validates: Requirements 5.6, 5.7**
    """
    files, applied = case

    class _Brain(DefaultAgentBrain):
        def structured_plan(self, request: AgentRunRequest, context: RunContext) -> AgentPlan:
            return _agent_plan(
                [{"file": f, "action": "create", "rationale": "make"} for f in files]
            )

        def edit_plan(self, request: AgentRunRequest, context: RunContext) -> EditPlan:
            return EditPlan(
                reasoning="apply",
                changes=tuple(
                    PlannedChange(path=f, content="x\n", diff="+x") for f in applied
                ),
            )

        def run_checks(
            self, request: AgentRunRequest, plan: EditPlan
        ) -> tuple[int, str, str]:
            return (0, "noop-check", "")

    with tempfile.TemporaryDirectory() as tmp:
        events, gate = _events_sink()
        _pipeline(Path(tmp), _Brain(), gate).run()

    done_edit_ids = {
        e["id"]
        for e in events
        if e["type"] == "plan-update"
        and e["status"] == "done"
        and str(e["id"]).startswith("edit-")
    }
    expected = {
        f"edit-{index}"
        for index, file in enumerate(files, start=1)
        if file in applied
    }
    assert done_edit_ids == expected
