"""ReAct trust gate (Part 7.1): the permission gate refuses side-effecting tools
the policy does not allow, without executing them, and never aborts the run."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from zocai_gateway.context.steering_compiler import SteeringPayload
from zocai_gateway.context.token_gate import TokenGateResult
from zocai_gateway.edits import EditCoordinator
from zocai_gateway.fsm import FSM
from zocai_gateway.mode_router import AgentRunRequest, Mode
from zocai_gateway.model_allocator import Allocation
from zocai_gateway.model_interface import ModelTier
from zocai_gateway.model_runtime import ModelToolResponse, ToolCall
from zocai_gateway.orchestrator import Orchestrator
from zocai_gateway.permissions import Decision
from zocai_gateway.plan import AgentPlan, EditStep
from zocai_gateway.react import ReActExecutor
from zocai_gateway.run_pipeline import ReActApplyExecutor, RunContext
from zocai_gateway.security import security_log_path
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


def _run(root: Path, check_permission, response: ModelToolResponse):
    events: list = []
    toolset = FullToolset(root)
    fsm = FSM(initial=Stage.APPLY_EDITS, run_id="r", emit=events.append)
    orchestrator = Orchestrator(
        fsm=fsm,
        edits=EditCoordinator(toolset=toolset, run_id="r", emit=events.append),
        run_id="r",
        emit=events.append,
    )
    script = iter([response])

    def model(*_a: object, **_k: object) -> ModelToolResponse:
        try:
            return next(script)
        except StopIteration:
            return ModelToolResponse(text="done", tool_calls=(), finish_reason="stop")

    # The plan step (goal.py) is never satisfied by these calls, so every tool
    # call in the response is attempted.
    executor = ReActExecutor(
        toolset=toolset,
        orchestrator=orchestrator,
        plan=AgentPlan(
            steps=[EditStep(file="goal.py", action="create", rationale="r")], confidence=1.0
        ),
        request=AgentRunRequest(prompt="do", mode=Mode.AGENT),
        context=_context(),
        emit=events.append,
        run_id="r",
        run_with_tools=model,
        check_permission=check_permission,
    )
    executor.run()
    return events


_RESPONSE = ModelToolResponse(
    text="",
    tool_calls=(
        ToolCall(id="w", name="write_file", arguments={"path": "ok.py", "content": "x = 1\n"}),
        ToolCall(id="s", name="run_shell", arguments={"argv": ["echo", "hi"]}),
    ),
    finish_reason="tool_calls",
)


def test_gate_allows_fs_and_denies_terminal() -> None:
    def gate(kind: str, _name: str, _target: str) -> Decision:
        effect = "allow" if kind == "fs" else "deny"
        return Decision(effect, f"test {effect}")

    with tempfile.TemporaryDirectory() as tmp:
        events = _run(Path(tmp), gate, _RESPONSE)
        assert (Path(tmp) / "ok.py").exists()  # fs allowed → written
    edits = [e for e in events if e.type == "edit-file"]
    commands = [e for e in events if e.type == "command"]
    permissions = [e for e in events if e.type == "permission"]
    assert [e.path for e in edits] == ["ok.py"]
    assert commands == []  # terminal denied → never executed, no command row
    assert [(e.kind, e.name, e.effect) for e in permissions] == [
        ("fs", "write_file", "allow"),
        ("terminal", "run_shell", "deny"),
    ]
    assert all(e.run_id == "r" and e.reason for e in permissions)


def test_gate_denies_fs_write() -> None:
    def gate(_kind: str, _name: str, _target: str) -> Decision:
        return Decision("deny", "test deny")

    with tempfile.TemporaryDirectory() as tmp:
        events = _run(Path(tmp), gate, _RESPONSE)
        assert not (Path(tmp) / "ok.py").exists()  # fs denied → not written
    assert not any(e.type == "edit-file" for e in events)
    assert not any(e.type == "command" for e in events)


def test_allow_all_gate_executes_both() -> None:
    def gate(_kind: str, _name: str, _target: str) -> Decision:
        return Decision("allow", "test allow")

    with tempfile.TemporaryDirectory() as tmp:
        events = _run(Path(tmp), gate, _RESPONSE)
        assert (Path(tmp) / "ok.py").exists()
    assert any(e.type == "edit-file" for e in events)
    assert any(e.type == "command" for e in events)  # both ran when allowed


def test_read_tool_is_permission_checked_and_audited() -> None:
    calls: list[tuple[str, str, str]] = []

    def gate(kind: str, name: str, target: str) -> Decision:
        calls.append((kind, name, target))
        return Decision("allow", "Read-only action.")

    response = ModelToolResponse(
        text="",
        tool_calls=(ToolCall(id="r1", name="read_file", arguments={"path": "input.txt"}),),
        finish_reason="tool_calls",
    )
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "input.txt").write_text("hello", encoding="utf-8")
        events = _run(root, gate, response)

    assert calls == [("fs", "read_file", "input.txt")]
    audit = [event for event in events if event.type == "permission"]
    assert len(audit) == 1
    assert audit[0].effect == "allow"
    assert audit[0].target == "input.txt"


def test_react_apply_executor_forwards_check_permission() -> None:
    """The pipeline's ReActApplyExecutor threads check_permission into the loop."""

    def gate(kind: str, _name: str, _target: str) -> Decision:
        effect = "allow" if kind == "fs" else "deny"
        return Decision(effect, f"test {effect}")

    events: list = []
    with tempfile.TemporaryDirectory() as tmp:
        toolset = FullToolset(Path(tmp))
        fsm = FSM(initial=Stage.APPLY_EDITS, run_id="r", emit=events.append)
        orchestrator = Orchestrator(
            fsm=fsm,
            edits=EditCoordinator(toolset=toolset, run_id="r", emit=events.append),
            run_id="r",
            emit=events.append,
        )
        script = iter([_RESPONSE])

        def model(*_a: object, **_k: object) -> ModelToolResponse:
            try:
                return next(script)
            except StopIteration:
                return ModelToolResponse(text="done", tool_calls=(), finish_reason="stop")

        ReActApplyExecutor(
            toolset=toolset,
            orchestrator=orchestrator,
            structured_plan=AgentPlan(
                steps=[EditStep(file="goal.py", action="create", rationale="r")], confidence=1.0
            ),
            request=AgentRunRequest(prompt="do", mode=Mode.AGENT),
            context=_context(),
            emit=events.append,
            run_id="r",
            tokens_used=0,
            run_with_tools=model,
            check_permission=gate,
        ).apply()
        assert (Path(tmp) / "ok.py").exists()  # fs allowed through the pipeline layer

    assert not any(
        e.type == "command" for e in events
    )  # terminal denied through the pipeline layer


