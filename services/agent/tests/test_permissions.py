import pytest
from llama_studio_agent.permissions import PermissionDenied
from llama_studio_agent.tools.base import ToolContext
from llama_studio_agent.tools.filesystem import WriteFileTool
from shared_schema.models import PermissionScope, ToolGrant


@pytest.mark.asyncio
async def test_write_blocked_when_no_grant(app_state, session):
    app_state.permissions.revoke(session.id, PermissionScope.write_fs)
    ctx = ToolContext(
        session_id=session.id,
        workspace_root=session.workspace_root,
        permissions=app_state.permissions,
    )
    res = await WriteFileTool().execute(ctx, {"path": "x", "content": "y"})
    assert not res.ok
    assert "write_fs" in (res.error or "")


def test_permission_manager_caches(app_state, session):
    pm = app_state.permissions
    assert pm.has(session.id, PermissionScope.read_fs) is True
    # revoke and confirm
    pm.revoke(session.id, PermissionScope.read_fs)
    assert pm.has(session.id, PermissionScope.read_fs) is False
    with pytest.raises(PermissionDenied):
        pm.require(session.id, PermissionScope.read_fs)


@pytest.mark.asyncio
async def test_per_tool_grant_bypasses_missing_scope(app_state, session):
    # Scope is revoked, but an explicit per-tool grant authorises the tool.
    app_state.permissions.revoke(session.id, PermissionScope.write_fs)
    app_state.permissions.grant_tool(session.id, "write_file")
    ctx = ToolContext(
        session_id=session.id,
        workspace_root=session.workspace_root,
        permissions=app_state.permissions,
    )
    res = await WriteFileTool().execute(ctx, {"path": "x.txt", "content": "y"})
    assert res.ok


@pytest.mark.asyncio
async def test_allow_once_grant_is_consumed(app_state, session):
    app_state.permissions.revoke(session.id, PermissionScope.write_fs)
    app_state.permissions.grant_tool(session.id, "write_file", once=True)
    ctx = ToolContext(
        session_id=session.id,
        workspace_root=session.workspace_root,
        permissions=app_state.permissions,
    )
    first = await WriteFileTool().execute(ctx, {"path": "x.txt", "content": "y"})
    assert first.ok
    # The one-shot grant is consumed; the next call falls back to the scope
    # check, which now fails.
    second = await WriteFileTool().execute(ctx, {"path": "x.txt", "content": "z"})
    assert not second.ok
    assert "write_fs" in (second.error or "")


def test_tool_grant_persistence_and_revoke(app_state, session):
    pm = app_state.permissions
    pm.grant_tool(session.id, "run_command", note="from prompt")
    grants = app_state.repo.get_tool_grants(session.id)
    assert any(
        g.tool == "run_command" and g.granted and g.note == "from prompt"
        for g in grants
    )
    pm.revoke_tool(session.id, "run_command")
    assert app_state.permissions.tool_grant(session.id, "run_command") is None
    assert app_state.repo.get_tool_grants(session.id) == []


def test_tool_grant_schema_accepts_once_and_note():
    grant = ToolGrant(tool="run_command", granted=True, once=True, note="from prompt")

    assert grant.once is True
    assert grant.note == "from prompt"
