"""Production-path gap tests (zoc-ai-agent-chat-overhaul).

* Task 3 — mode capability enforcement driven by the *actual* approval state
  (no hardcoded ``approved=True``); the ReAct executor refuses a WRITE tool the
  mode does not permit.
* Task 4 — the terminal ``done`` event carries the real distinct-files-changed
  count and a human reason when a run changes nothing.
* Task 5 — edit-file events carry a pre-write SHA-256 base hash.
* Task 6 — a cloud 401/403 is recognized as a typed ``provider_auth_invalid``
  without leaking the API key or the response body.

**Validates: Requirements 5.2, 6, 7.6, 7.7, 8.7, 8.8, 12.7, 16.2-16.4**
"""

from __future__ import annotations

import contextlib
from pathlib import Path
from types import SimpleNamespace

import pytest
from zocai_gateway.atomic_fs import sha256_text
from zocai_gateway.context.steering_compiler import SteeringPayload
from zocai_gateway.context.token_gate import TokenGateResult
from zocai_gateway.edits import EditCoordinator, EditPlan, PlannedChange
from zocai_gateway.emit_gate import EmitGate
from zocai_gateway.errors import ErrorCode
from zocai_gateway.fsm import FSM
from zocai_gateway.mode_router import AgentRunRequest, Capability, Decision, Mode, check_capability
from zocai_gateway.model_allocator import Allocation
from zocai_gateway.model_interface import ModelTier
from zocai_gateway.model_runtime import (
    ModelContextWindowError,
    ModelToolResponse,
    ProviderAuthError,
    ToolCall,
    _post_json,
)
from zocai_gateway.orchestrator import Orchestrator
from zocai_gateway.plan import AgentPlan, EditStep
from zocai_gateway.react import ReActExecutor
from zocai_gateway.run_pipeline import (
    ApplyStrategy,
    DefaultAgentBrain,
    RunContext,
    RunPipeline,
)
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


class _StructuredBrain(DefaultAgentBrain):
    """A brain that applies a fixed EditPlan and passes checks (single-pass)."""

    def __init__(self, changes: tuple[PlannedChange, ...]) -> None:
        self._changes = changes

    def edit_plan(self, request: AgentRunRequest, context: RunContext) -> EditPlan:
        return EditPlan(reasoning="apply", changes=self._changes)

    def structured_plan(self, request: AgentRunRequest, context: RunContext) -> AgentPlan:
        return AgentPlan(
            steps=[EditStep(file=c.path, action="create", rationale="c") for c in self._changes],
            confidence=1.0,
        )

    def run_checks(self, request: AgentRunRequest, plan: EditPlan) -> tuple[int, str, str]:
        return (0, "noop-check", "")


def _run(tmp_path: Path, brain: DefaultAgentBrain, *, run_id: str = "r") -> list[dict]:
    events: list[dict] = []
    RunPipeline(
        AgentRunRequest(prompt="do it", mode=Mode.AGENT),
        run_id,
        gate=EmitGate(sink=lambda event: events.append(dict(event))),
        text_sink=lambda _chunk: None,
        close=lambda: None,
        workspace_root=tmp_path,
        brain=brain,
    ).run()
    return events


# ── Task 4: DoneEvent files_changed + human reason ──────────────────────────


def test_done_event_reports_distinct_files_changed(tmp_path: Path) -> None:
    events = _run(
        tmp_path,
        _StructuredBrain(
            (
                PlannedChange(path="a.py", content="print(1)\n", diff="+a"),
                PlannedChange(path="b.py", content="print(2)\n", diff="+b"),
            )
        ),
    )
    done = next(e for e in events if e["type"] == "done")
    assert done["ok"] is True
    assert done["filesChanged"] == 2
    assert done.get("reason") is None  # a run that changed files names no reason


def test_done_event_reports_zero_and_a_reason_when_nothing_changes(tmp_path: Path) -> None:
    events = _run(tmp_path, _StructuredBrain(()))  # empty plan → no writes
    done = next(e for e in events if e["type"] == "done")
    assert done["filesChanged"] == 0
    # R8.8: a run that changed nothing carries a human reason.
    assert done["reason"]
    assert "no file changes" in done["reason"].lower()


