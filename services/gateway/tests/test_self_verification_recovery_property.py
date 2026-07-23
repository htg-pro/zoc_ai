"""Property + unit tests for the self-verification recovery loop (Epic 5).

Feature: agent-reasoning-engine, Properties 12, 13, 14, 16 (+ R7.8 hot-swap unit).
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from unittest.mock import patch

from hypothesis import given, settings
from hypothesis import strategies as st
from zocai_gateway.context.steering_compiler import SteeringPayload
from zocai_gateway.context.token_gate import TokenGateResult
from zocai_gateway.edits import EditPlan, PlannedChange
from zocai_gateway.emit_gate import EmitGate
from zocai_gateway.fsm import FSM
from zocai_gateway.memory.state_wrapper import FailureRecord, StateWrapperStore
from zocai_gateway.mode_router import AgentRunRequest, Mode
from zocai_gateway.model_allocator import Allocation
from zocai_gateway.model_interface import ModelTier
from zocai_gateway.remediation import RemediationLoop
from zocai_gateway.run_pipeline import (
    DefaultAgentBrain,
    RunContext,
    RunPipeline,
    RuntimeAgentBrain,
)
from zocai_gateway.stages import Stage
from zocai_gateway.verification import parse_verify_result

_COMMANDS = st.sampled_from(["pytest", "cargo test", "go test", "tsc", "make test"])


def _context() -> RunContext:
    return RunContext(
        allocation=Allocation(ModelTier.LOCAL_SLM, 4000),
        fragments=(),
        steering=SteeringPayload(),
        token_gate=TokenGateResult(fragments=(), dropped=(), token_count=0, window=4000),
        mcp_tools=(),
    )


def _request() -> AgentRunRequest:
    return AgentRunRequest(
        prompt="modify the parser",
        mode=Mode.AGENT,
        provider="mock",
        model="mock-model",
        base_url="http://model.test",
    )


# ── Property 12: verification outcome routes the run ─────────────────────────


@settings(max_examples=200)
@given(exit_code=st.integers(min_value=-5, max_value=5), command=_COMMANDS, log=st.text(max_size=120))
def test_verification_outcome_routes_run(exit_code: int, command: str, log: str) -> None:
    """Property 12: pass → SUMMARY; fail (below ceiling) → HANDLE_ERROR, recovery +1.

    Feature: agent-reasoning-engine, Property 12

    **Validates: Requirements 7.1, 7.2**
    """
    loop = RemediationLoop(fsm=FSM(initial=Stage.RUN_CHECKS, run_id="r"), run_id="r")
    outcome = loop.on_checks_complete(
        exit_code, command=command, log=log, prior_plan=EditPlan()
    )
    if exit_code == 0:
        assert outcome.stage is Stage.SUMMARY  # R7.1
        assert loop.recoveries == 0
    else:
        # R7.2: a failing check below the ceiling enters HANDLE_ERROR and counts
        # exactly one recovery (the default planner then defers to PAUSED).
        assert loop.recoveries == 1
        assert outcome.stage is Stage.PAUSED


# ── Property 13: failure capture fidelity ────────────────────────────────────


@settings(max_examples=200)
@given(
    command=st.text(max_size=40),
    exit_code=st.integers(min_value=1, max_value=250),
    log=st.text(max_size=1500),
)
def test_failure_capture_fidelity(command: str, exit_code: int, log: str) -> None:
    """Property 13: the captured failure preserves command, exit code, and log.

    Feature: agent-reasoning-engine, Property 13

    **Validates: Requirements 7.3**
    """
    loop = RemediationLoop(fsm=FSM(initial=Stage.RUN_CHECKS, run_id="r"), run_id="r")
    loop.on_checks_complete(exit_code, command=command, log=log, prior_plan=EditPlan())
    record = loop.recorded_failures[-1]
    assert record.command == command
    assert record.exit_code == exit_code
    assert record.log == log  # under LOG_MAX_CHARS the log is retained exactly


# ── Property 14: fix context bounds the verification output ──────────────────

# A body of at least 2000 chars so the sentinel prefix always falls outside the
# last 2000 characters the fix context is allowed to include.
_CTX_BODY = st.text(alphabet="abc012 \n", min_size=2000, max_size=2400)


@settings(max_examples=50, deadline=None)
@given(body=_CTX_BODY)
def test_fix_context_bounds_verification_output(body: str) -> None:
    """Property 14: the remediation fix context includes at most the last 2000 chars.

    Feature: agent-reasoning-engine, Property 14

    **Validates: Requirements 7.4**
    """
    sentinel = "QQEXCLUDEDPREFIXQQ"
    log = sentinel + body  # sentinel sits before the final 2000 characters
    captured: dict[str, str] = {}

    def fake(request: AgentRunRequest, **_kwargs: object) -> str:
        captured["prompt"] = request.prompt
        return ""

    brain = RuntimeAgentBrain()
    with patch("zocai_gateway.run_pipeline.generate_text", fake):
        brain.edit_plan(_request(), _context())  # primes the brain's request/context
        brain.remediation_plan(
            EditPlan(reasoning="prior"),
            FailureRecord(command="pytest", exit_code=1, log=log),
        )

    prompt = captured["prompt"]
    assert log[-2000:] in prompt  # the last 2000 chars are included
    assert sentinel not in prompt  # nothing before the last 2000 chars leaks in


# ── Property 16: recovery-attempt event reports the attempt ──────────────────


@settings(max_examples=60, deadline=None)
@given(command=_COMMANDS, log=st.text(max_size=200))
def test_recovery_attempt_event_reports_attempt(command: str, log: str) -> None:
    """Property 16: the recovery-attempt event carries attempt==recoveries and failures.

    Feature: agent-reasoning-engine, Property 16

    **Validates: Requirements 7.6**
    """

    class _Brain(DefaultAgentBrain):
        def __init__(self) -> None:
            self.checks = 0

        def edit_plan(self, request: AgentRunRequest, context: RunContext) -> EditPlan:
            return EditPlan(reasoning="run verification")

        def run_checks(
            self, request: AgentRunRequest, plan: EditPlan
        ) -> tuple[int, str, str]:
            self.checks += 1
            if self.checks == 1:
                return (1, command, log)
            return (0, command, "ok")

        def remediation_plan(self, prior: EditPlan, failure: object) -> EditPlan | None:
            cmd = getattr(failure, "command", command)
            return EditPlan(
                reasoning=f"fix {cmd}",
                changes=(PlannedChange(path="a.py", content="x\n", diff="+x"),),
            )

    events: list[dict] = []
    with tempfile.TemporaryDirectory() as tmp:
        RunPipeline(
            AgentRunRequest(prompt="fix parser", mode=Mode.AGENT),
            "recovery",
            gate=EmitGate(sink=lambda event: events.append(dict(event))),
            text_sink=lambda _chunk: None,
            close=lambda: None,
            workspace_root=Path(tmp),
            brain=_Brain(),
        ).run()

    recovery = [e for e in events if e["type"] == "recovery-attempt"]
    assert len(recovery) == 1
    assert recovery[0]["attempt"] == 1
    assert recovery[0]["failures"] == parse_verify_result(command, log, 1).failures


# ── R7.8 unit: freeze + hot-swap at the recovery ceiling ─────────────────────


def test_hot_swap_at_recovery_ceiling(tmp_path: Path) -> None:
    """R7.8: reaching the recovery ceiling freezes, retains state, and hot-swaps.

    _Requirements: 7.8_
    """

    class _AlwaysFailing(DefaultAgentBrain):
        def __init__(self) -> None:
            self.attempts = 0

        def edit_plan(self, request: AgentRunRequest, context: RunContext) -> EditPlan:
            return EditPlan(reasoning="initial")

        def run_checks(
            self, request: AgentRunRequest, plan: EditPlan
        ) -> tuple[int, str, str]:
            return (1, "pytest", "FAILED tests/test_x.py::test_y - boom")

        def remediation_plan(self, prior: EditPlan, failure: object) -> EditPlan | None:
            # A distinct, failure-referencing corrective plan each attempt so the
            # loop keeps accepting remediations until the recovery ceiling.
            self.attempts += 1
            cmd = getattr(failure, "command", "pytest")
            return EditPlan(
                reasoning=f"fix {cmd} attempt {self.attempts}",
                changes=(
                    PlannedChange(
                        path=f"fix{self.attempts}.py",
                        content=f"patched{self.attempts}\n",
                        diff="+patched",
                    ),
                ),
            )

    store = StateWrapperStore(tmp_path / "state_wrapper.json")
    result = RunPipeline(
        AgentRunRequest(prompt="fix the parser", mode=Mode.AGENT),
        "hot-swap-ceiling",
        gate=EmitGate(sink=lambda _event: None),
        text_sink=lambda _chunk: None,
        close=lambda: None,
        workspace_root=tmp_path,
        state_store=store,
        brain=_AlwaysFailing(),
    ).run()

    assert result.stage is Stage.PAUSED
    assert result.paused is True
    assert result.hot_swap is not None
    # Upshifted from the starting LOCAL_SLM tier to the next higher tier (R7.8).
    assert result.hot_swap.new_tier is ModelTier.EDGE
    # Run state was frozen and retained on the cross-model bus.
    assert store.exists()
    assert store.load().stage is Stage.PLAN_EDITS
