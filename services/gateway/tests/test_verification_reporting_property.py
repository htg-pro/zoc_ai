"""Property + unit tests for verification parsing and reporting (Epic 4).

Feature: agent-reasoning-engine, Properties 10, 11 (+ R6.6 omission unit test).
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
from zocai_gateway.project_tests import ProjectTestResult, detect_project_test_command
from zocai_gateway.run_pipeline import DefaultAgentBrain, RunContext, RunPipeline
from zocai_gateway.verification import parse_verify_result

# ── Property 10: verify result totality and pass semantics ───────────────────


@settings(max_examples=200)
@given(
    command=st.text(max_size=30),
    output=st.text(max_size=600),
    exit_code=st.integers(min_value=-8, max_value=8),
)
def test_verify_result_totality_and_pass_semantics(
    command: str, output: str, exit_code: int
) -> None:
    """Property 10: passed ⇔ exit 0; failures empty on pass, distinct/≤50 on fail.

    Feature: agent-reasoning-engine, Property 10

    **Validates: Requirements 6.1, 6.2, 6.3, 6.4**
    """
    result = parse_verify_result(command, output, exit_code)
    assert result.output == output  # full output preserved (R6.1)
    assert result.passed is (exit_code == 0)
    if result.passed:
        assert result.failures == []  # R6.2
    else:
        assert len(result.failures) >= 1  # non-empty on failure (R6.3/6.4)
        assert len(result.failures) <= 50  # bounded (R6.3)
        assert len(set(result.failures)) == len(result.failures)  # distinct (R6.3)


# ── Property 11: test-results event reflects the outcome ─────────────────────


def _pipeline(root: Path) -> tuple[list[dict], RunPipeline]:
    events: list[dict] = []
    pipeline = RunPipeline(
        AgentRunRequest(prompt="do", mode=Mode.AGENT),
        "verify-run",
        gate=EmitGate(sink=lambda event: events.append(dict(event))),
        text_sink=lambda _chunk: None,
        close=lambda: None,
        workspace_root=root,
    )
    return events, pipeline


@settings(max_examples=200, deadline=None)
@given(
    command=st.text(min_size=1, max_size=30),
    source=st.text(min_size=1, max_size=20),
    exit_code=st.integers(min_value=-4, max_value=4),
    output=st.text(max_size=300),
    passed=st.integers(min_value=0, max_value=999),
    failed=st.integers(min_value=0, max_value=999),
    duration_ms=st.integers(min_value=0, max_value=100000),
    timed_out=st.booleans(),
)
def test_test_results_event_reflects_outcome(
    command: str,
    source: str,
    exit_code: int,
    output: str,
    passed: int,
    failed: int,
    duration_ms: int,
    timed_out: bool,
) -> None:
    """Property 11: the test-results event mirrors the ProjectTestResult.

    Feature: agent-reasoning-engine, Property 11

    **Validates: Requirements 6.5**
    """
    result = ProjectTestResult(
        command=command,
        source=source,
        exit_code=exit_code,
        output=output,
        passed=passed,
        failed=failed,
        duration_ms=duration_ms,
        timed_out=timed_out,
    )
    with tempfile.TemporaryDirectory() as tmp:
        events, pipeline = _pipeline(Path(tmp))
        pipeline._emit_test_results(result)

    event = next(e for e in events if e["type"] == "test-results")
    assert event["status"] == ("pass" if exit_code == 0 else "fail")
    assert event["command"] == command
    assert event["source"] == source
    assert event["passed"] == passed
    assert event["failed"] == failed
    assert event["exitCode"] == exit_code
    assert event["outputTail"] == output  # short output is preserved verbatim
    assert event["durationMs"] == duration_ms
    assert event["timedOut"] is timed_out


# ── R6.6: no test-results event when no project test command is detected ─────


def test_no_test_results_event_when_no_command_detected(tmp_path: Path) -> None:
    """R6.6: a workspace with no detected project test command emits no test-results.

    _Requirements: 6.6_
    """
    # A bare workspace has no package.json / Makefile / pyproject test command.
    assert detect_project_test_command(tmp_path) is None

    class _Brain(DefaultAgentBrain):
        def structured_plan(self, request: AgentRunRequest, context: RunContext) -> AgentPlan:
            return AgentPlan.model_validate(
                {"steps": [{"file": "a.py", "action": "create", "rationale": "x"}], "confidence": 1.0}
            )

        def edit_plan(self, request: AgentRunRequest, context: RunContext) -> EditPlan:
            return EditPlan(
                reasoning="write it",
                changes=(PlannedChange(path="a.py", content="print(1)\n", diff="+print(1)"),),
            )

        def run_checks(
            self, request: AgentRunRequest, plan: EditPlan
        ) -> tuple[int, str, str]:
            return (0, "noop-check", "")

    events: list[dict] = []
    result = RunPipeline(
        AgentRunRequest(prompt="do", mode=Mode.AGENT),
        "no-test-cmd",
        gate=EmitGate(sink=lambda event: events.append(dict(event))),
        text_sink=lambda _chunk: None,
        close=lambda: None,
        workspace_root=tmp_path,
        brain=_Brain(),
    ).run()

    assert result.stage.value == "done"
    assert not any(e["type"] == "test-results" for e in events)
