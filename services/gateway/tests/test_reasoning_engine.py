from __future__ import annotations

from pathlib import Path

from pydantic import ValidationError
from zocai_gateway.context.steering_compiler import SteeringPayload
from zocai_gateway.context.token_gate import TokenGateResult
from zocai_gateway.edits import EditPlan, PlannedChange
from zocai_gateway.emit_gate import EmitGate
from zocai_gateway.mode_router import AgentRunRequest, Mode
from zocai_gateway.model_allocator import Allocation
from zocai_gateway.model_interface import ModelTier
from zocai_gateway.model_runtime import ModelRuntimeError
from zocai_gateway.plan import AgentPlan
from zocai_gateway.run_pipeline import (
    DefaultAgentBrain,
    RunContext,
    RunPipeline,
    RuntimeAgentBrain,
    _agent_system_prompt,
    _extract_thinking,
    _has_think_block,
)
from zocai_gateway.stages import Stage


def _context() -> RunContext:
    return RunContext(
        allocation=Allocation(ModelTier.LOCAL_SLM, 4000),
        fragments=(),
        steering=SteeringPayload(),
        token_gate=TokenGateResult(
            fragments=(), dropped=(), token_count=0, window=4000
        ),
        mcp_tools=(),
    )


def _request() -> AgentRunRequest:
    return AgentRunRequest(
        prompt="modify the parser",
        mode=Mode.AGENT,
        provider="mock",
        model="mock-model",
        base_url="http://model.test",
        max_tokens=4096,
    )


def test_thinking_call_is_bounded_and_extracts_only_think_block(monkeypatch) -> None:
    calls: list[tuple[AgentRunRequest, dict[str, object]]] = []

    def fake_generate_text(request: AgentRunRequest, **kwargs: object) -> str:
        calls.append((request, kwargs))
        return "<think>Inspect parser.py and preserve error handling.</think>ignored"

    monkeypatch.setattr("zocai_gateway.run_pipeline.generate_text", fake_generate_text)

    scratchpad = RuntimeAgentBrain().think(_request(), _context())

    assert scratchpad == "Inspect parser.py and preserve error handling."
    assert calls[0][0].max_tokens == 1024
    assert "Wrap ALL your reasoning" in str(calls[0][1]["system_prompt"])
    assert _extract_thinking("no tags") == ""


def test_structured_plan_uses_response_format_and_retries_validation(monkeypatch) -> None:
    responses = iter(
        [
            '{"steps":[],"confidence":2}',
            (
                '{"steps":[{"file":"src/parser.py","action":"modify",'
                '"rationale":"Handle malformed input.","search_replace":null}],'
                '"verification_command":"pytest","confidence":0.8}'
            ),
        ]
    )
    calls: list[tuple[AgentRunRequest, dict[str, object]]] = []

    def fake_generate_text(request: AgentRunRequest, **kwargs: object) -> str:
        calls.append((request, kwargs))
        return next(responses)

    monkeypatch.setattr("zocai_gateway.run_pipeline.generate_text", fake_generate_text)

    plan = RuntimeAgentBrain().structured_plan(_request(), _context())

    assert plan.steps[0].file == "src/parser.py"
    assert calls[0][1]["response_format"] is not None
    assert "Your previous plan had this JSON error" in calls[1][0].prompt


def test_structured_plan_falls_back_when_response_format_is_unsupported(monkeypatch) -> None:
    calls: list[dict[str, object]] = []

    def fake_generate_text(_request: AgentRunRequest, **kwargs: object) -> str:
        calls.append(kwargs)
        if len(calls) == 1:
            raise ModelRuntimeError("response_format is unsupported")
        return '{"steps":[],"verification_command":null,"confidence":1}'

    monkeypatch.setattr("zocai_gateway.run_pipeline.generate_text", fake_generate_text)

    plan = RuntimeAgentBrain().structured_plan(_request(), _context())

    assert plan.steps == []
    assert calls[0]["response_format"] is not None
    assert "AgentPlan schema" in str(calls[1]["system_prompt"])


def test_agent_plan_rejects_paths_outside_workspace() -> None:
    try:
        AgentPlan.model_validate(
            {
                "steps": [
                    {
                        "file": "../secrets.txt",
                        "action": "modify",
                        "rationale": "Do not allow escape.",
                    }
                ],
                "confidence": 0.5,
            }
        )
    except ValidationError:
        pass
    else:  # pragma: no cover - assertion branch
        raise AssertionError("out-of-workspace plan path was accepted")


