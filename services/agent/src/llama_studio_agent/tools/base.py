"""Base tool abstractions."""

from __future__ import annotations

import abc
from dataclasses import dataclass
from typing import Any, Generic, TypeVar
from uuid import UUID

from pydantic import BaseModel
from shared_schema.models import PermissionScope, ToolDescriptor, ToolResult

from ..permissions import PermissionDenied

I = TypeVar("I", bound=BaseModel)
O = TypeVar("O")


class ToolExecutionError(RuntimeError):
    """Raised inside a tool to indicate a structured failure result."""


@dataclass(slots=True)
class ToolContext:
    session_id: UUID
    workspace_root: str
    active_file: str | None = None
    open_files: list[dict[str, Any]] | None = None
    selected_text: str | None = None
    editor_content: str | None = None
    # Lazy attributes wired in by the orchestrator at execution time.
    permissions: Any = None  # PermissionManager — typed loosely to avoid cycles
    indexer: Any = None  # IndexerService


class Tool(abc.ABC, Generic[I, O]):
    name: str = ""
    description: str = ""
    requires_scopes: tuple[PermissionScope, ...] = ()
    destructive: bool = False
    requires_approval: bool = False

    Input: type[BaseModel]
    # Per-tool overrides for the sandbox's timeout / output cap. Default is
    # the conservative class default (30 s, 1 MiB). Tools that need wider
    # ceilings (run_command) or tighter ones (read_file) override this.
    sandbox_limits: Any = None  # SandboxLimits | None — typed loosely to avoid cycles

    def descriptor(self) -> ToolDescriptor:
        return ToolDescriptor(
            name=self.name,
            description=self.description,
            json_schema=self.Input.model_json_schema(),
            destructive=self.destructive,
            requires_approval=self.requires_approval,
            requires_scopes=list(self.requires_scopes),
        )

    def _check_permissions(self, ctx: ToolContext) -> None:
        if not self.requires_scopes or ctx.permissions is None:
            return
        # A per-tool grant ("allow once" / "allow this tool") authorises this
        # specific tool without requiring the coarser scope to be granted.
        if self.name and ctx.permissions.allow_tool(ctx.session_id, self.name):
            return
        for scope in self.requires_scopes:
            ctx.permissions.require(ctx.session_id, scope)

    def permission_error(self, ctx: ToolContext) -> PermissionDenied | None:
        """Non-consuming probe of whether this call would be denied.

        Returns the :class:`PermissionDenied` that :meth:`execute` would
        raise, or ``None`` if the call is currently authorised. Unlike
        ``_check_permissions`` this never consumes an "allow once" grant, so
        the orchestrator can decide whether to pause for approval without
        burning the one-shot grant before the call actually runs.
        """

        if not self.requires_scopes or ctx.permissions is None:
            return None
        if self.name and ctx.permissions.allow_tool(
            ctx.session_id, self.name, consume=False
        ):
            return None
        for scope in self.requires_scopes:
            if not ctx.permissions.has(ctx.session_id, scope):
                return PermissionDenied(f"missing permission: {scope.value}")
        return None

    async def execute(self, ctx: ToolContext, raw_args: dict[str, Any]) -> ToolResult:
        # All tools share a single execution chokepoint that adds timeouts,
        # output caps, and uniform error shaping. See ``tools.sandbox``.
        from .sandbox import Sandbox

        return await Sandbox.execute(self, ctx, raw_args)

    @abc.abstractmethod
    async def run(self, ctx: ToolContext, args: Any) -> Any:
        ...
