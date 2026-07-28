"""Run lifecycle, stop idempotency, and the terminal-frame guarantee.

These pin the behaviours whose absence produced the reported failures:

* ``Error: unknown run: <id>`` in the chat panel — a Stop that arrived after the
  run had been forgotten used to raise ``404``.
* A run stuck on "Running…" — a run that ended in ``ERROR_CLOSED`` (or timed
  out, or died) closed its SSE stream without emitting anything the renderer
  recognises as terminal.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from zocai_gateway.app import _Run, create_app
from zocai_gateway.errors import ErrorCode
from zocai_gateway.mode_router import AgentRunRequest, ModeRouter
from zocai_gateway.run_pipeline import DefaultAgentBrain
from zocai_gateway.run_state import (
    IllegalRunTransition,
    RunLifecycle,
    RunState,
)


def _run(mode: str = "agent", run_id: str = "r1") -> _Run:
    path = ModeRouter().route(AgentRunRequest(prompt="go", mode=mode))
    return _Run(run_id=run_id, path=path)


def _drain(run: _Run) -> list[dict[str, object] | None]:
    frames: list[dict[str, object] | None] = []
    while not run.queue.empty():
        frames.append(run.queue.get_nowait())
    return frames


def _terminal_frames(run: _Run) -> list[dict[str, object]]:
    """Frames the renderer treats as terminal: `done`, `error`, or `token.done`."""
    out: list[dict[str, object]] = []
    for frame in _drain(run):
        if frame is None:
            continue
        kind = frame.get("type")
        if kind in {"done", "error"} or (kind == "token" and frame.get("done") is True):
            out.append(frame)
    return out


# ── the state machine itself ────────────────────────────────────────────────


def test_lifecycle_starts_idle_and_reaches_running() -> None:
    lifecycle = RunLifecycle()
    assert lifecycle.state is RunState.IDLE
    lifecycle.to(RunState.INITIALIZING)
    lifecycle.to(RunState.RUNNING)
    assert lifecycle.state is RunState.RUNNING
    assert lifecycle.is_terminal is False


def test_lifecycle_rejects_an_illegal_transition() -> None:
    lifecycle = RunLifecycle(RunState.COMPLETED)
    with pytest.raises(IllegalRunTransition):
        lifecycle.to(RunState.RUNNING)


def test_request_stop_is_idempotent_and_reports_whether_it_acted() -> None:
    lifecycle = RunLifecycle(RunState.RUNNING)
    assert lifecycle.request_stop() is True
    assert lifecycle.state is RunState.STOPPING
    # A second Stop has nothing to do and must not raise.
    assert lifecycle.request_stop() is False


def test_request_stop_on_a_finished_run_is_a_no_op() -> None:
    lifecycle = RunLifecycle(RunState.RUNNING)
    lifecycle.finish(RunState.COMPLETED)
    assert lifecycle.request_stop() is False
    assert lifecycle.state is RunState.COMPLETED


def test_finish_keeps_the_first_terminal_outcome() -> None:
    lifecycle = RunLifecycle(RunState.RUNNING)
    lifecycle.finish(RunState.CANCELLED, reason="user")
    lifecycle.finish(RunState.FAILED, reason="late error")
    assert lifecycle.state is RunState.CANCELLED
    assert lifecycle.reason == "user"


# ── exactly one terminal frame per run ─────────────────────────────────────


def test_agent_run_emits_a_done_frame_on_close() -> None:
    """An Agent run that closes without an FSM `done` still terminates the feed.

    This is the guarantee the frontend's terminal-event watcher depends on;
    without it the run stayed "Running…" forever.
    """
    run = _run(mode="agent")
    run.close()
    terminals = _terminal_frames(run)
    assert len(terminals) == 1
    assert terminals[0]["type"] == "done"
    assert run.state is RunState.COMPLETED


def test_error_closed_stage_marker_produces_a_terminal_error_frame() -> None:
    """The R3.10 `<stage:error_closed>` marker now settles the run as failed.

    The marker stays on the bus (the Session_Diary parses it back into a stage),
    but a terminal `error` frame is emitted behind it so the renderer knows the
    run ended.
    """
    run = _run(mode="agent")
    run.emit_gate.emit(
        {
            "type": "command",
            "seq": 0,
            "runId": run.run_id,
            "ts": "t",
            "command": "<stage:error_closed>",
            "errorTag": "edit_plan failed",
        }
    )
    run.close()

    frames = [f for f in _drain(run) if f is not None]
    # The synthetic marker is still delivered...
    assert any(f.get("command") == "<stage:error_closed>" for f in frames)
    # ...and is followed by exactly one terminal error frame.
    terminals = [f for f in frames if f.get("type") == "error"]
    assert len(terminals) == 1
    marker = next(f for f in frames if f.get("command") == "<stage:error_closed>")
    assert terminals[0]["seq"] > marker["seq"]
    assert len({f["seq"] for f in frames}) == len(frames)
    assert terminals[0]["code"] == ErrorCode.RUN_FAILED
    # The user-facing message never contains the raw stage marker.
    assert "<stage:" not in str(terminals[0]["message"])
    assert run.state is RunState.FAILED


def test_close_does_not_emit_a_second_done_when_the_fsm_already_did() -> None:
    run = _run(mode="agent")
    run.emit_gate.emit({"type": "done", "seq": 0, "runId": run.run_id, "ts": "t", "ok": True})
    run.close()
    assert len(_terminal_frames(run)) == 1


def test_ask_run_still_ends_with_a_done_token() -> None:
    run = _run(mode="ask")
    run.close()
    terminals = _terminal_frames(run)
    assert len(terminals) == 1
    assert terminals[0]["type"] == "token"
    assert terminals[0]["done"] is True


def test_cancel_emits_one_cancellation_frame_and_is_idempotent() -> None:
    run = _run(mode="agent")
    assert run.cancel() is True
    # Stop pressed twice: no second frame, no exception.
    assert run.cancel() is False

    terminals = _terminal_frames(run)
    assert len(terminals) == 1
    assert terminals[0]["code"] == ErrorCode.RUN_CANCELLED
    assert run.state is RunState.CANCELLED
    assert run.is_cancelled is True


def test_cancel_after_completion_does_not_emit_another_frame() -> None:
    run = _run(mode="agent")
    run.close()
    _drain(run)
    assert run.cancel() is False
    assert _terminal_frames(run) == []
    assert run.state is RunState.COMPLETED


def test_later_typed_failure_upgrades_generic_terminal_classification() -> None:
    run = _run(mode="agent")
    run.record_failure("planner failed")
    run.record_failure(
        "The request is too large for this model's context window.",
        code=ErrorCode.CONTEXT_WINDOW_EXCEEDED,
    )
    run.close()

    terminal = _terminal_frames(run)[0]
    assert terminal["type"] == "error"
    assert terminal["code"] == ErrorCode.CONTEXT_WINDOW_EXCEEDED
    assert "context window" in str(terminal["message"]).lower()
    assert run.state is RunState.FAILED


def test_recorded_failure_survives_into_the_terminal_frame() -> None:
    """An unexpected process exit becomes a failed run, not a stuck one."""
    run = _run(mode="agent")
    run.record_failure("model process exited with code 1")
    run.close()
    terminals = _terminal_frames(run)
    assert len(terminals) == 1
    assert terminals[0]["type"] == "error"
    assert run.state is RunState.FAILED


# ── the cancel endpoint never answers "unknown run" ─────────────────────────


def test_cancel_endpoint_reports_unknown_run_without_failing() -> None:
    """A Stop for a forgotten run resolves; it does not 404.

    A closed run whose SSE stream drained is removed from the registry, so a
    Stop that races completion legitimately names a run the gateway no longer
    tracks. That must not surface as an error the user reads.
    """
    client = TestClient(create_app(drive=False))
    response = client.post("/v1/agent/runs/does-not-exist/cancel")

    assert response.status_code == 200
    body = response.json()
    assert body["state"] == "unknown"
    assert body["alreadyFinished"] is True
    assert "unknown run" not in response.text


def test_cancel_endpoint_is_idempotent_over_http() -> None:
    client = TestClient(create_app(drive=False, brain=DefaultAgentBrain()))
    run_id = client.post("/v1/agent/run", json={"prompt": "hi", "mode": "ask"}).json()["runId"]

    first = client.post(f"/v1/agent/runs/{run_id}/cancel").json()
    second = client.post(f"/v1/agent/runs/{run_id}/cancel").json()

    assert first["cancelled"] is True
    assert first["state"] == "cancelled"
    # The second Stop is a successful no-op.
    assert second["cancelled"] is False
    assert second["alreadyFinished"] is True
    assert second["state"] == "cancelled"


def test_decision_for_unknown_run_returns_a_structured_error() -> None:
    client = TestClient(create_app(drive=False))
    response = client.post(
        "/v1/agent/decision",
        json={"runId": "nope", "kind": "approval", "decision": "reject"},
    )
    assert response.status_code == 404
    detail = response.json()["detail"]
    assert detail["code"] == ErrorCode.RUN_NOT_FOUND
    # The user-facing message explains the situation instead of naming an id.
    assert "nope" not in detail["message"]
    assert detail["message"].strip()


def test_runtime_endpoint_publishes_run_states() -> None:
    client = TestClient(create_app(drive=False, brain=DefaultAgentBrain()))
    run_id = client.post("/v1/agent/run", json={"prompt": "hi", "mode": "ask"}).json()["runId"]
    body = client.get("/v1/agent/runtime").json()
    assert body["run_states"][run_id] in {state.value for state in RunState}
