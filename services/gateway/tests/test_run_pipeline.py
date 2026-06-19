"""Integration tests for the end-to-end run pipeline composition (task 14.1).

These exercise the wired backend graph directly (without the SSE transport):
the allocator-first IntentEvent (R1.9), single-ordered emission (R6.5), the
text-only Ask channel (R6.6), hot-swap state preservation at the recovery
ceiling (R11.1), and verified-run trajectory recording (R12).
"""

from __future__ import annotations

from pathlib import Path

from zocai_evolution import EvolutionEngine

from zocai_gateway.edits import EditPlan, PlannedChange
from zocai_gateway.emit_gate import EmitGate
from zocai_gateway.hardware_probe import HardwareProfile
from zocai_gateway.hot_swap import HotSwapOutcomeKind
from zocai_gateway.memory.matrix import MemoryMatrix
from zocai_gateway.memory.state_wrapper import StateWrapperStore
from zocai_gateway.mode_router import AgentRunRequest, Mode
from zocai_gateway.model_allocator import Allocation
from zocai_gateway.model_interface import ModelTier
from zocai_gateway.run_pipeline import (
    AllocationSignals,
    DefaultAgentBrain,
    RunContext,
    RunPipeline,
    RuntimeAgentBrain,
)
from zocai_gateway.stages import Stage
from zocai_gateway.context.steering_compiler import SteeringPayload
from zocai_gateway.context.token_gate import TokenGateResult


def _gate() -> tuple[list[dict[str, object]], EmitGate]:
    events: list[dict[str, object]] = []
    gate = EmitGate(sink=lambda e: events.append(dict(e)))
    return events, gate


def test_runtime_agent_brain_parses_model_json(monkeypatch) -> None:
    def fake_generate_text(*_args: object, **_kwargs: object) -> str:
        return (
            '{"reasoning":"create greeting","changes":['
            '{"path":"src/hello.txt","content":"hello\\n","diff":"create file"}'
            "]}"
        )

    monkeypatch.setattr("zocai_gateway.run_pipeline.generate_text", fake_generate_text)
    context = RunContext(
        allocation=Allocation(ModelTier.LOCAL_SLM, 4000),
        fragments=(),
        steering=SteeringPayload(),
        token_gate=TokenGateResult(fragments=(), dropped=(), token_count=0, window=4000),
        mcp_tools=(),
    )

    plan = RuntimeAgentBrain().edit_plan(
        AgentRunRequest(
            prompt="create a greeting file",
            mode=Mode.AGENT,
            provider="mock",
            model="mock-model",
            base_url="http://model.test",
        ),
        context,
    )

    assert plan.reasoning == "create greeting"
    assert plan.changes == (
        PlannedChange(path="src/hello.txt", content="hello\n", diff="create file"),
    )


def test_agent_run_drives_to_done_with_intent_first(tmp_path: Path) -> None:
    events, gate = _gate()
    pipeline = RunPipeline(
        AgentRunRequest(prompt="add a feature", mode="agent"),
        "run-agent",
        gate=gate,
        text_sink=lambda chunk: None,
        close=lambda: None,
        workspace_root=tmp_path,
    )

    result = pipeline.run()

    assert result.stage is Stage.DONE
    # R1.9: the run's first emitted event records tier + window.
    assert events[0]["type"] == "intent"
    assert events[0]["modelTier"] == "local-slm"
    assert events[0]["contextWindowTokens"] == 4000
    assert events[0]["fallbackReason"] is None
    # The terminal event closes the run (R3.4).
    assert events[-1]["type"] == "done"


def test_emission_uses_one_monotonic_sequence(tmp_path: Path) -> None:
    # R6.5: every producer shares one ordered sequence so the bus is ordered.
    events, gate = _gate()
    RunPipeline(
        AgentRunRequest(prompt="ship it", mode="agent"),
        "run-seq",
        gate=gate,
        text_sink=lambda chunk: None,
        close=lambda: None,
        workspace_root=tmp_path,
    ).run()

    seqs = [int(e["seq"]) for e in events]  # type: ignore[call-overload]
    assert seqs == sorted(seqs)
    assert len(seqs) == len(set(seqs))


def test_done_closes_the_stream(tmp_path: Path) -> None:
    closed = {"n": 0}
    _events, gate = _gate()

    def close() -> None:
        closed["n"] += 1

    RunPipeline(
        AgentRunRequest(prompt="x", mode="agent"),
        "run-close",
        gate=gate,
        text_sink=lambda chunk: None,
        close=close,
        workspace_root=tmp_path,
    ).run()

    assert closed["n"] == 1


