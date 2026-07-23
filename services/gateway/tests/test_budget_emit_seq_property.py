"""Property tests for budget, emit-gate, and sequencing invariants (Epic 6).

Feature: agent-reasoning-engine, Properties 24, 25, 26, 27.

Named distinctly from the existing conformance suites
(``test_non_conforming_discard_property.py`` /
``test_contract_conformance_discriminator_property.py``) so Property 26 does
not collide with them (task 6.3).
"""

from __future__ import annotations

import itertools
import tempfile
from pathlib import Path
from unittest.mock import patch

from hypothesis import given, settings
from hypothesis import strategies as st
from shared_schema.agent_events import (
    ApprovalEvent,
    BudgetEvent,
    DoneEvent,
    SummaryEvent,
    ThinkingEvent,
)
from zocai_gateway.context.steering_compiler import SteeringPayload
from zocai_gateway.context.token_gate import TokenGateResult
from zocai_gateway.edits import EditCoordinator, EditPlan, PlannedChange
from zocai_gateway.emit_gate import EmitGate
from zocai_gateway.fsm import FSM
from zocai_gateway.mode_router import AgentRunRequest, Mode
from zocai_gateway.model_allocator import Allocation
from zocai_gateway.model_interface import ModelTier
from zocai_gateway.orchestrator import Budget, Orchestrator
from zocai_gateway.plan import AgentPlan
from zocai_gateway.run_pipeline import DefaultAgentBrain, RunContext, RunPipeline
from zocai_gateway.stages import Stage
from zocai_gateway.toolsets import FullToolset

_VALID_FILE = st.sampled_from(["a.py", "b/c.py", "d.txt", "e.md"])


def _context(window: int = 4000) -> RunContext:
    return RunContext(
        allocation=Allocation(ModelTier.LOCAL_SLM, window),
        fragments=(),
        steering=SteeringPayload(),
        token_gate=TokenGateResult(fragments=(), dropped=(), token_count=0, window=window),
        mcp_tools=(),
    )


# ── Property 24: thinking tokens are excluded from the context budget ────────


def _budget_tokens_for_noise(noise: int, root: Path) -> list[int]:
    """Run a full agent run whose thinking response carries ``noise`` bytes of
    text outside the <think> block (the extracted scratchpad is constant)."""
    scratchpad = "FIXED SCRATCHPAD CONTENT"
    thinking_response = ("x" * noise) + f"<think>{scratchpad}</think>" + ("y" * noise)

    def fake_generate_text(request: AgentRunRequest, *, system_prompt: str | None = None, **_kw: object):
        if system_prompt and "Wrap ALL your reasoning" in system_prompt:
            return thinking_response  # the thinking call
        return ""  # planning calls → empty structured plan / edit plan

    events: list[dict] = []
    request = AgentRunRequest(
        prompt="edit the parser",
        mode=Mode.AGENT,
        provider="mock",
        model="mock-model",
        base_url="http://model.test",
    )
    with patch("zocai_gateway.run_pipeline.generate_text", fake_generate_text):
        RunPipeline(
            request,
            "budget-thinking",
            gate=EmitGate(sink=lambda event: events.append(dict(event))),
            text_sink=lambda _chunk: None,
            close=lambda: None,
            workspace_root=root,
        ).run()
    return [e["tokensUsed"] for e in events if e["type"] == "budget"]


@settings(max_examples=30, deadline=None)
@given(noise_a=st.integers(min_value=0, max_value=60), noise_b=st.integers(min_value=0, max_value=60))
def test_thinking_tokens_excluded_from_budget(noise_a: int, noise_b: int) -> None:
    """Property 24: budget tokensUsed is independent of the thinking response size.

    Feature: agent-reasoning-engine, Property 24

    **Validates: Requirements 10.3**
    """
    with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
        used_a = _budget_tokens_for_noise(noise_a, Path(a))
        used_b = _budget_tokens_for_noise(noise_b, Path(b))
    assert used_a == used_b


# ── Property 25: budget events mirror the live counters and window ───────────


