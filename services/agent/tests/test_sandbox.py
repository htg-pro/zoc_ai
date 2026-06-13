"""Sandbox: command classification, path resolution, timeout, output cap."""

from __future__ import annotations

import asyncio
import json
from typing import Any
from uuid import uuid4

import pytest
from llama_studio_agent.tools.base import Tool, ToolContext
from llama_studio_agent.tools.sandbox import (
    CommandRisk,
    SandboxLimits,
    classify_command,
    resolve_path,
    truncate_data,
)
from pydantic import BaseModel

# ── classify_command ──────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "cmd,argv,expected",
    [
        ("rm", ["-rf", "/tmp/x"], CommandRisk.destructive),
        ("/usr/bin/rm", ["x"], CommandRisk.destructive),
        ("./rm", [], CommandRisk.destructive),
        ("rmdir", ["x"], CommandRisk.destructive),
        ("sudo", ["ls"], CommandRisk.destructive),
        ("doas", ["ls"], CommandRisk.destructive),
        ("dd", ["if=/dev/zero", "of=/dev/sda"], CommandRisk.destructive),
        ("mkfs.ext4", ["/dev/sda1"], CommandRisk.destructive),
        ("chmod", ["-R", "777", "/"], CommandRisk.destructive),
        ("chown", ["--recursive", "x:x", "/etc"], CommandRisk.destructive),
        ("shutdown", ["-h", "now"], CommandRisk.destructive),
        # bash -c with destructive payload
        ("/bin/sh", ["-c", "rm -rf /tmp/junk"], CommandRisk.destructive),
        ("bash", ["-c", "echo hi && reboot"], CommandRisk.destructive),
        # the fork bomb
        ("sh", ["-c", ":(){ :|:& };:"], CommandRisk.destructive),
        # safe cases
        ("ls", ["-la"], CommandRisk.safe),
        ("python", ["-V"], CommandRisk.safe),
        ("npm", ["test"], CommandRisk.safe),
        ("chmod", ["+x", "build.sh"], CommandRisk.safe),
        ("/bin/sh", ["-c", "echo hello"], CommandRisk.safe),
        # rmtree-flavoured app names that aren't actually rm
        ("trash-put", ["foo"], CommandRisk.safe),
    ],
)
def test_classify_command(cmd: str, argv: list[str], expected: CommandRisk) -> None:
    assert classify_command(cmd, argv) is expected


# ── resolve_path ──────────────────────────────────────────────────────────


def test_resolve_path_inside_workspace(tmp_path: Any) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "x.py").write_text("x = 1\n")
    p = resolve_path(str(tmp_path), "src/x.py")
    assert p == (tmp_path / "src" / "x.py").resolve()


def test_resolve_path_rejects_escape(tmp_path: Any) -> None:
    from llama_studio_agent.tools.base import ToolExecutionError

    with pytest.raises(ToolExecutionError, match="escapes workspace"):
        resolve_path(str(tmp_path), "../../../etc/passwd")


def test_resolve_path_rejects_absolute_outside(tmp_path: Any) -> None:
    from llama_studio_agent.tools.base import ToolExecutionError

    with pytest.raises(ToolExecutionError, match="escapes workspace"):
        resolve_path(str(tmp_path), "/etc/passwd")


# ── truncate_data ─────────────────────────────────────────────────────────


def test_truncate_data_passthrough_when_small() -> None:
    payload = {"hello": "world"}
    out, truncated, n = truncate_data(payload, max_bytes=1000)
    assert out is payload
    assert not truncated
    assert n == len(json.dumps(payload).encode("utf-8"))


def test_truncate_data_caps_large_output() -> None:
    payload = {"chunks": ["x" * 100] * 1000}  # well over a few KiB
    out, truncated, original = truncate_data(payload, max_bytes=2_000)
    assert truncated
    assert original > 2_000
    assert isinstance(out, dict)
    assert out["truncated"] is True
    assert out["original_bytes"] == original
    assert out["max_output_bytes"] == 2_000
    assert isinstance(out["preview"], str)


# ── Sandbox.execute via a tool ────────────────────────────────────────────


class _SlowInput(BaseModel):
    pass


class _SlowTool(Tool[_SlowInput, dict[str, Any]]):
    """Tool that sleeps longer than the sandbox timeout to exercise the
    timeout path without actually blocking the test for that long."""

    name = "slow_tool"
    description = "test only"
    Input = _SlowInput
    requires_scopes = ()
    sandbox_limits = SandboxLimits(timeout_s=0.05, max_output_bytes=1024)

    async def run(self, ctx: ToolContext, args: _SlowInput) -> dict[str, Any]:
        await asyncio.sleep(1.0)
        return {"never": "returned"}


class _BigInput(BaseModel):
    pass


class _BigTool(Tool[_BigInput, list[str]]):
    name = "big_tool"
    description = "test only"
    Input = _BigInput
    requires_scopes = ()
    sandbox_limits = SandboxLimits(timeout_s=5.0, max_output_bytes=200)

    async def run(self, ctx: ToolContext, args: _BigInput) -> list[str]:
        return ["x" * 100] * 50  # ~5 KiB serialised


def _ctx() -> ToolContext:
    return ToolContext(
        session_id=uuid4(),
        workspace_root="/tmp",
        permissions=None,
        indexer=None,
    )


@pytest.mark.asyncio
async def test_sandbox_enforces_timeout() -> None:
    res = await _SlowTool().execute(_ctx(), {})
    assert not res.ok
    assert "timeout" in (res.error or "")


@pytest.mark.asyncio
async def test_sandbox_caps_output() -> None:
    res = await _BigTool().execute(_ctx(), {})
    assert res.ok
    assert isinstance(res.data, dict)
    assert res.data["truncated"] is True
    assert res.data["original_bytes"] > 200