def test_fsm_done_event_carries_recorded_outcome() -> None:
    """The FSM stamps the recorded files-changed/reason onto the terminal frame."""
    emitted: list = []
    fsm = FSM(initial=Stage.SUMMARY, run_id="r", emit=emitted.append)
    fsm.done_files_changed = 4
    fsm.done_reason = None
    fsm.advance()  # SUMMARY → DONE
    done = emitted[-1]
    assert done.type == "done"
    assert done.files_changed == 4
    assert done.reason is None


def _review_run(tmp_path: Path, brain: DefaultAgentBrain, decision: object) -> list[dict]:
    events: list[dict] = []
    RunPipeline(
        AgentRunRequest(prompt="do it", mode=Mode.AGENT, review_changes=True),
        "review-run",
        gate=EmitGate(sink=lambda event: events.append(dict(event))),
        text_sink=lambda _chunk: None,
        close=lambda: None,
        workspace_root=tmp_path,
        brain=brain,
        wait_for_review_decision=lambda _timeout: decision,
    ).run()
    return events


def test_review_accept_reports_files_changed_and_base_hash(tmp_path: Path) -> None:
    """A reviewed apply reports the accepted count and the real target's base hash."""
    (tmp_path / "a.py").write_text("old\n", encoding="utf-8")
    events = _review_run(
        tmp_path,
        _StructuredBrain((PlannedChange(path="a.py", content="new\n", diff="+new"),)),
        SimpleNamespace(decision="approve", accepted_paths=["a.py"]),
    )
    review = next(e for e in events if e["type"] == "review")
    reviewed = {f["path"]: f for f in review["files"]}
    # R12.7: the review file carries the SHA-256 of the *real* target at review
    # time (its pre-apply content), not the isolated copy.
    assert reviewed["a.py"]["baseHash"] == sha256_text("old\n")
    done = next(e for e in events if e["type"] == "done")
    assert done["filesChanged"] == 1
    assert done.get("reason") is None
    assert (tmp_path / "a.py").read_text(encoding="utf-8") == "new\n"  # applied


def test_review_discard_reports_zero_files_and_a_reason(tmp_path: Path) -> None:
    """A discarded review changes nothing and the done event names the reason."""
    (tmp_path / "a.py").write_text("old\n", encoding="utf-8")
    events = _review_run(
        tmp_path,
        _StructuredBrain((PlannedChange(path="a.py", content="new\n", diff="+new"),)),
        SimpleNamespace(decision="discard"),
    )
    done = next(e for e in events if e["type"] == "done")
    assert done["filesChanged"] == 0
    assert done["reason"] and "discard" in done["reason"].lower()
    assert (tmp_path / "a.py").read_text(encoding="utf-8") == "old\n"  # unchanged


# ── Task 5: pre-write base hash on edit-file events ─────────────────────────


def test_edit_file_events_carry_pre_write_base_hash(tmp_path: Path) -> None:
    # A pre-existing file whose prior bytes define the base hash, and a brand-new
    # file whose base hash is null (it did not exist at write time).
    (tmp_path / "a.py").write_text("old\n", encoding="utf-8")
    events = _run(
        tmp_path,
        _StructuredBrain(
            (
                PlannedChange(path="a.py", content="new\n", diff="+new"),
                PlannedChange(path="new.py", content="print(1)\n", diff="+new file"),
            )
        ),
    )
    edits = {e["path"]: e for e in events if e["type"] == "edit-file"}
    assert edits["a.py"]["baseHash"] == sha256_text("old\n")
    assert edits["new.py"]["baseHash"] is None


# ── Task 3: mode capability enforcement in tool authorization ───────────────


