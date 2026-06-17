"""Recovery of suspended approvals across an agent restart.

When the sidecar restarts while a tool call is waiting for the user's
approval decision, the in-memory gate and the in-flight run are gone, but
the call is still persisted as `needs_approval`. Startup reconciliation must
mark these orphaned calls cleanly so the UI isn't stuck forever.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from llama_studio_agent.reconcile import (
    ORPHANED_APPROVAL_MESSAGE,
    reconcile_orphaned_approvals,
)
from shared_schema.models import (
    DoneEvent,
    Message,
    MessageRole,
    PermissionScope,
    Session,
    ToolCall,
    ToolCallEvent,
    ToolCallStatus,
)


def _make_state(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("LLAMA_STUDIO_DATA_DIR", str(tmp_path / "data"))
    from llama_studio_agent.config import get_settings, reset_settings_cache
    from llama_studio_agent.state import build_app_state

    reset_settings_cache()
    return build_app_state(get_settings())


def _suspended_call(state, session_id) -> ToolCall:
    call = ToolCall(
        name="write_file",
        arguments={"path": "out.txt", "content": "hi"},
        status=ToolCallStatus.needs_approval,
        error="needs write_fs",
        started_at=datetime.now(UTC),
    )
    state.repo.upsert_tool_call(session_id, call)
    return call


@pytest.mark.asyncio
async def test_reconcile_cancels_orphaned_approval(tmp_path, monkeypatch):
    state = _make_state(tmp_path, monkeypatch)
    sess = Session(title="t", workspace_root=str(tmp_path), provider="mock", model="mock-1")
    state.repo.create_session(sess)
    call = _suspended_call(state, sess.id)

    n = await reconcile_orphaned_approvals(state)
    assert n == 1

    reloaded = state.repo.get_tool_call(sess.id, call.id)
    assert reloaded is not None
    assert reloaded.status == ToolCallStatus.cancelled
    assert reloaded.error == ORPHANED_APPROVAL_MESSAGE
    assert reloaded.finished_at is not None

    # A cancellation event was persisted so a (re)connecting client replays it.
    events = state.repo.list_events(sess.id)
    tool_events = [e for e in events if e["type"] == "tool_call"]
    assert tool_events
    assert tool_events[-1]["payload"]["tool_call"]["status"] == "cancelled"


@pytest.mark.asyncio
async def test_reconcile_leaves_other_statuses_untouched(tmp_path, monkeypatch):
    state = _make_state(tmp_path, monkeypatch)
    sess = Session(title="t", workspace_root=str(tmp_path), provider="mock", model="mock-1")
    state.repo.create_session(sess)
    ok = ToolCall(
        name="read_file",
        arguments={"path": "x"},
        status=ToolCallStatus.succeeded,
        started_at=datetime.now(UTC),
        finished_at=datetime.now(UTC),
    )
    state.repo.upsert_tool_call(sess.id, ok)

    n = await reconcile_orphaned_approvals(state)
    assert n == 0
    reloaded = state.repo.get_tool_call(sess.id, ok.id)
    assert reloaded.status == ToolCallStatus.succeeded


@pytest.mark.asyncio
async def test_reconcile_skips_calls_with_live_waiter(tmp_path, monkeypatch):
    state = _make_state(tmp_path, monkeypatch)
    sess = Session(title="t", workspace_root=str(tmp_path), provider="mock", model="mock-1")
    state.repo.create_session(sess)
    call = _suspended_call(state, sess.id)

    # Simulate an active waiter registered in the gate.
    import asyncio

    loop = asyncio.get_running_loop()
    state.approvals._futures[(sess.id, call.id)] = loop.create_future()

    n = await reconcile_orphaned_approvals(state)
    assert n == 0
    reloaded = state.repo.get_tool_call(sess.id, call.id)
    assert reloaded.status == ToolCallStatus.needs_approval


def test_startup_reconciles_persisted_approvals(tmp_path, monkeypatch):
    # First process: leave a suspended approval behind.
    s1 = _make_state(tmp_path, monkeypatch)
    sess = Session(title="t", workspace_root=str(tmp_path), provider="mock", model="mock-1")
    s1.repo.create_session(sess)
    call = _suspended_call(s1, sess.id)
    del s1

    # Second process boots against the same data dir; lifespan reconciles.
    s2 = _make_state(tmp_path, monkeypatch)
    from llama_studio_agent.app import create_app

    app = create_app(s2.settings, state=s2)
    with TestClient(app):
        pass

    reloaded = s2.repo.get_tool_call(sess.id, call.id)
    assert reloaded.status == ToolCallStatus.cancelled
    assert reloaded.error == ORPHANED_APPROVAL_MESSAGE


def test_reconciliation_event_replays_after_reconnect(tmp_path, monkeypatch):
    # First process: emit some events (advancing seq) and leave a suspended
    # approval behind. The frontend has seen up through the latest seq.
    s1 = _make_state(tmp_path, monkeypatch)
    sess = Session(title="t", workspace_root=str(tmp_path), provider="mock", model="mock-1")
    s1.repo.create_session(sess)
    for _ in range(5):
        s1.repo.append_event(sess.id, s1.bus.next_seq(sess.id), "log", {"x": 1})
    last_seen = s1.repo.max_event_seq(sess.id)
    assert last_seen == 5
    _suspended_call(s1, sess.id)
    del s1

    # Second process boots against the same data dir; lifespan reconciles.
    s2 = _make_state(tmp_path, monkeypatch)
    from llama_studio_agent.app import create_app

    app = create_app(s2.settings, state=s2)
    with TestClient(app):
        pass

    # The cancellation event must be replayable for a client reconnecting
    # with since_seq=last_seen — i.e. it must have a seq strictly above it.
    replay = s2.repo.list_events(sess.id, since_seq=last_seen)
    tool_events = [e for e in replay if e["type"] == "tool_call"]
    assert tool_events, "reconciliation event missing from since_seq replay"
    assert tool_events[-1]["payload"]["tool_call"]["status"] == "cancelled"
    assert all(e["seq"] > last_seen for e in replay)


def test_resolve_endpoint_reports_run_lost(tmp_path, monkeypatch):
    state = _make_state(tmp_path, monkeypatch)
    sess = Session(title="t", workspace_root=str(tmp_path), provider="mock", model="mock-1")
    state.repo.create_session(sess)
    # A call that was already reconciled to a terminal status after restart.
    call = ToolCall(
        name="write_file",
        arguments={"path": "out.txt", "content": "hi"},
        status=ToolCallStatus.cancelled,
        error=ORPHANED_APPROVAL_MESSAGE,
        started_at=datetime.now(UTC),
        finished_at=datetime.now(UTC),
    )
    state.repo.upsert_tool_call(sess.id, call)

    from llama_studio_agent.app import create_app

    app = create_app(state.settings, state=state)
    with TestClient(app) as client:
        resp = client.post(
            f"/v1/sessions/{sess.id}/agent/approvals/{call.id}",
            json={"allowed": True},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["resolved"] is False
    assert body["recovered"] is False
    assert body["reason"] == "run_lost"


def test_resolve_endpoint_reconciles_orphan_without_restart(tmp_path, monkeypatch):
    # A call left suspended because its run was cancelled mid-flight (the
    # client disconnected) — no restart, so the process is still up with no
    # live waiter and no active run. The resolve path must detect this and
    # reconcile the call cleanly instead of buffering a doomed decision.
    state = _make_state(tmp_path, monkeypatch)
    sess = Session(title="t", workspace_root=str(tmp_path), provider="mock", model="mock-1")
    state.repo.create_session(sess)
    call = _suspended_call(state, sess.id)

    from llama_studio_agent.app import create_app

    app = create_app(state.settings, state=state)
    with TestClient(app) as client:
        resp = client.post(
            f"/v1/sessions/{sess.id}/agent/approvals/{call.id}",
            json={"allowed": True},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["resolved"] is False
    assert body["recovered"] is False
    assert body["reason"] == "run_lost"

    # The call was marked cancelled (not left dangling, not buffered).
    reloaded = state.repo.get_tool_call(sess.id, call.id)
    assert reloaded.status == ToolCallStatus.cancelled
    assert reloaded.error == ORPHANED_APPROVAL_MESSAGE
    assert reloaded.finished_at is not None
    # No stale decision was buffered for a run that will never resume.
    assert (sess.id, call.id) not in state.approvals._buffered
    # A cancellation event was emitted so a connected client replays it.
    tool_events = [e for e in state.repo.list_events(sess.id) if e["type"] == "tool_call"]
    assert tool_events
    assert tool_events[-1]["payload"]["tool_call"]["status"] == "cancelled"


def test_resolve_endpoint_buffers_when_run_active(tmp_path, monkeypatch):
    # The fast-frontend race: a decision arrives while the run is still live
    # but before the orchestrator registered its waiter. With an active run
    # recorded, the decision must be buffered (not reconciled away).
    state = _make_state(tmp_path, monkeypatch)
    sess = Session(title="t", workspace_root=str(tmp_path), provider="mock", model="mock-1")
    state.repo.create_session(sess)

    from llama_studio_agent.app import create_app

    app = create_app(state.settings, state=state)
    with TestClient(app) as client:
        # Create the suspension *after* startup reconciliation, mirroring a
        # real run that suspends a call and registers itself live, then has
        # the frontend resolve before the orchestrator reaches the gate.
        call = _suspended_call(state, sess.id)
        state.runs.register(sess.id)
        resp = client.post(
            f"/v1/sessions/{sess.id}/agent/approvals/{call.id}",
            json={"allowed": True},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["resolved"] is False
    assert body["recovered"] is True
    assert body["reason"] == "buffered"

    # The decision is held for the waiter to pick up; the call is untouched.
    assert state.approvals._buffered[(sess.id, call.id)] is True
    reloaded = state.repo.get_tool_call(sess.id, call.id)
    assert reloaded.status == ToolCallStatus.needs_approval


def test_resolve_endpoint_reports_unknown_call(tmp_path, monkeypatch):
    state = _make_state(tmp_path, monkeypatch)
    sess = Session(title="t", workspace_root=str(tmp_path), provider="mock", model="mock-1")
    state.repo.create_session(sess)

    from llama_studio_agent.app import create_app

    app = create_app(state.settings, state=state)
    with TestClient(app) as client:
        resp = client.post(
            f"/v1/sessions/{sess.id}/agent/approvals/{uuid4()}",
            json={"allowed": True},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["resolved"] is False
    assert body["reason"] == "unknown_call"


def _cancelled_orphan(state, session_id) -> ToolCall:
    """A tool call left cancelled by restart reconciliation."""

    call = ToolCall(
        name="write_file",
        arguments={"path": "out.txt", "content": "hi"},
        status=ToolCallStatus.cancelled,
        error=ORPHANED_APPROVAL_MESSAGE,
        started_at=datetime.now(UTC),
        finished_at=datetime.now(UTC),
    )
    state.repo.upsert_tool_call(session_id, call)
    return call


def test_retry_endpoint_unknown_call(tmp_path, monkeypatch):
    state = _make_state(tmp_path, monkeypatch)
    sess = Session(title="t", workspace_root=str(tmp_path), provider="mock", model="mock-1")
    state.repo.create_session(sess)

    from llama_studio_agent.app import create_app

    app = create_app(state.settings, state=state)
    with TestClient(app) as client:
        resp = client.post(
            f"/v1/sessions/{sess.id}/agent/approvals/{uuid4()}/retry"
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["retried"] is False
    assert body["reason"] == "unknown_call"


def test_retry_endpoint_rejects_non_orphan(tmp_path, monkeypatch):
    state = _make_state(tmp_path, monkeypatch)
    sess = Session(title="t", workspace_root=str(tmp_path), provider="mock", model="mock-1")
    state.repo.create_session(sess)
    # A genuinely failed call (not a restart cancellation) is not retryable.
    call = ToolCall(
        name="write_file",
        arguments={"path": "out.txt", "content": "hi"},
        status=ToolCallStatus.failed,
        error="boom",
        started_at=datetime.now(UTC),
        finished_at=datetime.now(UTC),
    )
    state.repo.upsert_tool_call(sess.id, call)

    from llama_studio_agent.app import create_app

    app = create_app(state.settings, state=state)
    with TestClient(app) as client:
        resp = client.post(
            f"/v1/sessions/{sess.id}/agent/approvals/{call.id}/retry"
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["retried"] is False
    assert body["reason"] == "not_retryable"


def test_retry_endpoint_no_prompt(tmp_path, monkeypatch):
    state = _make_state(tmp_path, monkeypatch)
    sess = Session(title="t", workspace_root=str(tmp_path), provider="mock", model="mock-1")
    state.repo.create_session(sess)
    _cancelled_orphan(state, sess.id)  # but no user message recorded

    from llama_studio_agent.app import create_app

    app = create_app(state.settings, state=state)
    with TestClient(app) as client:
        resp = client.post(
            f"/v1/sessions/{sess.id}/agent/approvals/"
            f"{state.repo.list_tool_calls_by_status(ToolCallStatus.cancelled)[0][1].id}/retry"
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["retried"] is False
    assert body["reason"] == "no_prompt"


def test_retry_endpoint_reruns_with_original_prompt(tmp_path, monkeypatch):
    state = _make_state(tmp_path, monkeypatch)
    sess = Session(title="t", workspace_root=str(tmp_path), provider="mock", model="mock-1")
    state.repo.create_session(sess)
    # Grant write_fs so the re-run can proceed without a fresh approval.
    state.permissions.grant(sess.id, PermissionScope.write_fs)
    # The original prompt that the cancelled tool call belonged to.
    state.repo.add_message(
        sess.id, Message(role=MessageRole.user, content="write a file")
    )
    call = _cancelled_orphan(state, sess.id)

    # Script the mock provider: plan, then finish with no tool calls so the
    # run completes promptly (we only assert it re-issued without retyping).
    from llama_studio_agent.providers.mock import MockResponse

    provider = state.providers.get("mock")
    provider.reset()
    provider.queue(
        MockResponse(text='{"goal":"g","steps":[{"title":"write"}]}'),
        MockResponse(text="done"),
    )

    msgs_before = len(state.repo.list_messages(sess.id))

    from llama_studio_agent.app import create_app

    app = create_app(state.settings, state=state)
    with TestClient(app) as client:
        resp = client.post(
            f"/v1/sessions/{sess.id}/agent/approvals/{call.id}/retry"
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["retried"] is True
    assert body["reason"] == "rerun"

    # The prompt was re-issued WITHOUT being re-recorded in the transcript.
    user_msgs = [
        m for m in state.repo.list_messages(sess.id) if m.role == MessageRole.user
    ]
    assert len(user_msgs) == 1
    assert user_msgs[0].content == "write a file"
    # No duplicate user message was appended by the retry.
    assert len(state.repo.list_messages(sess.id)) >= msgs_before


@pytest.mark.asyncio
async def test_retry_after_restart_reruns_blocked_tool_to_success(
    tmp_path, monkeypatch
):
    """End-to-end recovery of a restart-cancelled approval.

    Drives the full lifecycle a unit test can't: a real run genuinely
    suspends a ``write_file`` call as ``needs_approval`` (no ``write_fs``
    grant), the sidecar "restarts" (the in-flight run is cancelled and the
    waiter dies) and reconciliation cancels the orphan, the user *then*
    grants the missing permission, and finally the retry endpoint re-issues
    the original prompt so the previously-blocked tool actually executes to
    success — reusing the grant made *after* the cancellation.
    """

    from llama_studio_agent.deps import make_orchestrator
    from llama_studio_agent.providers.base import ProviderToolCall
    from llama_studio_agent.providers.mock import MockResponse

    state = _make_state(tmp_path, monkeypatch)
    workspace = tmp_path / "ws"
    workspace.mkdir()
    sess = Session(
        title="t", workspace_root=str(workspace), provider="mock", model="mock-1"
    )
    state.repo.create_session(sess)
    # The originating user prompt this tool call belonged to.
    state.repo.add_message(
        sess.id, Message(role=MessageRole.user, content="write a file")
    )

    write_call = ProviderToolCall(
        id="c1",
        name="write_file",
        arguments={"path": "out.txt", "content": "hi"},
    )

    provider = state.providers.get("mock")
    provider.reset()
    # Phase 1 script: plan, then ask to write a file (which has no grant yet
    # and so suspends for approval).
    provider.queue(
        MockResponse(text='{"goal":"g","steps":[{"title":"write"}]}'),
        MockResponse(tool_calls=[write_call]),
    )

    # Phase 1: a real run that genuinely blocks on the approval gate.
    orch = make_orchestrator(state, sess)
    run_task = asyncio.create_task(
        orch.run(
            session_id=sess.id,
            workspace_root=str(workspace),
            prompt="write a file",
            record_prompt=False,
        )
    )
    # Wait until the orchestrator has actually suspended the call and a live
    # waiter is registered in the gate.
    for _ in range(500):
        await asyncio.sleep(0.01)
        if state.approvals.pending(sess.id):
            break
    assert state.approvals.pending(sess.id), "run never suspended for approval"
    suspended = state.repo.list_tool_calls_by_status(ToolCallStatus.needs_approval)
    assert len(suspended) == 1
    # The file does not exist yet — the write was blocked, not executed.
    assert not (workspace / "out.txt").exists()

    # Phase 2: simulate the sidecar restart. The in-flight run coroutine is
    # cancelled (its waiter dies with it), then startup reconciliation marks
    # the orphaned approval cancelled.
    run_task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await run_task
    assert not state.approvals.pending(sess.id)

    n = await reconcile_orphaned_approvals(state)
    assert n == 1
    cancelled = state.repo.list_tool_calls_by_status(ToolCallStatus.cancelled)
    assert len(cancelled) == 1
    cancelled_id = cancelled[0][1].id
    assert cancelled[0][1].error == ORPHANED_APPROVAL_MESSAGE

    # Phase 3: the user grants the permission that was missing — *after* the
    # cancellation. The retry must pick this grant up on the fresh run.
    assert not state.permissions.has(sess.id, PermissionScope.write_fs)
    state.permissions.grant(sess.id, PermissionScope.write_fs)

    # Re-script for the rerun: plan, write (now authorised), then finish.
    provider.reset()
    provider.queue(
        MockResponse(text='{"goal":"g","steps":[{"title":"write"}]}'),
        MockResponse(
            tool_calls=[
                ProviderToolCall(
                    id="c2",
                    name="write_file",
                    arguments={"path": "out.txt", "content": "hi"},
                )
            ]
        ),
        MockResponse(text="done"),
    )

    msgs_before = len(state.repo.list_messages(sess.id))

    from llama_studio_agent.app import create_app

    app = create_app(state.settings, state=state)
    with TestClient(app) as client:
        resp = client.post(
            f"/v1/sessions/{sess.id}/agent/approvals/{cancelled_id}/retry"
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["retried"] is True
    assert body["reason"] == "rerun"

    # The previously-blocked tool actually executed to success this time.
    write_results = [tc for tc in body["tool_calls"] if tc["name"] == "write_file"]
    assert write_results, "retry did not re-attempt write_file"
    assert write_results[-1]["status"] == "succeeded"
    # And the side effect really happened on disk.
    assert (workspace / "out.txt").read_text() == "hi"

    # The grant made after cancellation was reused (still present, no fresh
    # approval was needed — nothing is left suspended).
    assert state.permissions.has(sess.id, PermissionScope.write_fs)
    assert not state.repo.list_tool_calls_by_status(ToolCallStatus.needs_approval)
    assert not state.approvals.pending(sess.id)

    # The original prompt was re-issued without duplicating the transcript.
    user_msgs = [
        m for m in state.repo.list_messages(sess.id) if m.role == MessageRole.user
    ]
    assert len(user_msgs) == 1
    assert user_msgs[0].content == "write a file"
    assert len(state.repo.list_messages(sess.id)) >= msgs_before


@pytest.mark.asyncio
async def test_retry_streams_rerun_events_to_connected_client(
    tmp_path, monkeypatch
):
    """A client already subscribed to the bus sees the retried run live.

    Task #49 proved the retry endpoint re-runs and succeeds, but only against
    the endpoint's HTTP response. Here we additionally prove the claim in the
    retry endpoint's docstring — "a subscribed client sees the new run live":
    a subscriber attached *before* the retry receives the rerun's events
    (the ``write_file`` tool call succeeding and the terminal ``done``), and
    every delivered event carries a seq strictly above the seq the client had
    already seen, so a reconnecting client replaying from ``since_seq`` would
    pick them up too.
    """

    from llama_studio_agent.providers.base import ProviderToolCall
    from llama_studio_agent.providers.mock import MockResponse
    from llama_studio_agent.v1.agent_run import retry_approval

    state = _make_state(tmp_path, monkeypatch)
    workspace = tmp_path / "ws"
    workspace.mkdir()
    sess = Session(
        title="t", workspace_root=str(workspace), provider="mock", model="mock-1"
    )
    state.repo.create_session(sess)
    state.repo.add_message(
        sess.id, Message(role=MessageRole.user, content="write a file")
    )
    # The user has granted the missing permission, so the rerun proceeds to
    # success without suspending again.
    state.permissions.grant(sess.id, PermissionScope.write_fs)

    # A call left cancelled by restart reconciliation — the retry's input.
    call = _cancelled_orphan(state, sess.id)

    # Emit some unrelated events first so the bus seq is well past zero and the
    # connected client has a non-trivial last-seen high-water mark.
    for _ in range(5):
        state.repo.append_event(sess.id, state.bus.next_seq(sess.id), "log", {"x": 1})
    last_seen = state.repo.max_event_seq(sess.id)
    assert last_seen == 5

    provider = state.providers.get("mock")
    provider.reset()
    provider.queue(
        MockResponse(text='{"goal":"g","steps":[{"title":"write"}]}'),
        MockResponse(
            tool_calls=[
                ProviderToolCall(
                    id="c2",
                    name="write_file",
                    arguments={"path": "out.txt", "content": "hi"},
                )
            ]
        ),
        MockResponse(text="done"),
    )

    # Subscribe to the live bus *before* triggering the retry, mirroring a
    # client already connected to GET /events when the rerun starts.
    received: list = []
    async with state.bus.subscribe(sess.id) as sub:
        retry_task = asyncio.create_task(
            retry_approval(call_id=call.id, session=sess, state=state)
        )
        # Drain live events until the run's terminal `done` arrives.
        while True:
            event = await asyncio.wait_for(sub.queue.get(), timeout=10.0)
            if event is None:
                break
            received.append(event)
            if isinstance(event, DoneEvent):
                break
        body = await retry_task

    assert body["retried"] is True
    assert body["reason"] == "rerun"
    # The side effect really happened, so the rerun genuinely executed.
    assert (workspace / "out.txt").read_text() == "hi"

    # The connected client received the rerun's tool-call success live.
    tool_events = [e for e in received if isinstance(e, ToolCallEvent)]
    succeeded = [
        e
        for e in tool_events
        if e.tool_call.name == "write_file"
        and e.tool_call.status == ToolCallStatus.succeeded
    ]
    assert succeeded, "subscriber never saw write_file succeed on the rerun"

    # And the terminal done event was delivered live too.
    done_events = [e for e in received if isinstance(e, DoneEvent)]
    assert done_events, "subscriber never saw the rerun's done event"

    # Every delivered event has a seq strictly above what the client had
    # already seen, so a reconnecting client replaying from since_seq=last_seen
    # would receive exactly these — no gaps, no re-delivery of stale events.
    assert all(e.seq > last_seen for e in received)
    # Sanity: seqs are monotonically increasing as delivered.
    seqs = [e.seq for e in received]
    assert seqs == sorted(seqs)

    # The same events are persisted and replayable for a late/reconnecting
    # subscriber requesting since_seq=last_seen.
    replay = state.repo.list_events(sess.id, since_seq=last_seen)
    assert all(e["seq"] > last_seen for e in replay)
    replay_types = {e["type"] for e in replay}
    assert "tool_call" in replay_types
    assert "done" in replay_types


def _parse_sse(raw: str) -> list[tuple[str, dict]]:
    """Parse a raw SSE byte/text stream into (event_type, payload) records.

    Validates the wire framing: each record may have an optional ``id:`` line
    (from Phase D Last-Event-ID feature), followed by an ``event:`` line and
    a ``data:`` line, separated by a blank line.
    """

    records: list[tuple[str, dict]] = []
    for block in raw.split("\n\n"):
        block = block.strip("\n")
        if not block:
            continue
        lines = block.split("\n")
        
        # Skip optional id line (from Phase D Last-Event-ID feature)
        idx = 0
        if lines[idx].startswith("id:"):
            idx += 1
        
        assert idx < len(lines) and lines[idx].startswith("event:"), f"bad SSE event framing: {block!r}"
        assert idx + 1 < len(lines) and lines[idx + 1].startswith("data:"), f"bad SSE data framing: {block!r}"
        event_type = lines[idx][len("event:") :].strip()
        payload = json.loads(lines[idx + 1][len("data:") :].strip())
        records.append((event_type, payload))
    return records


@pytest.mark.asyncio
async def test_retry_streams_over_http_sse_endpoint(tmp_path, monkeypatch):
    """The real SSE HTTP endpoint delivers a retried run, live and on replay.

    Task #55 proved a retried run publishes onto the in-memory bus a connected
    client would be subscribed to, but it drained the bus object directly. This
    test exercises the actual transport: ``GET /v1/sessions/{id}/agent/events``
    as a streaming HTTP response. A client connects to that SSE endpoint and,
    while connected, triggers the retry of a restart-cancelled approval. We
    assert the streamed HTTP body carries the rerun's ``tool_call`` (status
    ``succeeded``) and terminal ``done`` events, correctly framed as
    ``event:``/``data:`` SSE lines. Then a second client reconnects with
    ``since_seq`` set to its last-seen seq and must replay exactly the rerun's
    events over HTTP — no gaps, no stale re-delivery — guarding the SSE
    serialization/replay layer (framing, since_seq replay, JSON encoding)
    against regressions during a retry.
    """

    from contextlib import asynccontextmanager

    import uvicorn
    from httpx import AsyncClient
    from llama_studio_agent.app import create_app
    from llama_studio_agent.providers.base import ProviderToolCall
    from llama_studio_agent.providers.mock import MockResponse

    @asynccontextmanager
    async def _serve(app):
        """Run the app on a real ephemeral TCP port so SSE streams live.

        httpx's ASGITransport buffers the whole response body, which would
        defeat a streaming SSE test; a real uvicorn server flushes each
        ``event:``/``data:`` chunk as the generator yields it.
        """

        config = uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning")
        server = uvicorn.Server(config)
        serve_task = asyncio.create_task(server.serve())
        try:
            for _ in range(500):
                if server.started:
                    break
                await asyncio.sleep(0.01)
            assert server.started, "uvicorn server never started"
            port = server.servers[0].sockets[0].getsockname()[1]
            yield f"http://127.0.0.1:{port}"
        finally:
            server.should_exit = True
            await serve_task

    state = _make_state(tmp_path, monkeypatch)
    workspace = tmp_path / "ws"
    workspace.mkdir()
    sess = Session(
        title="t", workspace_root=str(workspace), provider="mock", model="mock-1"
    )
    state.repo.create_session(sess)
    state.repo.add_message(
        sess.id, Message(role=MessageRole.user, content="write a file")
    )
    # The missing permission was granted after the cancellation, so the rerun
    # proceeds to success without suspending again.
    state.permissions.grant(sess.id, PermissionScope.write_fs)

    # A call left cancelled by restart reconciliation — the retry's input.
    call = _cancelled_orphan(state, sess.id)

    # Emit some unrelated events first so the connected client has a non-trivial
    # last-seen high-water mark to reconnect from.
    for _ in range(5):
        state.repo.append_event(sess.id, state.bus.next_seq(sess.id), "log", {"x": 1})
    last_seen = state.repo.max_event_seq(sess.id)
    assert last_seen == 5

    provider = state.providers.get("mock")
    provider.reset()
    provider.queue(
        MockResponse(text='{"goal":"g","steps":[{"title":"write"}]}'),
        MockResponse(
            tool_calls=[
                ProviderToolCall(
                    id="c2",
                    name="write_file",
                    arguments={"path": "out.txt", "content": "hi"},
                )
            ]
        ),
        MockResponse(text="done"),
    )

    app = create_app(state.settings, state=state)

    raw = ""
    events_url = f"/v1/sessions/{sess.id}/agent/events"
    # Connect to the SSE endpoint, replaying from the client's last-seen seq so
    # only new (rerun) events arrive live.
    async with (
        _serve(app) as base_url,
        AsyncClient(base_url=base_url, timeout=30.0) as client,
        AsyncClient(base_url=base_url, timeout=30.0) as poster,
        client.stream("GET", events_url, params={"since_seq": last_seen}) as resp,
    ):
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")

        # Drive the generator far enough to subscribe to the bus, so no rerun
        # event can race ahead of the live subscription.
        for _ in range(500):
            if state.bus._subs.get(sess.id):
                break
            await asyncio.sleep(0.01)
        assert state.bus._subs.get(sess.id), "SSE endpoint never subscribed"

        # While connected, trigger the retry of the cancelled call.
        retry_task = asyncio.create_task(
            poster.post(f"/v1/sessions/{sess.id}/agent/approvals/{call.id}/retry")
        )

        # Read the streamed HTTP body until the terminal done event.
        async for chunk in resp.aiter_text():
            raw += chunk
            if '"type": "done"' in raw:
                break

        retry_resp = await retry_task

    assert retry_resp.status_code == 200
    assert retry_resp.json()["retried"] is True
    # The side effect really happened, so the rerun genuinely executed.
    assert (workspace / "out.txt").read_text() == "hi"

    # The streamed HTTP body is correctly framed SSE that decodes cleanly.
    live = _parse_sse(raw)
    assert live, "no SSE records streamed over HTTP"

    # The connected client saw the rerun's write_file succeed live over HTTP.
    succeeded = [
        p
        for t, p in live
        if t == "tool_call"
        and p["tool_call"]["name"] == "write_file"
        and p["tool_call"]["status"] == "succeeded"
    ]
    assert succeeded, "SSE stream never delivered write_file succeeded"

    # And the terminal done event was framed and delivered over HTTP.
    done_live = [p for t, p in live if t == "done"]
    assert done_live, "SSE stream never delivered the done event"

    # Every streamed event carries a seq strictly above the client's last-seen
    # high-water mark, and seqs are monotonically increasing as delivered.
    live_seqs = [p["seq"] for _, p in live]
    assert all(s > last_seen for s in live_seqs)
    assert live_seqs == sorted(live_seqs)

    # A client reconnecting with since_seq=last_seen replays exactly the rerun's
    # events over the real HTTP endpoint — same framing, no gaps, no stale
    # re-delivery of the events the client had already seen.
    replay_raw = ""
    async with (
        _serve(app) as base_url,
        AsyncClient(base_url=base_url, timeout=30.0) as client,
        client.stream(
            "GET",
            f"/v1/sessions/{sess.id}/agent/events",
            params={"since_seq": last_seen},
        ) as resp,
    ):
        assert resp.status_code == 200
        async for chunk in resp.aiter_text():
            replay_raw += chunk
            if '"type": "done"' in replay_raw:
                break

    replayed = _parse_sse(replay_raw)
    replay_seqs = [p["seq"] for _, p in replayed]
    # No stale re-delivery: every replayed event is strictly newer than the
    # last seq the client had already seen.
    assert replay_seqs, "since_seq replay returned nothing"
    assert all(s > last_seen for s in replay_seqs)
    # No gaps: the replayed seqs match what was delivered live, exactly.
    assert replay_seqs == sorted(replay_seqs)
    assert set(replay_seqs) == set(live_seqs)
    # The rerun's defining events are present in the replay too.
    replay_types = {t for t, _ in replayed}
    assert "tool_call" in replay_types
    assert "done" in replay_types
    replay_succeeded = [
        p
        for t, p in replayed
        if t == "tool_call"
        and p["tool_call"]["name"] == "write_file"
        and p["tool_call"]["status"] == "succeeded"
    ]
    assert replay_succeeded, "since_seq replay missing write_file succeeded"


@pytest.mark.asyncio
async def test_retry_fans_out_to_two_concurrent_http_subscribers(
    tmp_path, monkeypatch
):
    """Two clients watching the same session both see one retried run live.

    Task #58 proved a *single* client on the SSE endpoint
    (``GET /v1/sessions/{id}/agent/events``) receives a retried run live over
    real HTTP. The event bus fans a single ``publish`` out to *all* connected
    subscribers, but nothing exercised two clients watching the same session
    simultaneously. A regression in the per-session fan-out — only the first or
    last subscriber being served, or a subscriber being dropped — would slip
    through.

    Here two concurrent SSE HTTP connections are opened to the same session
    *before* the retry is triggered. While both are connected, the retry of a
    restart-cancelled approval runs. We assert each streamed response
    independently carries the rerun's ``write_file`` tool call (status
    ``succeeded``) and the terminal ``done`` event, correctly SSE-framed, and
    that both clients observe the identical set of seqs — no client misses or
    duplicates events.
    """

    from contextlib import asynccontextmanager

    import uvicorn
    from httpx import AsyncClient
    from llama_studio_agent.app import create_app
    from llama_studio_agent.providers.base import ProviderToolCall
    from llama_studio_agent.providers.mock import MockResponse

    @asynccontextmanager
    async def _serve(app):
        """Run the app on a real ephemeral TCP port so SSE streams live.

        httpx's ASGITransport buffers the whole response body, which would
        defeat a streaming SSE test; a real uvicorn server flushes each
        ``event:``/``data:`` chunk as the generator yields it.
        """

        config = uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning")
        server = uvicorn.Server(config)
        serve_task = asyncio.create_task(server.serve())
        try:
            for _ in range(500):
                if server.started:
                    break
                await asyncio.sleep(0.01)
            assert server.started, "uvicorn server never started"
            port = server.servers[0].sockets[0].getsockname()[1]
            yield f"http://127.0.0.1:{port}"
        finally:
            server.should_exit = True
            await serve_task

    state = _make_state(tmp_path, monkeypatch)
    workspace = tmp_path / "ws"
    workspace.mkdir()
    sess = Session(
        title="t", workspace_root=str(workspace), provider="mock", model="mock-1"
    )
    state.repo.create_session(sess)
    state.repo.add_message(
        sess.id, Message(role=MessageRole.user, content="write a file")
    )
    # The missing permission was granted after the cancellation, so the rerun
    # proceeds to success without suspending again.
    state.permissions.grant(sess.id, PermissionScope.write_fs)

    # A call left cancelled by restart reconciliation — the retry's input.
    call = _cancelled_orphan(state, sess.id)

    # Emit some unrelated events first so both clients have a non-trivial
    # last-seen high-water mark to reconnect from.
    for _ in range(5):
        state.repo.append_event(sess.id, state.bus.next_seq(sess.id), "log", {"x": 1})
    last_seen = state.repo.max_event_seq(sess.id)
    assert last_seen == 5

    provider = state.providers.get("mock")
    provider.reset()
    provider.queue(
        MockResponse(text='{"goal":"g","steps":[{"title":"write"}]}'),
        MockResponse(
            tool_calls=[
                ProviderToolCall(
                    id="c2",
                    name="write_file",
                    arguments={"path": "out.txt", "content": "hi"},
                )
            ]
        ),
        MockResponse(text="done"),
    )

    app = create_app(state.settings, state=state)
    events_url = f"/v1/sessions/{sess.id}/agent/events"

    async def _drain(resp) -> str:
        raw = ""
        async for chunk in resp.aiter_text():
            raw += chunk
            if '"type": "done"' in raw:
                break
        return raw

    raw_a = ""
    raw_b = ""
    # Open TWO concurrent SSE connections to the same session before any retry.
    async with (
        _serve(app) as base_url,
        AsyncClient(base_url=base_url, timeout=30.0) as client_a,
        AsyncClient(base_url=base_url, timeout=30.0) as client_b,
        AsyncClient(base_url=base_url, timeout=30.0) as poster,
        client_a.stream(
            "GET", events_url, params={"since_seq": last_seen}
        ) as resp_a,
        client_b.stream(
            "GET", events_url, params={"since_seq": last_seen}
        ) as resp_b,
    ):
        assert resp_a.status_code == 200
        assert resp_b.status_code == 200
        assert resp_a.headers["content-type"].startswith("text/event-stream")
        assert resp_b.headers["content-type"].startswith("text/event-stream")

        # Wait until BOTH connections have subscribed to the bus, so no rerun
        # event can race ahead of either live subscription.
        for _ in range(500):
            if len(state.bus._subs.get(sess.id, ())) >= 2:
                break
            await asyncio.sleep(0.01)
        assert (
            len(state.bus._subs.get(sess.id, ())) >= 2
        ), "both SSE clients never subscribed"

        # Start draining both streams concurrently, then trigger the retry.
        drain_a = asyncio.create_task(_drain(resp_a))
        drain_b = asyncio.create_task(_drain(resp_b))
        retry_task = asyncio.create_task(
            poster.post(f"/v1/sessions/{sess.id}/agent/approvals/{call.id}/retry")
        )

        raw_a, raw_b = await asyncio.gather(drain_a, drain_b)
        retry_resp = await retry_task

    assert retry_resp.status_code == 200
    assert retry_resp.json()["retried"] is True
    # The side effect really happened, so the rerun genuinely executed once.
    assert (workspace / "out.txt").read_text() == "hi"

    live_a = _parse_sse(raw_a)
    live_b = _parse_sse(raw_b)
    assert live_a, "client A received no SSE records"
    assert live_b, "client B received no SSE records"

    # Each client independently saw the rerun's write_file succeed live.
    for label, live in (("A", live_a), ("B", live_b)):
        succeeded = [
            p
            for t, p in live
            if t == "tool_call"
            and p["tool_call"]["name"] == "write_file"
            and p["tool_call"]["status"] == "succeeded"
        ]
        assert succeeded, f"client {label} never saw write_file succeeded"
        done_live = [p for t, p in live if t == "done"]
        assert done_live, f"client {label} never saw the done event"

    # Every streamed event (for both) carries a seq strictly above the shared
    # last-seen high-water mark, and seqs are monotonic per client.
    seqs_a = [p["seq"] for _, p in live_a]
    seqs_b = [p["seq"] for _, p in live_b]
    assert all(s > last_seen for s in seqs_a)
    assert all(s > last_seen for s in seqs_b)
    assert seqs_a == sorted(seqs_a)
    assert seqs_b == sorted(seqs_b)

    # Both clients observed the IDENTICAL set of seqs — the fan-out delivered
    # the same run to both, with no client missing or duplicating events.
    assert len(seqs_a) == len(set(seqs_a)), "client A received duplicate seqs"
    assert len(seqs_b) == len(set(seqs_b)), "client B received duplicate seqs"
    assert seqs_a == seqs_b, "the two subscribers saw different event seqs"


@pytest.mark.asyncio
async def test_retry_streams_resuspension_over_http_sse_endpoint(
    tmp_path, monkeypatch
):
    """The SSE HTTP endpoint surfaces a retry that re-suspends for approval.

    Task #58 proved the happy path: when the missing permission was already
    granted, the retried run streams straight through to a successful
    ``write_file`` and a terminal ``done`` over the real
    ``GET /v1/sessions/{id}/agent/events`` transport. The other real outcome
    is a retry that *re-suspends*: the user has **not** yet granted the needed
    scope, so the re-attempted tool blocks on the approval gate again and the
    UI must re-prompt.

    Here a client connects to the SSE endpoint and, while connected, triggers
    the retry of a restart-cancelled approval *without* the required
    ``write_fs`` grant. We assert the streamed HTTP body carries the
    ``write_file`` tool call with status ``needs_approval`` (correctly framed
    as ``event:``/``data:`` SSE lines), then deny the gate so the blocked retry
    request can finish. Finally a second client reconnects with ``since_seq``
    set to its last-seen seq and must replay that same ``needs_approval`` event
    over HTTP — guarding the SSE serialization/replay layer for a re-suspension
    during a retry.
    """

    from contextlib import asynccontextmanager

    import uvicorn
    from httpx import AsyncClient
    from llama_studio_agent.app import create_app
    from llama_studio_agent.providers.base import ProviderToolCall
    from llama_studio_agent.providers.mock import MockResponse

    @asynccontextmanager
    async def _serve(app):
        """Run the app on a real ephemeral TCP port so SSE streams live.

        httpx's ASGITransport buffers the whole response body, which would
        defeat a streaming SSE test; a real uvicorn server flushes each
        ``event:``/``data:`` chunk as the generator yields it.
        """

        config = uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning")
        server = uvicorn.Server(config)
        serve_task = asyncio.create_task(server.serve())
        try:
            for _ in range(500):
                if server.started:
                    break
                await asyncio.sleep(0.01)
            assert server.started, "uvicorn server never started"
            port = server.servers[0].sockets[0].getsockname()[1]
            yield f"http://127.0.0.1:{port}"
        finally:
            server.should_exit = True
            await serve_task

    state = _make_state(tmp_path, monkeypatch)
    workspace = tmp_path / "ws"
    workspace.mkdir()
    sess = Session(
        title="t", workspace_root=str(workspace), provider="mock", model="mock-1"
    )
    state.repo.create_session(sess)
    state.repo.add_message(
        sess.id, Message(role=MessageRole.user, content="write a file")
    )
    # Crucially: the missing permission is NOT granted, so the re-attempted
    # write_file blocks on the approval gate again.
    assert not state.permissions.has(sess.id, PermissionScope.write_fs)

    # A call left cancelled by restart reconciliation — the retry's input.
    call = _cancelled_orphan(state, sess.id)

    # Emit some unrelated events first so the connected client has a non-trivial
    # last-seen high-water mark to reconnect from.
    for _ in range(5):
        state.repo.append_event(sess.id, state.bus.next_seq(sess.id), "log", {"x": 1})
    last_seen = state.repo.max_event_seq(sess.id)
    assert last_seen == 5

    provider = state.providers.get("mock")
    provider.reset()
    # Plan, then ask to write a file — which has no grant and so suspends for
    # approval. No terminal `done` is queued: the run blocks at the gate.
    provider.queue(
        MockResponse(text='{"goal":"g","steps":[{"title":"write"}]}'),
        MockResponse(
            tool_calls=[
                ProviderToolCall(
                    id="c2",
                    name="write_file",
                    arguments={"path": "out.txt", "content": "hi"},
                )
            ]
        ),
        # After denial the orchestrator finishes the run with no further tools.
        MockResponse(text="done"),
    )

    app = create_app(state.settings, state=state)
    events_url = f"/v1/sessions/{sess.id}/agent/events"

    raw = ""
    # Connect to the SSE endpoint, replaying from the client's last-seen seq so
    # only new (rerun) events arrive live.
    async with (
        _serve(app) as base_url,
        AsyncClient(base_url=base_url, timeout=30.0) as client,
        AsyncClient(base_url=base_url, timeout=30.0) as poster,
        client.stream("GET", events_url, params={"since_seq": last_seen}) as resp,
    ):
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")

        # Drive the generator far enough to subscribe to the bus, so no rerun
        # event can race ahead of the live subscription.
        for _ in range(500):
            if state.bus._subs.get(sess.id):
                break
            await asyncio.sleep(0.01)
        assert state.bus._subs.get(sess.id), "SSE endpoint never subscribed"

        # While connected, trigger the retry of the cancelled call. This POST
        # will block at the approval gate (no grant), so it does not complete
        # until we deny below.
        retry_task = asyncio.create_task(
            poster.post(f"/v1/sessions/{sess.id}/agent/approvals/{call.id}/retry")
        )

        # Read the streamed HTTP body until the re-suspension's needs_approval
        # tool_call arrives (followed by the "awaiting approval" log, whose
        # terminator guarantees the tool_call record is complete).
        async for chunk in resp.aiter_text():
            raw += chunk
            if "needs_approval" in raw and raw.endswith("\n\n"):
                break

        # The rerun is now suspended on the gate. Deny it so the blocked retry
        # request can finish and release cleanly.
        pending = ()
        for _ in range(500):
            pending = state.approvals.pending(sess.id)
            if pending:
                break
            await asyncio.sleep(0.01)
        assert pending, "rerun never suspended for approval"
        for cid in list(pending):
            state.approvals.resolve(sess.id, cid, False)

        retry_resp = await retry_task

    assert retry_resp.status_code == 200
    assert retry_resp.json()["retried"] is True
    # The write was blocked, not executed — nothing was written to disk.
    assert not (workspace / "out.txt").exists()

    # The streamed HTTP body is correctly framed SSE that decodes cleanly.
    live = _parse_sse(raw)
    assert live, "no SSE records streamed over HTTP"

    # The connected client saw the rerun's write_file re-suspend live over HTTP.
    needs_approval = [
        p
        for t, p in live
        if t == "tool_call"
        and p["tool_call"]["name"] == "write_file"
        and p["tool_call"]["status"] == "needs_approval"
    ]
    assert needs_approval, "SSE stream never delivered write_file needs_approval"

    # Every streamed event carries a seq strictly above the client's last-seen
    # high-water mark, and seqs are monotonically increasing as delivered.
    live_seqs = [p["seq"] for _, p in live]
    assert all(s > last_seen for s in live_seqs)
    assert live_seqs == sorted(live_seqs)

    # A client reconnecting with since_seq=last_seen replays the rerun's events
    # over the real HTTP endpoint — including the needs_approval re-suspension —
    # with the same framing, no gaps, no stale re-delivery. We read until the
    # terminal done event (emitted once the run finished after the denial).
    replay_raw = ""
    async with (
        _serve(app) as base_url,
        AsyncClient(base_url=base_url, timeout=30.0) as client,
        client.stream(
            "GET",
            f"/v1/sessions/{sess.id}/agent/events",
            params={"since_seq": last_seen},
        ) as resp,
    ):
        assert resp.status_code == 200
        async for chunk in resp.aiter_text():
            replay_raw += chunk
            if '"type": "done"' in replay_raw:
                break

    replayed = _parse_sse(replay_raw)
    replay_seqs = [p["seq"] for _, p in replayed]
    # No stale re-delivery: every replayed event is strictly newer than the
    # last seq the client had already seen.
    assert replay_seqs, "since_seq replay returned nothing"
    assert all(s > last_seen for s in replay_seqs)
    assert replay_seqs == sorted(replay_seqs)
    # The re-suspension event is present on replay too, identically framed.
    replay_needs_approval = [
        p
        for t, p in replayed
        if t == "tool_call"
        and p["tool_call"]["name"] == "write_file"
        and p["tool_call"]["status"] == "needs_approval"
    ]
    assert replay_needs_approval, "since_seq replay missing write_file needs_approval"


@pytest.mark.asyncio
async def test_retry_resuspends_then_approved_streams_success_over_http_sse(
    tmp_path, monkeypatch
):
    """The SSE endpoint re-prompts then resumes a retry to success over HTTP.

    Task #61 proved a retry that *re-suspends* surfaces ``needs_approval`` over
    the real ``GET /v1/sessions/{id}/agent/events`` transport, and Task #58
    proved the straight-through happy path. This combines them into the full
    re-prompt-then-resume loop on a single live SSE connection:

    1. A client connects to the SSE endpoint and triggers the retry of a
       restart-cancelled approval *without* the ``write_fs`` grant, so the
       re-attempted ``write_file`` blocks on the approval gate again — the
       stream delivers a ``needs_approval`` tool call (the re-prompt).
    2. The user then grants the missing scope and approves the suspended call
       via ``POST /v1/sessions/{id}/agent/approvals/{call_id}``.
    3. The *same* SSE connection goes on to deliver the ``write_file``
       succeeding and a terminal ``done``, correctly ``event:``/``data:``
       framed.

    Finally a second client reconnects with ``since_seq`` set to its last-seen
    seq and must replay the whole re-prompt-then-resume sequence over HTTP —
    the ``needs_approval``, the ``succeeded`` and the ``done`` — guarding the
    end-to-end path through the transport layer.
    """

    from contextlib import asynccontextmanager

    import uvicorn
    from httpx import AsyncClient
    from llama_studio_agent.app import create_app
    from llama_studio_agent.providers.base import ProviderToolCall
    from llama_studio_agent.providers.mock import MockResponse

    @asynccontextmanager
    async def _serve(app):
        """Run the app on a real ephemeral TCP port so SSE streams live.

        httpx's ASGITransport buffers the whole response body, which would
        defeat a streaming SSE test; a real uvicorn server flushes each
        ``event:``/``data:`` chunk as the generator yields it.
        """

        config = uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning")
        server = uvicorn.Server(config)
        serve_task = asyncio.create_task(server.serve())
        try:
            for _ in range(500):
                if server.started:
                    break
                await asyncio.sleep(0.01)
            assert server.started, "uvicorn server never started"
            port = server.servers[0].sockets[0].getsockname()[1]
            yield f"http://127.0.0.1:{port}"
        finally:
            server.should_exit = True
            await serve_task

    state = _make_state(tmp_path, monkeypatch)
    workspace = tmp_path / "ws"
    workspace.mkdir()
    sess = Session(
        title="t", workspace_root=str(workspace), provider="mock", model="mock-1"
    )
    state.repo.create_session(sess)
    state.repo.add_message(
        sess.id, Message(role=MessageRole.user, content="write a file")
    )
    # Crucially: the missing permission is NOT granted yet, so the re-attempted
    # write_file blocks on the approval gate and the UI must re-prompt.
    assert not state.permissions.has(sess.id, PermissionScope.write_fs)

    # A call left cancelled by restart reconciliation — the retry's input.
    call = _cancelled_orphan(state, sess.id)

    # Emit some unrelated events first so the connected client has a non-trivial
    # last-seen high-water mark to reconnect from.
    for _ in range(5):
        state.repo.append_event(sess.id, state.bus.next_seq(sess.id), "log", {"x": 1})
    last_seen = state.repo.max_event_seq(sess.id)
    assert last_seen == 5

    provider = state.providers.get("mock")
    provider.reset()
    # Plan, then ask to write a file — which has no grant and so suspends for
    # approval. After approval the same tool executes, then the run finishes.
    provider.queue(
        MockResponse(text='{"goal":"g","steps":[{"title":"write"}]}'),
        MockResponse(
            tool_calls=[
                ProviderToolCall(
                    id="c2",
                    name="write_file",
                    arguments={"path": "out.txt", "content": "hi"},
                )
            ]
        ),
        MockResponse(text="done"),
    )

    app = create_app(state.settings, state=state)
    events_url = f"/v1/sessions/{sess.id}/agent/events"

    raw = ""
    # Connect to the SSE endpoint, replaying from the client's last-seen seq so
    # only new (rerun) events arrive live.
    async with (
        _serve(app) as base_url,
        AsyncClient(base_url=base_url, timeout=30.0) as client,
        AsyncClient(base_url=base_url, timeout=30.0) as poster,
        client.stream("GET", events_url, params={"since_seq": last_seen}) as resp,
    ):
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")

        # Drive the generator far enough to subscribe to the bus, so no rerun
        # event can race ahead of the live subscription.
        for _ in range(500):
            if state.bus._subs.get(sess.id):
                break
            await asyncio.sleep(0.01)
        assert state.bus._subs.get(sess.id), "SSE endpoint never subscribed"

        # While connected, trigger the retry of the cancelled call. This POST
        # will block at the approval gate (no grant), so it does not complete
        # until we approve below.
        retry_task = asyncio.create_task(
            poster.post(f"/v1/sessions/{sess.id}/agent/approvals/{call.id}/retry")
        )

        # A single iterator reused across both phases: httpx forbids calling
        # ``aiter_text()`` twice on one response, and the resume must arrive on
        # the *same* live connection that delivered the re-prompt.
        stream = resp.aiter_text()

        # Phase 1: read the streamed HTTP body until the re-suspension's
        # needs_approval tool_call arrives (followed by the "awaiting approval"
        # log, whose terminator guarantees the tool_call record is complete).
        async for chunk in stream:
            raw += chunk
            if "needs_approval" in raw and raw.endswith("\n\n"):
                break

        # The rerun is now suspended on the gate. Capture the *new* suspended
        # call id (the rerun's, distinct from the original orphan).
        pending = ()
        for _ in range(500):
            pending = state.approvals.pending(sess.id)
            if pending:
                break
            await asyncio.sleep(0.01)
        assert pending, "rerun never suspended for approval"
        assert len(pending) == 1
        suspended_id = next(iter(pending))
        assert suspended_id != call.id, "rerun reused the cancelled orphan's id"

        # Phase 2: the user grants the missing scope, then approves the
        # suspended call via the real HTTP approval endpoint.
        state.permissions.grant(sess.id, PermissionScope.write_fs)
        approve_resp = await poster.post(
            f"/v1/sessions/{sess.id}/agent/approvals/{suspended_id}",
            json={"allowed": True},
        )
        assert approve_resp.status_code == 200
        approve_body = approve_resp.json()
        assert approve_body["resolved"] is True
        assert approve_body["reason"] == "resolved"

        # Phase 3: the same SSE connection now delivers the write succeeding
        # and the terminal done.
        async for chunk in stream:
            raw += chunk
            if '"type": "done"' in raw:
                break

        retry_resp = await retry_task

    assert retry_resp.status_code == 200
    assert retry_resp.json()["retried"] is True
    # The previously-blocked write actually executed to disk after approval.
    assert (workspace / "out.txt").read_text() == "hi"

    # The streamed HTTP body is correctly framed SSE that decodes cleanly.
    live = _parse_sse(raw)
    assert live, "no SSE records streamed over HTTP"

    # The connected client saw the re-prompt: write_file needs_approval live.
    needs_approval = [
        p
        for t, p in live
        if t == "tool_call"
        and p["tool_call"]["name"] == "write_file"
        and p["tool_call"]["status"] == "needs_approval"
    ]
    assert needs_approval, "SSE stream never delivered write_file needs_approval"

    # ...then the resume: write_file succeeded and a terminal done, all on the
    # same connection and after the re-prompt.
    succeeded = [
        p
        for t, p in live
        if t == "tool_call"
        and p["tool_call"]["name"] == "write_file"
        and p["tool_call"]["status"] == "succeeded"
    ]
    assert succeeded, "SSE stream never delivered write_file succeeded"
    done_live = [p for t, p in live if t == "done"]
    assert done_live, "SSE stream never delivered the done event"
    # The re-prompt strictly preceded the success on the wire.
    assert needs_approval[0]["seq"] < succeeded[0]["seq"]

    # Every streamed event carries a seq strictly above the client's last-seen
    # high-water mark, and seqs are monotonically increasing as delivered.
    live_seqs = [p["seq"] for _, p in live]
    assert all(s > last_seen for s in live_seqs)
    assert live_seqs == sorted(live_seqs)

    # A client reconnecting with since_seq=last_seen replays the whole
    # re-prompt-then-resume sequence over the real HTTP endpoint — same
    # framing, no gaps, no stale re-delivery of events already seen.
    replay_raw = ""
    async with (
        _serve(app) as base_url,
        AsyncClient(base_url=base_url, timeout=30.0) as client,
        client.stream(
            "GET",
            f"/v1/sessions/{sess.id}/agent/events",
            params={"since_seq": last_seen},
        ) as resp,
    ):
        assert resp.status_code == 200
        async for chunk in resp.aiter_text():
            replay_raw += chunk
            if '"type": "done"' in replay_raw:
                break

    replayed = _parse_sse(replay_raw)
    replay_seqs = [p["seq"] for _, p in replayed]
    assert replay_seqs, "since_seq replay returned nothing"
    assert all(s > last_seen for s in replay_seqs)
    assert replay_seqs == sorted(replay_seqs)
    # The whole sequence is present on replay too, identically framed.
    replay_needs_approval = [
        p
        for t, p in replayed
        if t == "tool_call"
        and p["tool_call"]["name"] == "write_file"
        and p["tool_call"]["status"] == "needs_approval"
    ]
    assert replay_needs_approval, "since_seq replay missing needs_approval re-prompt"
    replay_succeeded = [
        p
        for t, p in replayed
        if t == "tool_call"
        and p["tool_call"]["name"] == "write_file"
        and p["tool_call"]["status"] == "succeeded"
    ]
    assert replay_succeeded, "since_seq replay missing write_file succeeded"
    assert any(t == "done" for t, _ in replayed), "since_seq replay missing done"