def test_pipeline_emits_scratchpad_before_analyze_and_injects_it(tmp_path: Path) -> None:
    events: list[dict[str, object]] = []

    class ThinkingBrain(DefaultAgentBrain):
        seen_system_prompt = ""

        def think(self, request: AgentRunRequest, context: RunContext) -> str:
            return "Check edge cases before editing."

        def edit_plan(self, request: AgentRunRequest, context: RunContext) -> EditPlan:
            self.seen_system_prompt = _agent_system_prompt(context)
            return EditPlan(reasoning="No changes needed.")

    brain = ThinkingBrain()
    result = RunPipeline(
        AgentRunRequest(prompt="explain parser", mode=Mode.AGENT),
        "reasoning-order",
        gate=EmitGate(sink=lambda event: events.append(dict(event))),
        text_sink=lambda _chunk: None,
        close=lambda: None,
        workspace_root=tmp_path,
        brain=brain,
    ).run()

    scratch_index = next(
        index
        for index, event in enumerate(events)
        if event["type"] == "thinking"
        and event.get("gist") == "Private task analysis"
    )
    analyze_index = next(
        index
        for index, event in enumerate(events)
        if event["type"] == "thinking" and event.get("text") == "analyze"
    )
    assert result.stage.value == "done"
    assert events[0]["type"] == "intent"
    assert scratch_index < analyze_index
    assert "Check edge cases before editing." in brain.seen_system_prompt


def test_pipeline_emits_recovery_before_requesting_remediation(tmp_path: Path) -> None:
    events: list[dict[str, object]] = []

    class RecoveringBrain(DefaultAgentBrain):
        check_count = 0
        recovery_was_visible = False

        def edit_plan(self, request: AgentRunRequest, context: RunContext) -> EditPlan:
            return EditPlan(reasoning="Run verification first.")

        def run_checks(
            self, request: AgentRunRequest, plan: EditPlan
        ) -> tuple[int, str, str]:
            self.check_count += 1
            if self.check_count == 1:
                return (
                    1,
                    "pytest",
                    "FAILED tests/test_parser.py::test_invalid - AssertionError",
                )
            return (0, "pytest", "1 passed")

        def remediation_plan(self, prior: EditPlan, failure: object) -> EditPlan:
            self.recovery_was_visible = any(
                event["type"] == "recovery-attempt" for event in events
            )
            return EditPlan(
                reasoning="Fix FAILED tests/test_parser.py::test_invalid - AssertionError",
                changes=(
                    PlannedChange(
                        path="parser.py",
                        content="fixed = True\n",
                        diff="+fixed = True",
                    ),
                ),
            )

    brain = RecoveringBrain()
    result = RunPipeline(
        AgentRunRequest(prompt="fix parser", mode=Mode.AGENT),
        "recovery-order",
        gate=EmitGate(sink=lambda event: events.append(dict(event))),
        text_sink=lambda _chunk: None,
        close=lambda: None,
        workspace_root=tmp_path,
        brain=brain,
    ).run()

    recovery = next(event for event in events if event["type"] == "recovery-attempt")
    assert result.stage.value == "done"
    assert brain.recovery_was_visible is True
    assert recovery["attempt"] == 1
    assert recovery["failures"] == [
        "tests/test_parser.py::test_invalid - AssertionError"
    ]


# ── Task 1.7: thinking bounds, isolation, and failure modes ──────────────────


def _no_provider_request() -> AgentRunRequest:
    return AgentRunRequest(prompt="explain the parser", mode=Mode.AGENT)


def test_thinking_issued_as_a_separate_bounded_call(monkeypatch) -> None:
    """R1.1/R1.2: the thinking request is a separate call bounded to 1024 tokens
    with the thinking system prompt and a 60s timeout."""
    calls: list[tuple[AgentRunRequest, dict[str, object]]] = []

    def fake_generate_text(request: AgentRunRequest, **kwargs: object) -> str:
        calls.append((request, kwargs))
        return "<think>reason</think>"

    monkeypatch.setattr("zocai_gateway.run_pipeline.generate_text", fake_generate_text)
    RuntimeAgentBrain().think(_request(), _context())

    assert len(calls) == 1  # a request separate from planning/execution
    assert calls[0][0].max_tokens == 1024
    assert calls[0][1]["timeout"] == 60.0
    assert "Wrap ALL your reasoning" in str(calls[0][1]["system_prompt"])


def test_empty_think_block_proceeds_without_scratchpad(monkeypatch) -> None:
    """R1.3 vs R2.4 boundary: a complete-but-empty block yields no scratchpad."""
    for response in ("<think></think>", "<think>   </think>", "prefix<think>\n\t </think>tail"):
        assert _has_think_block(response) is True
        monkeypatch.setattr(
            "zocai_gateway.run_pipeline.generate_text", lambda *_a, _resp=response, **_k: _resp
        )
        assert RuntimeAgentBrain().think(_request(), _context()) == ""


def test_missing_think_block_raises(monkeypatch) -> None:
    """R2.4: a non-empty response with no complete block fails closed (raises)."""
    for response in ("no tags at all", "<think>unclosed reasoning", "</think> only close"):
        assert _has_think_block(response) is False
        monkeypatch.setattr(
            "zocai_gateway.run_pipeline.generate_text", lambda *_a, _resp=response, **_k: _resp
        )
        try:
            RuntimeAgentBrain().think(_request(), _context())
        except RuntimeError:
            pass
        else:  # pragma: no cover - assertion branch
            raise AssertionError(f"missing block should have raised for {response!r}")


