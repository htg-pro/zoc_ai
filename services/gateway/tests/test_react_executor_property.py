"""Property + unit tests for the ReAct executor (Epic 10).

Feature: agent-reasoning-engine, Properties 17-23 (+ R8.6 prompt unit test).

The model boundary is a scripted ``run_with_tools`` returning deterministic
``ModelToolResponse`` sequences; the ``FullToolset`` runs against a real temp
workspace so confinement (Property 22) and file-iteration counting (Property
23) are genuine.
"""

from __future__ import annotations

import itertools
import tempfile
from collections.abc import Callable, Sequence
from pathlib import Path

from hypothesis import given, settings
from hypothesis import strategies as st
from zocai_gateway.context.steering_compiler import SteeringPayload
from zocai_gateway.context.token_gate import TokenGateResult
from zocai_gateway.edits import EditCoordinator
from zocai_gateway.fsm import FSM
from zocai_gateway.mode_router import AgentRunRequest, Mode
from zocai_gateway.model_allocator import Allocation
from zocai_gateway.model_interface import ModelTier
from zocai_gateway.model_runtime import ModelToolResponse, ToolCall
from zocai_gateway.orchestrator import Orchestrator
from zocai_gateway.plan import AgentPlan, EditStep
from zocai_gateway.react import ReAct_System_Prompt, ReActExecutor
from zocai_gateway.run_pipeline import RunContext
from zocai_gateway.stages import Stage
from zocai_gateway.toolsets import FullToolset


def _context() -> RunContext:
    return RunContext(
        allocation=Allocation(ModelTier.LOCAL_SLM, 4000),
        fragments=(),
        steering=SteeringPayload(),
        token_gate=TokenGateResult(fragments=(), dropped=(), token_count=0, window=4000),
        mcp_tools=(),
    )


def _plan(*steps: tuple[str, str, str]) -> AgentPlan:
    return AgentPlan(
        steps=[EditStep(file=f, action=a, rationale=r) for f, a, r in steps],
        confidence=1.0,
    )


def _build(
    root: Path, plan: AgentPlan, model: Callable[..., ModelToolResponse]
) -> tuple[ReActExecutor, list, list[dict]]:
    """Build a ReActExecutor over a real toolset with a call-recording model."""
    events: list = []
    toolset = FullToolset(root)
    fsm = FSM(initial=Stage.APPLY_EDITS, run_id="r", emit=events.append)
    orchestrator = Orchestrator(
        fsm=fsm,
        edits=EditCoordinator(toolset=toolset, run_id="r", emit=events.append),
        run_id="r",
        emit=events.append,
    )
    calls: list[dict] = []

    def recording_model(
        request: AgentRunRequest,
        *,
        system_prompt: str | None,
        tools: Sequence[object],
        tool_history: Sequence[object] = (),
        timeout: float = 120.0,
    ) -> ModelToolResponse:
        calls.append({"tool_history": list(tool_history), "system_prompt": system_prompt})
        return model(
            request,
            system_prompt=system_prompt,
            tools=tools,
            tool_history=tool_history,
            timeout=timeout,
        )

    executor = ReActExecutor(
        toolset=toolset,
        orchestrator=orchestrator,
        plan=plan,
        request=AgentRunRequest(prompt="do the task", mode=Mode.AGENT),
        context=_context(),
        emit=events.append,
        run_id="r",
        run_with_tools=recording_model,
    )
    return executor, events, calls


def _script(responses: Sequence[ModelToolResponse]) -> Callable[..., ModelToolResponse]:
    """A model that returns ``responses`` in order, then a terminal stop."""
    iterator = iter(responses)

    def model(*_args: object, **_kwargs: object) -> ModelToolResponse:
        try:
            return next(iterator)
        except StopIteration:
            return ModelToolResponse(text="done", tool_calls=(), finish_reason="stop")

    return model


# ── R8.6: ReAct system prompt content ────────────────────────────────────────


def test_react_system_prompt_instructs_the_contract() -> None:
    """R8.6: reason-before-call, use previous observation, text-only-done, checklist.

    _Requirements: 8.6_
    """
    prompt = ReAct_System_Prompt.lower()
    assert "reason" in prompt and "before" in prompt  # reason before each call
    assert "previous" in prompt or "observation" in prompt  # use the last observation
    assert "plain text only" in prompt  # respond with text only when finished
    assert "checklist" in prompt  # the plan is a progress checklist


# ── Property 17: ReAct never exceeds thirty steps ────────────────────────────