@settings(max_examples=200, deadline=None)
@given(
    tokens_used=st.integers(min_value=-200, max_value=50000),
    iterations=st.integers(min_value=0, max_value=40),
    recoveries=st.integers(min_value=0, max_value=12),
    window=st.integers(min_value=0, max_value=200000),
)
def test_budget_events_mirror_counters_and_window(
    tokens_used: int, iterations: int, recoveries: int, window: int
) -> None:
    """Property 25: a budget event mirrors the live counters and the context window.

    Feature: agent-reasoning-engine, Property 25

    **Validates: Requirements 10.4**
    """
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        events: list[dict] = []
        pipeline = RunPipeline(
            AgentRunRequest(prompt="do", mode=Mode.AGENT),
            "budget-mirror",
            gate=EmitGate(sink=lambda event: events.append(dict(event))),
            text_sink=lambda _chunk: None,
            close=lambda: None,
            workspace_root=root,
        )
        orchestrator = Orchestrator(
            fsm=FSM(initial=Stage.APPLY_EDITS, run_id="r"),
            edits=EditCoordinator(toolset=FullToolset(root)),
            budget=Budget(file_iterations=iterations, error_recoveries=recoveries),
        )
        pipeline._emit_budget(_context(window), orchestrator, tokens_used)

    event = next(e for e in events if e["type"] == "budget")
    assert event["tokenLimit"] == window
    assert event["iterations"] == iterations
    assert event["recoveries"] == recoveries
    assert event["tokensUsed"] == max(tokens_used, 0)


# ── Property 26: the emit gate admits an event iff it conforms ───────────────


@st.composite
def _gate_payload(draw: st.DrawFn) -> tuple[dict, bool]:
    if draw(st.booleans()):
        kind = draw(st.sampled_from(["thinking", "summary", "done", "budget", "approval"]))
        if kind == "thinking":
            event = ThinkingEvent(seq=0, run_id="r", ts="t", text=draw(st.text(max_size=8)))
        elif kind == "summary":
            event = SummaryEvent(seq=0, run_id="r", ts="t", text=draw(st.text(max_size=8)))
        elif kind == "done":
            event = DoneEvent(seq=0, run_id="r", ts="t", ok=draw(st.booleans()))
        elif kind == "budget":
            event = BudgetEvent(
                seq=0, run_id="r", ts="t", tokens_used=1, token_limit=10, iterations=0, recoveries=0
            )
        else:
            event = ApprovalEvent(seq=0, run_id="r", ts="t", prompt=draw(st.text(max_size=8)))
        return event.model_dump(by_alias=True), True

    invalid = draw(
        st.sampled_from(
            [
                {},  # no discriminator
                {"type": "not-a-real-kind"},  # unknown discriminator
                {"type": "thinking"},  # missing required base fields
                {"type": "done", "ok": True},  # missing seq/runId/ts
                {"seq": 1, "runId": "r", "ts": "t"},  # no type at all
            ]
        )
    )
    return dict(invalid), False


@settings(max_examples=200)
@given(_gate_payload())
def test_emit_gate_admits_iff_conforming(case: tuple[dict, bool]) -> None:
    """Property 26: the gate forwards a payload iff it conforms; else blocks + records.

    Feature: agent-reasoning-engine, Property 26

    **Validates: Requirements 10.5, 10.8**
    """
    payload, conforming = case
    forwarded: list[dict] = []
    gate = EmitGate(sink=lambda event: forwarded.append(dict(event)))

    admitted = gate.emit(payload)

    assert admitted is conforming
    assert (len(forwarded) == 1) is conforming
    assert (len(gate.violations) == 1) is (not conforming)


# ── Property 27: sequence numbers are strictly increasing ────────────────────


@settings(max_examples=60, deadline=None)
@given(files=st.lists(_VALID_FILE, max_size=3, unique=True))
def test_sequence_numbers_strictly_increase(files: list[str]) -> None:
    """Property 27: every emitted event's seq strictly exceeds the previous one.

    Feature: agent-reasoning-engine, Property 27

    **Validates: Requirements 10.6**
    """

    class _Brain(DefaultAgentBrain):
        def structured_plan(self, request: AgentRunRequest, context: RunContext) -> AgentPlan:
            return AgentPlan.model_validate(
                {
                    "steps": [
                        {"file": f, "action": "create", "rationale": "make"} for f in files
                    ],
                    "confidence": 1.0,
                }
            )

        def edit_plan(self, request: AgentRunRequest, context: RunContext) -> EditPlan:
            return EditPlan(
                reasoning="apply",
                changes=tuple(PlannedChange(path=f, content="x\n", diff="+x") for f in files),
            )

        def run_checks(
            self, request: AgentRunRequest, plan: EditPlan
        ) -> tuple[int, str, str]:
            return (0, "noop-check", "")

    events: list[dict] = []
    with tempfile.TemporaryDirectory() as tmp:
        RunPipeline(
            AgentRunRequest(prompt="do", mode=Mode.AGENT),
            "seq-run",
            gate=EmitGate(sink=lambda event: events.append(dict(event))),
            text_sink=lambda _chunk: None,
            close=lambda: None,
            workspace_root=Path(tmp),
            brain=_Brain(),
        ).run()

    seqs = [e["seq"] for e in events]
    assert seqs, "expected the run to emit events"
    assert all(later > earlier for earlier, later in itertools.pairwise(seqs))
