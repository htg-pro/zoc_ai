"""Workspace text search — backed by the Rust hot-path CLI."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field
from shared_schema.models import PermissionScope

from .. import hotpath
from .base import Tool, ToolContext
from .sandbox import SandboxLimits, resolve_path


class SearchInput(BaseModel):
    pattern: str = Field(description="Regex pattern.")
    path: str = Field(default=".", description="Subdirectory (relative to workspace root).")
    ignore_case: bool = False
    max_results: int = Field(default=200, ge=1, le=5000)


class SearchTool(Tool[SearchInput, list[dict[str, Any]]]):
    name = "search"
    description = "Ripgrep-style regex search across the workspace, honoring .gitignore."
    Input = SearchInput
    requires_scopes = (PermissionScope.read_fs,)
    sandbox_limits = SandboxLimits.SEARCH

    async def run(self, ctx: ToolContext, args: SearchInput) -> list[dict[str, Any]]:
        target = resolve_path(ctx.workspace_root, args.path)
        return hotpath.search(
            str(target),
            args.pattern,
            ignore_case=args.ignore_case,
            max_results=args.max_results,
        )
