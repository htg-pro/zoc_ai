from datetime import datetime

from shared_schema.models import (
    Message,
    MessageRole,
    Plan,
    PlanStep,
    PlanStepStatus,
    Session,
    ToolCall,
    ToolCallStatus,
)


def test_session_roundtrip(app_state, tmp_workspace):
    s = Session(title="t", workspace_root=str(tmp_workspace))
    app_state.repo.create_session(s)
    fetched = app_state.repo.get_session(s.id)
    assert fetched is not None
    assert fetched.title == "t"


def test_messages_and_plan(app_state, tmp_workspace):
    s = Session(title="t", workspace_root=str(tmp_workspace))
    app_state.repo.create_session(s)
    app_state.repo.add_message(s.id, Message(role=MessageRole.user, content="hi"))
    app_state.repo.add_message(s.id, Message(role=MessageRole.assistant, content="hello"))
    msgs = app_state.repo.list_messages(s.id)
    assert [m.content for m in msgs] == ["hi", "hello"]

    plan = Plan(goal="g", steps=[PlanStep(title="a"), PlanStep(title="b")])
    app_state.repo.save_plan(s.id, plan)
    fetched_plan = app_state.repo.get_plan(s.id)
    assert fetched_plan and [st.title for st in fetched_plan.steps] == ["a", "b"]

    # update plan step status
    plan.steps[0].status = PlanStepStatus.done
    plan.steps[0].done = True
    app_state.repo.save_plan(s.id, plan)
    fetched_plan = app_state.repo.get_plan(s.id)
    assert fetched_plan.steps[0].done is True


def test_tool_calls_and_events(app_state, tmp_workspace):
    s = Session(title="t", workspace_root=str(tmp_workspace))
    app_state.repo.create_session(s)
    call = ToolCall(name="x", arguments={"a": 1}, status=ToolCallStatus.succeeded,
                    started_at=datetime.utcnow(), finished_at=datetime.utcnow())
    app_state.repo.upsert_tool_call(s.id, call)
    assert app_state.repo.list_tool_calls(s.id)[0].name == "x"

    app_state.repo.append_event(s.id, 1, "log", {"hi": True})
    events = app_state.repo.list_events(s.id)
    assert events and events[0]["type"] == "log"
