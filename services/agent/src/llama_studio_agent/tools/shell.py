"""Shell execution tool — wraps the Rust PTY hot path."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field
from shared_schema.models import PermissionScope

from .. import hotpath
from .base import Tool, ToolContext, ToolExecutionError
from .sandbox import CommandRisk, SandboxLimits, classify_command, resolve_path


class RunCommandInput(BaseModel):
    cmd: str = Field(description="Executable name (e.g. /bin/sh, python, npm).")
    args: list[str] = Field(default_factory=list)
    cwd: str | None = None
    timeout_ms: int = Field(default=30_000, ge=100, le=10 * 60_000)


class RunCommandTool(Tool[RunCommandInput, dict[str, Any]]):
    name = "run_command"
    description = "Run a command in a PTY and return its combined output + exit code."
    Input = RunCommandInput
    requires_scopes = (PermissionScope.run_command,)
    destructive = True
    requires_approval = False
    # The user-supplied ``timeout_ms`` bounds the inner work; the sandbox
    # leaves the outer timeout off and enforces the output cap (8 MiB) so
    # noisy build logs don't get pushed back into the LLM context wholesale.
    sandbox_limits = SandboxLimits.RUN_COMMAND

    async def run(self, ctx: ToolContext, args: RunCommandInput) -> dict[str, Any]:
        if classify_command(args.cmd, args.args) is CommandRisk.destructive:
            raise ToolExecutionError(
                "destructive command refused without approval; use the permission flow"
            )
        cwd = (
            str(resolve_path(ctx.workspace_root, args.cwd))
            if args.cwd
            else str(resolve_path(ctx.workspace_root, "."))
        )
        result = hotpath.pty_run(
            args.cmd,
            args.args,
            cwd=cwd,
            timeout_ms=args.timeout_ms,
        )
        if result.get("exit_code") not in (0, None):
            output = str(result.get("stdout") or result.get("stderr") or result.get("error") or "")
            preview = output[-4000:] if len(output) > 4000 else output
            raise ToolExecutionError(
                f"command exited with code {result.get('exit_code')}"
                + (f"\n{preview}" if preview else "")
            )
        return result