def test_no_provider_yields_no_scratchpad(monkeypatch) -> None:
    """R1.7: with no provider configured the thinking layer produces no scratchpad."""
    # No monkeypatch of the endpoint: the real generate_text returns None for an
    # unconfigured provider without any network call.
    assert RuntimeAgentBrain().think(_no_provider_request(), _context()) == ""


def test_no_provider_run_advances_intake_to_analyze_without_thinking_event(
    tmp_path: Path,
) -> None:
    """R1.7/R1.8: a no-provider run advances INTAKE→ANALYZE and emits no thinking row."""
    events: list[dict[str, object]] = []
    result = RunPipeline(
        _no_provider_request(),
        "no-provider",
        gate=EmitGate(sink=lambda event: events.append(dict(event))),
        text_sink=lambda _chunk: None,
        close=lambda: None,
        workspace_root=tmp_path,
        brain=DefaultAgentBrain(),
    ).run()
    assert result.stage is Stage.DONE
    assert any(e["type"] == "thinking" and e.get("text") == "analyze" for e in events)
    assert not any(
        e["type"] == "thinking" and e.get("gist") == "Private task analysis" for e in events
    )


def test_thinking_model_error_raises_runtime_error(monkeypatch) -> None:
    """R2.5: a model-runtime error during thinking is raised (→ ERROR_CLOSED)."""

    def boom(*_args: object, **_kwargs: object) -> str:
        raise ModelRuntimeError("thinking endpoint timed out")

    monkeypatch.setattr("zocai_gateway.run_pipeline.generate_text", boom)
    try:
        RuntimeAgentBrain().think(_request(), _context())
    except RuntimeError:
        pass
    else:  # pragma: no cover - assertion branch
        raise AssertionError("a model-runtime thinking error should raise")


def test_thinking_error_drives_run_to_error_closed(tmp_path: Path, monkeypatch) -> None:
    """R2.5: a thinking model error drives the whole run to ERROR_CLOSED."""

    def boom(*_args: object, **_kwargs: object) -> str:
        raise ModelRuntimeError("thinking endpoint failed")

    monkeypatch.setattr("zocai_gateway.run_pipeline.generate_text", boom)
    events: list[dict[str, object]] = []
    result = RunPipeline(
        _request(),
        "thinking-error",
        gate=EmitGate(sink=lambda event: events.append(dict(event))),
        text_sink=lambda _chunk: None,
        close=lambda: None,
        workspace_root=tmp_path,
    ).run()
    assert result.stage is Stage.ERROR_CLOSED


# ── Task 2.2: structured planning control flow ───────────────────────────────


def test_structured_plan_anthropic_embeds_schema_in_prompt(monkeypatch) -> None:
    """R3.3: an anthropic provider embeds the schema in the prompt (no response_format)."""
    calls: list[dict[str, object]] = []

    def fake_generate_text(_request: AgentRunRequest, **kwargs: object) -> str:
        calls.append(kwargs)
        return '{"steps":[],"verification_command":null,"confidence":1}'

    monkeypatch.setattr("zocai_gateway.run_pipeline.generate_text", fake_generate_text)
    request = _request().model_copy(update={"provider": "anthropic"})
    RuntimeAgentBrain().structured_plan(request, _context())

    assert calls[0]["response_format"] is None
    assert "AgentPlan schema" in str(calls[0]["system_prompt"])


def test_structured_plan_double_failure_raises(monkeypatch) -> None:
    """R4.2: an invalid plan that stays invalid after the single retry raises."""

    def always_invalid(*_args: object, **_kwargs: object) -> str:
        return '{"steps":[],"confidence":2}'  # confidence out of [0,1]

    monkeypatch.setattr("zocai_gateway.run_pipeline.generate_text", always_invalid)
    try:
        RuntimeAgentBrain().structured_plan(_request(), _context())
    except RuntimeError:
        pass
    else:  # pragma: no cover - assertion branch
        raise AssertionError("a double plan failure should raise (→ ERROR_CLOSED)")


def test_structured_plan_empty_retry_raises(monkeypatch) -> None:
    """R4.2: an empty corrected plan on the retry raises."""
    responses = iter(['{"steps":[],"confidence":2}', ""])
    monkeypatch.setattr(
        "zocai_gateway.run_pipeline.generate_text",
        lambda *_a, **_k: next(responses),
    )
    try:
        RuntimeAgentBrain().structured_plan(_request(), _context())
    except RuntimeError:
        pass
    else:  # pragma: no cover - assertion branch
        raise AssertionError("an empty retry should raise (→ ERROR_CLOSED)")


def test_structured_plan_no_provider_returns_empty_plan() -> None:
    """R4.3: with no provider the planner yields an empty plan with confidence 1."""
    plan = RuntimeAgentBrain().structured_plan(_no_provider_request(), _context())
    assert plan.steps == []
    assert plan.confidence == 1.0