@settings(max_examples=30, deadline=None)
@given(reads_per_step=st.integers(min_value=1, max_value=3))
def test_react_never_exceeds_thirty_steps(reads_per_step: int) -> None:
    """Property 17: at most 30 model requests, none after the 30th step.

    Feature: agent-reasoning-engine, Property 17

    **Validates: Requirements 8.1, 8.7**
    """

    def never_stops(*_args: object, **_kwargs: object) -> ModelToolResponse:
        # Reads never satisfy a step and are not budget-counted, so the loop can
        # only ever stop at the 30-step bound.
        return ModelToolResponse(
            text="",
            tool_calls=tuple(
                ToolCall(id=f"c{i}", name="read_file", arguments={"path": "missing.py"})
                for i in range(reads_per_step)
            ),
            finish_reason="tool_calls",
        )

    with tempfile.TemporaryDirectory() as tmp:
        executor, _events, calls = _build(Path(tmp), _plan(("goal.py", "create", "r")), never_stops)
        outcome = executor.run()

    assert ReActExecutor.MAX_STEPS == 30
    assert len(calls) == 30  # exactly 30 requests, no 31st
    assert outcome.step_budget_exhausted is True


# ── Property 18: tool history accumulates in order ───────────────────────────


@settings(max_examples=40, deadline=None)
@given(counts=st.lists(st.integers(min_value=1, max_value=3), min_size=1, max_size=5))
def test_tool_history_accumulates_in_order(counts: list[int]) -> None:
    """Property 18: each request includes the full ordered history built so far.

    Feature: agent-reasoning-engine, Property 18

    **Validates: Requirements 8.2, 8.3**
    """
    responses = [
        ModelToolResponse(
            text="",
            tool_calls=tuple(
                ToolCall(id=f"s{step}c{i}", name="read_file", arguments={"path": "x.py"})
                for i in range(count)
            ),
            finish_reason="tool_calls",
        )
        for step, count in enumerate(counts)
    ]

    with tempfile.TemporaryDirectory() as tmp:
        executor, _events, calls = _build(Path(tmp), _plan(("goal.py", "create", "r")), _script(responses))
        executor.run()

    assert calls[0]["tool_history"] == []  # the first request carries no history
    for earlier, later in itertools.pairwise(calls):
        prior = earlier["tool_history"]
        # Every later request includes the full accumulated history as a prefix.
        assert later["tool_history"][: len(prior)] == prior
        # History strictly grows across steps that executed tool calls.
        assert len(later["tool_history"]) > len(prior)


# ── Property 19: a stop response executes no tools ───────────────────────────


@settings(max_examples=40, deadline=None)
@given(content=st.text(max_size=20))
def test_stop_response_executes_no_tools(content: str) -> None:
    """Property 19: a stop finish reason stops the loop and runs no tool call.

    Feature: agent-reasoning-engine, Property 19

    **Validates: Requirements 8.4**
    """
    stop_with_calls = ModelToolResponse(
        text="all done",
        tool_calls=(ToolCall(id="c1", name="write_file", arguments={"path": "a.py", "content": content}),),
        finish_reason="stop",
    )
    with tempfile.TemporaryDirectory() as tmp:
        executor, events, calls = _build(Path(tmp), _plan(("a.py", "create", "r")), _script([stop_with_calls]))
        outcome = executor.run()
        assert not (Path(tmp) / "a.py").exists()  # the tool call in a stop is not run

    assert outcome.stopped_reason == "stop"
    assert len(calls) == 1
    assert not any(e.type == "edit-file" for e in events)


# ── Property 20: the loop terminates on satisfaction or a non-tool response ──


@settings(max_examples=60, deadline=None)
@given(mode=st.sampled_from(["satisfy", "no_tools"]), extra=st.booleans())
def test_loop_terminates_on_satisfaction_or_non_tool_response(mode: str, extra: bool) -> None:
    """Property 20: stop on full satisfaction (ignoring the rest) or a no-tool reply.

    Feature: agent-reasoning-engine, Property 20

    **Validates: Requirements 8.5, 8.8**
    """
    with tempfile.TemporaryDirectory() as tmp:
        if mode == "satisfy":
            tool_calls = (ToolCall(id="c1", name="write_file", arguments={"path": "a.py", "content": "x"}),)
            if extra:
                # A trailing call in the same response must be ignored once the
                # step is satisfied (R8.5).
                tool_calls += (ToolCall(id="c2", name="write_file", arguments={"path": "b.py", "content": "y"}),)
            response = ModelToolResponse(text="", tool_calls=tool_calls, finish_reason="tool_calls")
            executor, _events, calls = _build(Path(tmp), _plan(("a.py", "create", "r")), _script([response]))
            outcome = executor.run()
            assert outcome.stopped_reason == "all_satisfied"
            assert outcome.satisfied_step_ids == ("edit-1",)
            assert len(calls) == 1
            if extra:
                assert not (Path(tmp) / "b.py").exists()  # remaining content ignored
        else:
            response = ModelToolResponse(text="thinking...", tool_calls=(), finish_reason="tool_calls")
            executor, _events, calls = _build(Path(tmp), _plan(("a.py", "create", "r")), _script([response]))
            outcome = executor.run()
            assert outcome.stopped_reason == "no_tool_calls"
            assert len(calls) == 1


