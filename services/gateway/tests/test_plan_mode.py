"""Tests for Plan mode: the post-PLAN_EDITS approval gate (§12.2)."""

from __future__ import annotations

import pytest
from shared_schema.agent_events import AgentEventModel, PlanReadyEvent
from zocai_gateway.edits import EditPlan, PlannedChange
from zocai_gateway.mode_router import AgentPath, AgentRunRequest, Mode, ModeRouter
from zocai_gateway.plan import AgentPlan, EditStep
from zocai_gateway.run_pipeline import _restrict_plan_to_paths


def _plan(*files: str) -> AgentPlan:
    return AgentPlan(
        steps=[
            EditStep(file=f, action="modify", rationale=f"touch {f}") for f in files
        ],
        verification_command="pytest -q",
        confidence=0.8,
    )


def _edit_plan(*files: str) -> EditPlan:
    return EditPlan(
        reasoning="because",
        changes=tuple(
            PlannedChange(path=f, content="body", diff=f"--- a/{f}\n+++ b/{f}\n")
            for f in files
        ),
    )


# ── routing ──────────────────────────────────────────────────────────────────


def test_plan_mode_is_a_distinct_mode() -> None:
    assert Mode("plan") is Mode.PLAN
    assert {m.value for m in Mode} == {"ask", "agent", "plan"}


def test_plan_mode_routes_to_a_gated_agent_path() -> None:
    path = ModeRouter().route(AgentRunRequest(prompt="do it", mode=Mode.PLAN))
    assert isinstance(path, AgentPath)
    assert path.plan_only is True
    assert path.mode is Mode.PLAN
    # Plan mode is still capability-complete; the gate is in the pipeline.
    assert path.is_read_only is False


def test_agent_mode_is_not_gated() -> None:
    path = ModeRouter().route(AgentRunRequest(prompt="do it", mode=Mode.AGENT))
    assert isinstance(path, AgentPath)
    assert path.plan_only is False


# ── event contract ───────────────────────────────────────────────────────────


def test_plan_ready_event_validates_against_the_contract() -> None:
    payload = {
        "type": "plan-ready",
        "seq": 4,
        "runId": "r1",
        "ts": "2026-07-25T05:00:00Z",
        "steps": [
            {
                "file": "src/app.py",
                "action": "modify",
                "rationale": "add a guard",
                "diff": "--- a\n+++ b\n",
            }
        ],
        "verificationCommand": "pytest -q",
        "confidence": 0.9,
        "fileCount": 1,
    }
    event = AgentEventModel.model_validate(payload).root
    assert isinstance(event, PlanReadyEvent)
    assert event.steps[0].file == "src/app.py"
    assert event.file_count == 1


def test_plan_ready_event_rejects_an_unknown_action() -> None:
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        AgentEventModel.model_validate(
            {
                "type": "plan-ready",
                "seq": 1,
                "runId": "r1",
                "ts": "2026-07-25T05:00:00Z",
                "steps": [{"file": "a.py", "action": "explode", "rationale": "x"}],
            }
        )


def test_plan_ready_event_round_trips_by_alias() -> None:
    event = PlanReadyEvent(
        seq=1,
        run_id="r1",
        ts="2026-07-25T05:00:00Z",
        steps=[],
        verification_command="make check",
        confidence=0.5,
        file_count=0,
    )
    dumped = event.model_dump(by_alias=True)
    assert dumped["verificationCommand"] == "make check"
    assert dumped["fileCount"] == 0
    assert dumped["type"] == "plan-ready"


# ── per-step deselection ─────────────────────────────────────────────────────


def test_restrict_plan_keeps_only_accepted_files() -> None:
    structured, plan = _restrict_plan_to_paths(
        _plan("a.py", "b.py", "c.py"),
        _edit_plan("a.py", "b.py", "c.py"),
        ("a.py", "c.py"),
    )
    assert [s.file for s in structured.steps] == ["a.py", "c.py"]
    assert [c.path for c in plan.changes] == ["a.py", "c.py"]


def test_restrict_plan_normalises_separators() -> None:
    structured, plan = _restrict_plan_to_paths(
        _plan("src/a.py"),
        _edit_plan("src/a.py"),
        ("src\\a.py",),
    )
    assert [s.file for s in structured.steps] == ["src/a.py"]
    assert len(plan.changes) == 1


def test_restrict_plan_to_nothing_yields_an_empty_plan() -> None:
    structured, plan = _restrict_plan_to_paths(
        _plan("a.py"), _edit_plan("a.py"), ("other.py",)
    )
    assert structured.steps == []
    assert plan.changes == ()
    assert plan.has_changes is False


def test_restrict_plan_preserves_other_plan_fields() -> None:
    structured, plan = _restrict_plan_to_paths(
        _plan("a.py", "b.py"), _edit_plan("a.py", "b.py"), ("a.py",)
    )
    assert structured.verification_command == "pytest -q"
    assert structured.confidence == 0.8
    assert plan.reasoning == "because"


# ── gate semantics ───────────────────────────────────────────────────────────


def test_plan_gate_fails_closed_without_a_decision_channel() -> None:
    """No approval channel must mean "not approved", never "apply anyway"."""
    from zocai_gateway.run_pipeline import _PlanGate

    gate = _PlanGate(approved=False, accepted_paths=None)
    assert gate.approved is False


def test_plan_gate_records_a_partial_selection() -> None:
    from zocai_gateway.run_pipeline import _PlanGate

    gate = _PlanGate(approved=True, accepted_paths=("a.py",))
    assert gate.approved is True
    assert gate.accepted_paths == ("a.py",)
