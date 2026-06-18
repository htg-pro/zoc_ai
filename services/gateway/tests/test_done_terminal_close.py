"""Tests for DONE terminal completion + stream close (task 5.2, R3.4).

When the Agent-Mode FSM reaches the DONE stage, the gateway must emit the
terminal ``done`` completion event and then close the SSE stream for that run.
These tests pin the wiring between the FSM's stage emission, the run's emit
gate, and the run's close sentinel: driving a bound FSM to DONE puts the
``done`` event on the bus and then the close sentinel behind it, so
``GET /v1/agent/events`` terminates for the run.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from zocai_gateway.app import RunRegistry, _Run, create_app
from zocai_gateway.fsm import FSM
from zocai_gateway.mode_router import AgentRunRequest, ModeRouter
from zocai_gateway.stages import Stage


def _drive_to_done(fsm: FSM) -> None:
    """Advance ``fsm`` along the empty-plan happy path INTAKE → … → DONE."""
    fsm.advance()  # INTAKE -> ANALYZE
    fsm.advance()  # ANALYZE -> MAP_FILES
    fsm.advance()  # MAP_FILES -> READ_FILES
    fsm.advance()  # READ_FILES -> PLAN_EDITS
    fsm.plan_complete(has_changes=False)  # PLAN_EDITS -> RUN_CHECKS (R3.8)
    fsm.run_checks_result(0)  # RUN_CHECKS -> SUMMARY (R5.8)
    fsm.advance()  # SUMMARY -> DONE


def _make_agent_run() -> tuple[RunRegistry, _Run]:
    registry = RunRegistry()
    run = registry.create(ModeRouter().route(AgentRunRequest(prompt="go", mode="agent")))
    return registry, run


def test_reaching_done_emits_done_event_then_close_sentinel() -> None:
    _registry, run = _make_agent_run()
    fsm = run.bind_fsm(FSM(initial=Stage.INTAKE, run_id=run.run_id))

    _drive_to_done(fsm)

    drained: list[dict[str, object] | None] = []
    while not run.queue.empty():
        drained.append(run.queue.get_nowait())

    # The terminal done completion event reached the bus...
    assert drained[-2] is not None
    assert drained[-2]["type"] == "done"
    assert drained[-2]["ok"] is True
    # ...immediately followed by the close sentinel that ends the stream (R3.4).
    assert drained[-1] is None


def test_done_is_the_last_event_and_stream_closes_once() -> None:
    _registry, run = _make_agent_run()
    fsm = run.bind_fsm(FSM(initial=Stage.INTAKE, run_id=run.run_id))

    _drive_to_done(fsm)

    items: list[dict[str, object] | None] = []
    while not run.queue.empty():
        items.append(run.queue.get_nowait())

    # Exactly one close sentinel, and it is last; no events follow the done event.
    assert items.count(None) == 1
    non_sentinel = [i for i in items if i is not None]
    assert non_sentinel[-1]["type"] == "done"


def test_events_endpoint_terminates_for_run_at_done() -> None:
    app = create_app()
    client = TestClient(app)

    run = app.state.run_registry.create(
        ModeRouter().route(AgentRunRequest(prompt="go", mode="agent"))
    )
    fsm = run.bind_fsm(FSM(initial=Stage.INTAKE, run_id=run.run_id))
    _drive_to_done(fsm)

    # The SSE generator drains the queued events and terminates at the close
    # sentinel rather than hanging open (R3.4).
    with client.stream("GET", "/v1/agent/events", params={"runId": run.run_id}) as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        body = "".join(resp.iter_text())

    assert "event: done" in body


def test_non_terminal_stage_events_do_not_close_the_stream() -> None:
    _registry, run = _make_agent_run()
    fsm = run.bind_fsm(FSM(initial=Stage.INTAKE, run_id=run.run_id))

    fsm.advance()  # INTAKE -> ANALYZE: a stage event, but not terminal.

    items: list[dict[str, object] | None] = []
    while not run.queue.empty():
        items.append(run.queue.get_nowait())

    # A non-DONE stage event must not enqueue the close sentinel.
    assert None not in items