def test_ask_run_streams_text_only(tmp_path: Path) -> None:
    # R6.6: Ask Mode emits raw text chunks, no structured rows on the gate.
    events, gate = _gate()
    chunks: list[str] = []
    pipeline = RunPipeline(
        AgentRunRequest(prompt="what is this codebase?", mode="ask"),
        "run-ask",
        gate=gate,
        text_sink=chunks.append,
        close=lambda: None,
        workspace_root=tmp_path,
    )

    result = pipeline.run()

    assert result.ask_text == "what is this codebase?"
    assert chunks == ["what is this codebase?"]
    assert events == []  # nothing went through the structured contract gate


def test_fallback_reason_recorded_on_first_event(tmp_path: Path) -> None:
    # R1.6/R1.9: missing hardware forces the Local SLM fallback and the reason
    # is carried on the first emitted event.
    events, gate = _gate()

    class FallbackBrain(DefaultAgentBrain):
        def allocation_signals(self, request: AgentRunRequest) -> AllocationSignals:
            return AllocationSignals(complexity=0.9, latency_ms=None, hardware=None)

    RunPipeline(
        AgentRunRequest(prompt="hard task", mode="agent"),
        "run-fb",
        gate=gate,
        text_sink=lambda chunk: None,
        close=lambda: None,
        workspace_root=tmp_path,
        brain=FallbackBrain(),
    ).run()

    assert events[0]["modelTier"] == "local-slm"
    assert events[0]["fallbackReason"] == "hardware_or_latency_unavailable"


def test_verified_done_records_trajectory(tmp_path: Path) -> None:
    # R12.1: a verified DONE run records a trajectory on the Evolution_Engine.
    _events, gate = _gate()
    engine = EvolutionEngine()
    RunPipeline(
        AgentRunRequest(prompt="task", mode="agent"),
        "run-evo",
        gate=gate,
        text_sink=lambda chunk: None,
        close=lambda: None,
        workspace_root=tmp_path,
        evolution=engine,
    ).run()

    assert engine.bus.collected_count() == 1


class _RecoveryExhaustingBrain(DefaultAgentBrain):
    """Always fails RUN_CHECKS with a differing, failure-referencing remediation.

    Each remediation proposes a distinct edit (so it differs from the prior plan
    per R5.6) that references the failed command, driving the error-recovery
    budget to its ceiling so the pipeline must freeze and hot-swap, preserving
    run state to the State_Wrapper (R11.1).
    """

    def __init__(self) -> None:
        self._n = 0

    def run_checks(
        self, request: AgentRunRequest, plan: EditPlan
    ) -> tuple[int, str, str]:
        return (1, "pytest", "assertion failed")

    def remediation_plan(self, prior: EditPlan, failure: object) -> EditPlan | None:
        self._n += 1
        return EditPlan(
            reasoning=f"retry {self._n} after pytest failure",
            changes=(
                PlannedChange(
                    path=f"fix{self._n}.py",
                    content=f"patched {self._n}",
                    diff=f"+patched {self._n}",
                ),
            ),
        )


def test_recovery_ceiling_preserves_state_and_hot_swaps(tmp_path: Path) -> None:
    _events, gate = _gate()
    store = StateWrapperStore(MemoryMatrix(tmp_path).state_wrapper_path)

    result = RunPipeline(
        AgentRunRequest(prompt="flaky", mode="agent"),
        "run-swap",
        gate=gate,
        text_sink=lambda chunk: None,
        close=lambda: None,
        workspace_root=tmp_path,
        state_store=store,
        brain=_RecoveryExhaustingBrain(),
    ).run()

    # R11.1: the run is frozen/paused, state is serialized to the wrapper, and
    # the coordinator upshifts off the Local SLM tier.
    assert result.paused is True
    assert result.hot_swap is not None
    assert result.hot_swap.kind is HotSwapOutcomeKind.UPSHIFTED
    assert result.hot_swap.new_tier is ModelTier.EDGE
    assert store.exists() is True
    saved = store.load()
    assert saved.stage is Stage.PLAN_EDITS
    # the applied remediation edits were preserved across the swap
    assert saved.patch_diffs
    assert all(diff.path.startswith("fix") for diff in saved.patch_diffs)