def _executor_with_gate(root: Path, gate: object, model: object) -> tuple[ReActExecutor, list]:
    events: list = []
    toolset = FullToolset(root)
    fsm = FSM(initial=Stage.APPLY_EDITS, run_id="r", emit=events.append)
    orchestrator = Orchestrator(
        fsm=fsm,
        edits=EditCoordinator(toolset=toolset, run_id="r", emit=events.append),
        run_id="r",
        emit=events.append,
    )
    executor = ReActExecutor(
        toolset=toolset,
        orchestrator=orchestrator,
        plan=AgentPlan(
            steps=[EditStep(file="a.py", action="create", rationale="c")], confidence=1.0
        ),
        request=AgentRunRequest(prompt="do it", mode=Mode.PLAN),
        context=_context(),
        emit=events.append,
        run_id="r",
        run_with_tools=model,  # type: ignore[arg-type]
        capability_gate=gate,  # type: ignore[arg-type]
    )
    return executor, events


def _one_write_then_stop(path: str):
    responses = iter(
        [
            ModelToolResponse(
                text="",
                tool_calls=(
                    ToolCall(id="w", name="write_file", arguments={"path": path, "content": "x\n"}),
                ),
                finish_reason="tool_calls",
            ),
            ModelToolResponse(text="done", tool_calls=(), finish_reason="stop"),
        ]
    )

    def model(request: AgentRunRequest, **_kwargs: object) -> ModelToolResponse:
        try:
            return next(responses)
        except StopIteration:
            return ModelToolResponse(text="done", tool_calls=(), finish_reason="stop")

    return model


def test_react_capability_gate_blocks_write_when_mode_disallows(tmp_path: Path) -> None:
    """Plan-before-approval: a WRITE tool is refused and nothing is written."""

    def gate(cap: Capability) -> Decision:
        return check_capability(Mode.PLAN, approved=False, capability=cap)

    executor, _events = _executor_with_gate(tmp_path, gate, _one_write_then_stop("a.py"))
    executor.run()
    assert not (tmp_path / "a.py").exists()  # the write never reached disk


def test_react_capability_gate_allows_write_after_approval(tmp_path: Path) -> None:
    """Plan-after-approval (and Agent): a WRITE tool is permitted and applied."""

    def gate(cap: Capability) -> Decision:
        return check_capability(Mode.PLAN, approved=True, capability=cap)

    executor, _events = _executor_with_gate(tmp_path, gate, _one_write_then_stop("a.py"))
    executor.run()
    assert (tmp_path / "a.py").read_text(encoding="utf-8") == "x\n"


def test_capability_gate_is_the_real_table_not_hardcoded() -> None:
    """The chokepoint decision comes from the table, not a constant approved=True."""
    assert check_capability(Mode.PLAN, approved=False, capability=Capability.WRITE).rejected
    assert check_capability(Mode.PLAN, approved=False, capability=Capability.EXECUTE).rejected
    assert not check_capability(Mode.PLAN, approved=True, capability=Capability.WRITE).rejected
    assert not check_capability(Mode.AGENT, approved=False, capability=Capability.WRITE).rejected


# ── Task 6: provider auth 401/403 recognized without leaking secrets ────────


_CONTEXT_OVERFLOW_BODY = (
    '{"error":{"type":"exceed_context_size_error",' '"n_prompt_tokens":9444,"n_ctx":8192}}'
)


def test_post_json_classifies_context_overflow_without_leaking_raw_json(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "zocai_gateway.model_runtime._import_httpx",
        lambda: _fake_httpx(400, _CONTEXT_OVERFLOW_BODY),
    )
    monkeypatch.setattr("zocai_gateway.model_runtime._inference_scope", contextlib.nullcontext)

    with pytest.raises(ModelContextWindowError) as excinfo:
        _post_json(
            "http://127.0.0.1:8080/v1/chat/completions",
            {},
            {"model": "local"},
            5.0,
            provider="llamacpp",
        )

    exc = excinfo.value
    assert exc.code == ErrorCode.CONTEXT_WINDOW_EXCEEDED
    assert exc.prompt_tokens == 9444
    assert exc.context_tokens == 8192
    assert "9,444" in str(exc)
    assert "8,192" in str(exc)
    assert "exceed_context_size_error" not in str(exc)
    assert "{" not in str(exc)


class _FakeResponse:
    def __init__(self, status_code: int, text: str) -> None:
        self.status_code = status_code
        self.text = text

    def read(self) -> bytes:
        return self.text.encode()

    def json(self) -> dict:
        return {}


