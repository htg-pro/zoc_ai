import pytest
from llama_studio_agent.agent.orchestrator import AgentOrchestrator, OrchestratorConfig
from llama_studio_agent.providers.base import ProviderToolCall
from llama_studio_agent.providers.mock import MockResponse


def _make_orch(app_state, session):
    indexer = app_state.indexer_for(session.id, session.workspace_root)
    return AgentOrchestrator(
        provider=app_state.providers.get("mock"),
        model="mock-1",
        registry=app_state.tools,
        repo=app_state.repo,
        bus=app_state.bus,
        indexer=indexer,
        permissions=app_state.permissions,
    )


@pytest.mark.asyncio
async def test_orchestrator_simple_summary(app_state, session, mock_provider):
    # Planner reply, then assistant final answer with no tool calls.
    mock_provider.queue(
        MockResponse(text='{"goal": "g", "steps": [{"title": "answer"}]}'),
        MockResponse(text="done."),
    )
    orch = _make_orch(app_state, session)
    res = await orch.run(
        session_id=session.id, workspace_root=session.workspace_root, prompt="say done"
    )
    assert res.final_text == "done."
    assert res.plan and res.plan.goal == "g"
    # plan persisted and at least one event recorded
    assert app_state.repo.get_plan(session.id) is not None
    assert app_state.repo.list_events(session.id)


@pytest.mark.asyncio
async def test_orchestrator_tool_call_succeeds(app_state, session, mock_provider, tmp_workspace):
    tc = ProviderToolCall(id="t1", name="read_file", arguments={"path": "src/hello.py"})
    mock_provider.queue(
        MockResponse(text='{"goal":"g","steps":[{"title":"read"}]}'),
        MockResponse(text="", tool_calls=[tc]),
        MockResponse(text="ok"),
    )
    orch = _make_orch(app_state, session)
    res = await orch.run(
        session_id=session.id, workspace_root=session.workspace_root, prompt="read file"
    )
    assert any(c.name == "read_file" and c.status.value == "succeeded" for c in res.tool_calls)
    assert res.final_text == "ok"


@pytest.mark.asyncio
async def test_orchestrator_repair_after_failure(app_state, session, mock_provider):
    bad = ProviderToolCall(id="t1", name="read_file", arguments={"path": "missing.py"})
    good = ProviderToolCall(id="t2", name="read_file", arguments={"path": "src/hello.py"})
    mock_provider.queue(
        MockResponse(text='{"goal":"g","steps":[{"title":"read"}]}'),
        MockResponse(text="", tool_calls=[bad]),  # initial call → fails
        MockResponse(text="", tool_calls=[good]),  # repair attempt → succeeds
        MockResponse(text="recovered"),
    )
    orch = _make_orch(app_state, session)
    res = await orch.run(
        session_id=session.id,
        workspace_root=session.workspace_root,
        prompt="read",
        config=OrchestratorConfig(max_repair_attempts=2),
    )
    statuses = [c.status.value for c in res.tool_calls]
    assert "failed" in statuses and "succeeded" in statuses
    assert res.repaired is True
