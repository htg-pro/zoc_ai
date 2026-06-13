"""Interactive approval round-trip: a tool that needs a missing permission
suspends as `needs_approval`, then resumes when the user resolves it."""

from __future__ import annotations

import asyncio

import pytest
from llama_studio_agent.agent.orchestrator import AgentOrchestrator, OrchestratorConfig
from llama_studio_agent.providers.base import ProviderToolCall
from llama_studio_agent.providers.mock import MockResponse
from shared_schema.models import PermissionScope, ToolCallStatus


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
        approvals=app_state.approvals,
    )


async def _wait_for_pending(app_state, session, timeout=2.0):
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        pending = app_state.approvals.pending(session.id)
        if pending:
            return pending[0]
        await asyncio.sleep(0.01)
    raise AssertionError("tool call never suspended for approval")


@pytest.mark.asyncio
async def test_suspends_then_resumes_on_allow_once(app_state, session, mock_provider):
    # Revoke write_fs so write_file needs approval.
    app_state.permissions.revoke(session.id, PermissionScope.write_fs)
    write = ProviderToolCall(
        id="t1", name="write_file", arguments={"path": "out.txt", "content": "hi"}
    )
    mock_provider.queue(
        MockResponse(text='{"goal":"g","steps":[{"title":"write"}]}'),
        MockResponse(text="", tool_calls=[write]),
        MockResponse(text="done"),
    )
    orch = _make_orch(app_state, session)

    run_task = asyncio.create_task(
        orch.run(
            session_id=session.id,
            workspace_root=session.workspace_root,
            prompt="write a file",
            config=OrchestratorConfig(approval_timeout=5.0),
        )
    )

    call_id = await _wait_for_pending(app_state, session)
    # Grant "allow once" the way the frontend would, then resume the call.
    app_state.permissions.grant_tool(session.id, "write_file", once=True)
    assert app_state.approvals.resolve(session.id, call_id, True) is True

    res = await asyncio.wait_for(run_task, timeout=5.0)

    statuses = [c.status for c in res.tool_calls]
    assert ToolCallStatus.succeeded in statuses
    assert res.final_text == "done"
    # The one-shot grant was consumed by the resumed call.
    assert app_state.permissions.tool_grant(session.id, "write_file") is None


@pytest.mark.asyncio
async def test_denied_approval_fails_the_call(app_state, session, mock_provider):
    app_state.permissions.revoke(session.id, PermissionScope.write_fs)
    write = ProviderToolCall(
        id="t1", name="write_file", arguments={"path": "out.txt", "content": "hi"}
    )
    mock_provider.queue(
        MockResponse(text='{"goal":"g","steps":[{"title":"write"}]}'),
        MockResponse(text="", tool_calls=[write]),
        MockResponse(text="gave up"),
    )
    orch = _make_orch(app_state, session)

    run_task = asyncio.create_task(
        orch.run(
            session_id=session.id,
            workspace_root=session.workspace_root,
            prompt="write a file",
            config=OrchestratorConfig(approval_timeout=5.0, max_repair_attempts=0),
        )
    )

    call_id = await _wait_for_pending(app_state, session)
    assert app_state.approvals.resolve(session.id, call_id, False) is True

    res = await asyncio.wait_for(run_task, timeout=5.0)
    failed = [c for c in res.tool_calls if c.status == ToolCallStatus.failed]
    assert failed and "not approved" in (failed[0].error or "")


@pytest.mark.asyncio
async def test_timeout_treated_as_denial(app_state, session, mock_provider):
    app_state.permissions.revoke(session.id, PermissionScope.write_fs)
    write = ProviderToolCall(
        id="t1", name="write_file", arguments={"path": "out.txt", "content": "hi"}
    )
    mock_provider.queue(
        MockResponse(text='{"goal":"g","steps":[{"title":"write"}]}'),
        MockResponse(text="", tool_calls=[write]),
        MockResponse(text="gave up"),
    )
    orch = _make_orch(app_state, session)

    res = await asyncio.wait_for(
        orch.run(
            session_id=session.id,
            workspace_root=session.workspace_root,
            prompt="write a file",
            config=OrchestratorConfig(approval_timeout=0.05, max_repair_attempts=0),
        ),
        timeout=5.0,
    )
    failed = [c for c in res.tool_calls if c.status == ToolCallStatus.failed]
    assert failed
