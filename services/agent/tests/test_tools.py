
import pytest
from llama_studio_agent import hotpath
from llama_studio_agent.tools.base import ToolContext
from llama_studio_agent.tools.filesystem import (
    ApplyPatchTool,
    ListDirTool,
    ReadFileTool,
    WriteFileTool,
)
from llama_studio_agent.tools.shell import RunCommandTool
from shared_schema.models import PermissionScope


def _ctx(session, app_state):
    return ToolContext(
        session_id=session.id,
        workspace_root=session.workspace_root,
        permissions=app_state.permissions,
        indexer=None,
    )


@pytest.mark.asyncio
async def test_read_file_basic(session, app_state):
    res = await ReadFileTool().execute(_ctx(session, app_state), {"path": "src/hello.py"})
    assert res.ok
    assert "greet" in res.data["content"]


@pytest.mark.asyncio
async def test_read_file_outside_workspace_fails(session, app_state):
    res = await ReadFileTool().execute(_ctx(session, app_state), {"path": "../../../etc/passwd"})
    assert not res.ok
    assert "escapes workspace" in (res.error or "")


@pytest.mark.asyncio
async def test_write_file_creates_and_overwrites(session, app_state, tmp_workspace):
    ctx = _ctx(session, app_state)
    res = await WriteFileTool().execute(ctx, {"path": "src/new.py", "content": "x = 1\n"})
    assert res.ok
    assert (tmp_workspace / "src" / "new.py").read_text() == "x = 1\n"

    res2 = await WriteFileTool().execute(ctx, {"path": "src/new.py", "content": "x = 2\n"})
    assert res2.ok
    assert "x = 2" in (tmp_workspace / "src" / "new.py").read_text()


@pytest.mark.asyncio
async def test_list_dir(session, app_state):
    res = await ListDirTool().execute(_ctx(session, app_state), {"path": "src"})
    assert res.ok
    names = [e["name"] for e in res.data]
    assert "hello.py" in names


@pytest.mark.asyncio
async def test_apply_patch_modifies_file(session, app_state, tmp_workspace):
    original = (tmp_workspace / "src" / "hello.py").read_text()
    assert "f'hello, {name}'" in original
    patch = (
        "--- a/src/hello.py\n"
        "+++ b/src/hello.py\n"
        "@@ -1,3 +1,3 @@\n"
        " def greet(name):\n"
        "-    return f'hello, {name}'\n"
        "+    return f'hi, {name}!'\n"
    )
    res = await ApplyPatchTool().execute(_ctx(session, app_state), {"unified_diff": patch})
    assert res.ok, res.error
    assert "hi, {name}!" in (tmp_workspace / "src" / "hello.py").read_text()


@pytest.mark.asyncio
async def test_apply_patch_new_file(session, app_state, tmp_workspace):
    patch = (
        "--- /dev/null\n"
        "+++ b/src/created.py\n"
        "@@ -0,0 +1,1 @@\n"
        "+print('hi')\n"
    )
    res = await ApplyPatchTool().execute(_ctx(session, app_state), {"unified_diff": patch})
    assert res.ok, res.error
    assert (tmp_workspace / "src" / "created.py").read_text().rstrip() == "print('hi')"


@pytest.mark.asyncio
async def test_apply_patch_unmatched_context_fails(session, app_state):
    bad_patch = (
        "--- a/src/hello.py\n"
        "+++ b/src/hello.py\n"
        "@@ -1,3 +1,3 @@\n"
        " def NOPE():\n"
        "-    return 1\n"
        "+    return 2\n"
    )
    res = await ApplyPatchTool().execute(_ctx(session, app_state), {"unified_diff": bad_patch})
    assert not res.ok
    assert "patch failed" in (res.error or "")


@pytest.mark.asyncio
async def test_run_command_nonzero_exit_fails_tool(session, app_state, monkeypatch):
    app_state.permissions.grant(session.id, PermissionScope.run_command)
    monkeypatch.setattr(
        hotpath,
        "pty_run",
        lambda *a, **k: {"exit_code": 1, "stdout": "validation failed\n"},
    )

    res = await RunCommandTool().execute(
        _ctx(session, app_state),
        {"cmd": "npm", "args": ["run", "build"]},
    )

    assert not res.ok
    assert "command exited with code 1" in (res.error or "")
    assert "validation failed" in (res.error or "")
