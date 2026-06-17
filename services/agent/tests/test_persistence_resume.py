"""Persistence-resume: a fresh AppState built against the same data dir
sees sessions, messages, plans, tool calls, permissions, and the SSE
event log that an earlier process wrote.

This is the contract the Tauri shell relies on when it restarts the
sidecar — nothing should be lost across crashes.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from shared_schema.models import (
    Message,
    MessageRole,
    PermissionGrant,
    PermissionScope,
    Plan,
    PlanStep,
    PlanStepStatus,
    Session,
    ToolCall,
    ToolCallStatus,
)


def _make_state(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("LLAMA_STUDIO_DATA_DIR", str(tmp_path / "data"))
    from llama_studio_agent.config import get_settings, reset_settings_cache
    from llama_studio_agent.state import build_app_state

    reset_settings_cache()
    return build_app_state(get_settings())


def test_resume_round_trip(tmp_path, monkeypatch):
    s1 = _make_state(tmp_path, monkeypatch)
    sess = Session(title="resume", workspace_root=str(tmp_path), provider="mock", model="mock-1")
    s1.repo.create_session(sess)
    s1.repo.add_message(sess.id, Message(role=MessageRole.user, content="ping"))
    s1.repo.add_message(sess.id, Message(role=MessageRole.assistant, content="pong"))
    plan = Plan(goal="g", steps=[PlanStep(title="a", status=PlanStepStatus.done, done=True)])
    s1.repo.save_plan(sess.id, plan)
    s1.repo.upsert_tool_call(
        sess.id,
        ToolCall(
            name="read_file",
            arguments={"path": "x"},
            status=ToolCallStatus.succeeded,
            started_at=datetime.now(UTC),
            finished_at=datetime.now(UTC),
        ),
    )
    s1.repo.set_permission(sess.id, PermissionGrant(scope=PermissionScope.write_fs, granted=True))
    s1.repo.append_event(sess.id, 1, "log", {"hello": "world"})

    # Drop and re-open against the same on-disk store.
    del s1
    s2 = _make_state(tmp_path, monkeypatch)

    fetched = s2.repo.get_session(sess.id)
    assert fetched is not None
    assert fetched.title == "resume"

    msgs = s2.repo.list_messages(sess.id)
    assert [m.content for m in msgs] == ["ping", "pong"]

    plan2 = s2.repo.get_plan(sess.id)
    assert plan2 and plan2.steps[0].done is True

    calls = s2.repo.list_tool_calls(sess.id)
    assert calls and calls[0].name == "read_file"

    grants = {g.scope: g.granted for g in s2.repo.get_permissions(sess.id)}
    assert grants.get(PermissionScope.write_fs) is True

    events = s2.repo.list_events(sess.id)
    assert events and events[0]["type"] == "log" and events[0]["payload"]["hello"] == "world"