# ── Property 21: tool activity surfaces only as edit-file and command ────────


@settings(max_examples=40, deadline=None)
@given(content=st.text(max_size=20))
def test_react_tool_activity_only_edit_file_and_command(content: str) -> None:
    """Property 21: mutations → one edit-file, shells → one command, reads → none.

    Feature: agent-reasoning-engine, Property 21

    **Validates: Requirements 9.1, 9.2, 9.3, 9.4**
    """
    response = ModelToolResponse(
        text="",
        tool_calls=(
            ToolCall(id="r", name="read_file", arguments={"path": "x.py"}),
            ToolCall(id="s", name="run_shell", arguments={"argv": ["echo", "hello"]}),
            ToolCall(id="w", name="write_file", arguments={"path": "other.py", "content": content}),
        ),
        finish_reason="tool_calls",
    )
    with tempfile.TemporaryDirectory() as tmp:
        # The plan step (goal.py) is never satisfied by the write to other.py,
        # so all three tool calls execute.
        executor, events, _calls = _build(Path(tmp), _plan(("goal.py", "create", "r")), _script([response]))
        executor.run()

    edit_events = [e for e in events if e.type == "edit-file"]
    command_events = [e for e in events if e.type == "command"]
    assert len(edit_events) == 1 and edit_events[0].path == "other.py"
    assert len(command_events) == 1
    assert command_events[0].command == "echo hello"
    assert command_events[0].status == "pass"


# ── Property 22: tool calls are confined and never abort the run ─────────────


@settings(max_examples=30, deadline=None)
@given(content=st.text(max_size=20))
def test_react_confinement_never_aborts(content: str) -> None:
    """Property 22: out-of-workspace + operational failures are observed, loop continues.

    Feature: agent-reasoning-engine, Property 22

    **Validates: Requirements 9.5, 9.6**
    """
    script = [
        # Out-of-workspace write: rejected, no effect, loop continues (R9.5).
        ModelToolResponse("", (ToolCall(id="1", name="write_file", arguments={"path": "../escape.py", "content": "x"}),), "tool_calls"),
        # In-workspace operational failure: deleting a missing file (R9.6).
        ModelToolResponse("", (ToolCall(id="2", name="delete_file", arguments={"path": "missing.py"}),), "tool_calls"),
        # A valid write that satisfies the plan and stops the loop.
        ModelToolResponse("", (ToolCall(id="3", name="write_file", arguments={"path": "ok.py", "content": content}),), "tool_calls"),
    ]
    with tempfile.TemporaryDirectory() as tmp:
        executor, events, calls = _build(Path(tmp), _plan(("ok.py", "create", "r")), _script(script))
        outcome = executor.run()
        assert (Path(tmp) / "ok.py").exists()  # the loop continued past both failures

    edit_events = [e for e in events if e.type == "edit-file"]
    assert len(edit_events) == 1 and edit_events[0].path == "ok.py"  # rejections emitted nothing
    assert len(calls) == 3  # all three steps ran; the run never aborted
    assert outcome.stopped_reason == "all_satisfied"


# ── Property 23: file iterations are counted and bounded by the ceiling ──────


@settings(max_examples=40, deadline=None)
@given(n_writes=st.integers(min_value=1, max_value=25))
def test_react_file_iterations_counted_and_bounded(n_writes: int) -> None:
    """Property 23: +1 per successful mutation; PAUSED + approval before exceeding 20.

    Feature: agent-reasoning-engine, Property 23

    **Validates: Requirements 10.1, 10.2, 10.7**
    """
    responses = [
        ModelToolResponse(
            text="",
            tool_calls=(ToolCall(id=f"c{i}", name="write_file", arguments={"path": f"f{i}.py", "content": f"v{i}"}),),
            finish_reason="tool_calls",
        )
        for i in range(n_writes)
    ]
    with tempfile.TemporaryDirectory() as tmp:
        # The plan step (goal.py) is never satisfied by the f{i}.py writes.
        executor, events, _calls = _build(Path(tmp), _plan(("goal.py", "create", "never")), _script(responses))
        outcome = executor.run()

    edit_events = [e for e in events if e.type == "edit-file"]
    approvals = [e for e in events if e.type == "approval"]
    budget = executor.orchestrator.budget

    if n_writes <= 20:
        assert budget.file_iterations == n_writes  # +1 per successful mutation
        assert len(edit_events) == n_writes
        assert outcome.paused is False
        assert approvals == []
    else:
        assert budget.file_iterations == 20  # never exceeds the File_Ceiling
        assert len(edit_events) == 20
        assert outcome.paused is True
        assert len(approvals) == 1  # an approval was emitted before the 21st
        assert executor.orchestrator.fsm.current is Stage.PAUSED