class _FakeClient:
    def __init__(self, status_code: int, text: str) -> None:
        self._status_code = status_code
        self._text = text

    def __enter__(self) -> _FakeClient:
        return self

    def __exit__(self, *_a: object) -> bool:
        return False

    def post(self, *_a: object, **_k: object) -> _FakeResponse:
        return _FakeResponse(self._status_code, self._text)


def _fake_httpx(status_code: int, text: str) -> SimpleNamespace:
    class _HTTPError(Exception):
        pass

    return SimpleNamespace(
        Client=lambda *a, **k: _FakeClient(status_code, text),
        HTTPError=_HTTPError,
        Timeout=lambda *a, **k: None,
    )


_SECRET_BODY = '{"error":{"message":"invalid api key sk-LEAKED-SECRET-KEY"}}'


@pytest.mark.parametrize("status", [401, 403])
def test_post_json_raises_typed_provider_auth_error_without_leaking(
    monkeypatch: pytest.MonkeyPatch, status: int
) -> None:
    monkeypatch.setattr(
        "zocai_gateway.model_runtime._import_httpx",
        lambda: _fake_httpx(status, _SECRET_BODY),
    )
    monkeypatch.setattr("zocai_gateway.model_runtime._inference_scope", contextlib.nullcontext)

    with pytest.raises(ProviderAuthError) as excinfo:
        _post_json(
            "https://api.openai.test/v1/chat/completions",
            {"Authorization": "Bearer sk-LEAKED-SECRET-KEY"},
            {"model": "gpt-4o"},
            5.0,
            provider="openai",
        )

    exc = excinfo.value
    assert exc.status_code == status
    assert exc.provider == "openai"
    assert exc.code == ErrorCode.PROVIDER_AUTH_INVALID
    text = str(exc)
    assert "sk-LEAKED-SECRET-KEY" not in text
    assert "invalid api key" not in text.lower()


class _AuthFailBrain(DefaultAgentBrain):
    """A brain whose first model call rejects the credential (cloud 401)."""

    def think(self, request: AgentRunRequest, context: RunContext) -> str:
        raise ProviderAuthError("openai", 401)


def test_pipeline_threads_provider_auth_code_to_failure_sink(tmp_path: Path) -> None:
    """A provider 401 in the run sets the typed code on the failure sink, no leak."""
    recorded: list[tuple[str, str]] = []
    RunPipeline(
        AgentRunRequest(prompt="do it", mode=Mode.AGENT),
        "auth-run",
        gate=EmitGate(sink=lambda _e: None),
        text_sink=lambda _chunk: None,
        close=lambda: None,
        workspace_root=tmp_path,
        brain=_AuthFailBrain(),
        apply_strategy=ApplyStrategy.SINGLE_PASS,
        failure_sink=lambda reason, code: recorded.append((reason, code)),
    ).run()

    assert recorded, "the failure sink was never called"
    reason, code = recorded[0]
    assert code == ErrorCode.PROVIDER_AUTH_INVALID
    assert "sk-" not in reason


def test_run_session_error_frame_carries_provider_auth_code() -> None:
    """close() emits the typed provider_auth_invalid frame (not generic run_failed)."""
    from zocai_gateway.app import RunRegistry
    from zocai_gateway.mode_router import ModeRouter

    registry = RunRegistry()
    run = registry.create(ModeRouter().route(AgentRunRequest(prompt="go", mode=Mode.AGENT)))
    run.record_failure(
        "openai rejected the API key (HTTP 401).",
        code=ErrorCode.PROVIDER_AUTH_INVALID,
    )
    run.close()

    frames: list[dict] = []
    while not run.queue.empty():
        item = run.queue.get_nowait()
        if item is not None:
            frames.append(item)

    error = next(f for f in frames if f.get("type") == "error")
    assert error["code"] == ErrorCode.PROVIDER_AUTH_INVALID
    # Friendly, key-free message + details.
    assert "API key" in error["message"]
    assert "sk-" not in (error.get("details") or "")