# ── Part 7.1 polish: `prompt` → interactive approval ──────────────────────────


class _Verdict:
    """Minimal stand-in for a recorded DecisionRequest (`.decision` verdict)."""

    def __init__(self, decision: str) -> None:
        self.decision = decision


_WRITE_ONLY = ModelToolResponse(
    text="",
    tool_calls=(
        ToolCall(id="w", name="write_file", arguments={"path": "ok.py", "content": "x=1\n"}),
    ),
    finish_reason="tool_calls",
)


def _run_prompt(root: Path, check_permission, wait_for_permission) -> list:
    events: list = []
    toolset = FullToolset(root)
    fsm = FSM(initial=Stage.APPLY_EDITS, run_id="r", emit=events.append)
    orchestrator = Orchestrator(
        fsm=fsm,
        edits=EditCoordinator(toolset=toolset, run_id="r", emit=events.append),
        run_id="r",
        emit=events.append,
    )
    script = iter([_WRITE_ONLY])

    def model(*_a: object, **_k: object) -> ModelToolResponse:
        try:
            return next(script)
        except StopIteration:
            return ModelToolResponse(text="done", tool_calls=(), finish_reason="stop")

    ReActExecutor(
        toolset=toolset,
        orchestrator=orchestrator,
        plan=AgentPlan(
            steps=[EditStep(file="goal.py", action="create", rationale="r")], confidence=1.0
        ),
        request=AgentRunRequest(prompt="do", mode=Mode.AGENT),
        context=_context(),
        emit=events.append,
        run_id="r",
        run_with_tools=model,
        check_permission=check_permission,
        wait_for_permission=wait_for_permission,
    ).run()
    return events


def test_prompt_decision_with_approval_emits_event_and_proceeds() -> None:
    calls: list[float | None] = []

    def waiter(timeout: float | None) -> object:
        calls.append(timeout)
        return _Verdict("approve")

    with tempfile.TemporaryDirectory() as tmp:
        events = _run_prompt(
            Path(tmp), lambda _k, _n, _t: Decision("prompt", "test prompt"), waiter
        )
        assert (Path(tmp) / "ok.py").exists()  # approved → the write proceeds
    assert any(e.type == "approval" for e in events)  # an ApprovalEvent was emitted
    assert any(e.type == "edit-file" for e in events)
    assert calls and calls[0] is not None  # the waiter was called with a bounded timeout


def test_prompt_decision_with_rejection_refuses() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        events = _run_prompt(
            Path(tmp),
            lambda _k, _n, _t: Decision("prompt", "test prompt"),
            lambda _timeout: _Verdict("reject"),
        )
        assert not (Path(tmp) / "ok.py").exists()  # rejected → the write is skipped
    assert any(e.type == "approval" for e in events)  # still asked for approval
    assert not any(e.type == "edit-file" for e in events)


def test_prompt_decision_timeout_refuses() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        events = _run_prompt(
            Path(tmp), lambda _k, _n, _t: Decision("prompt", "test prompt"), lambda _timeout: None
        )
        assert not (Path(tmp) / "ok.py").exists()  # None (timeout) → fail-closed refuse
    assert any(e.type == "approval" for e in events)


def test_prompt_without_waiter_fails_closed_without_event() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        events = _run_prompt(Path(tmp), lambda _k, _n, _t: Decision("prompt", "test prompt"), None)
        assert not (Path(tmp) / "ok.py").exists()  # no waiter → refuse, no interactive ask
    assert not any(e.type == "approval" for e in events)


def test_permission_denial_is_written_to_security_log(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("ZOC_STUDIO_HOME", str(tmp_path / "home"))
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    _run(
        workspace,
        lambda _kind, _name, _target: Decision("deny", "policy denied"),
        _RESPONSE,
    )

    records = [
        json.loads(line)
        for line in security_log_path().read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert any(
        record["kind"] == "permission_denied"
        and record.get("run_id") == "r"
        and record.get("tool") == "write_file"
        for record in records
    )
