"""AST query tool.

A genuine tree-sitter integration is a future enhancement; until then we
provide a regex-driven symbol extractor with results shaped to look like
AST hits so callers can rely on the schema. Backed by `hotpath chunk`,
which already extracts top-level symbols per chunk.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field
from shared_schema.models import PermissionScope

from .. import hotpath
from .base import Tool, ToolContext, ToolExecutionError
from .sandbox import SandboxLimits, resolve_path


class AstQueryInput(BaseModel):
    path: str = Field(description="File (or directory) to scan.")
    symbol: str | None = Field(
        default=None,
        description="Optional symbol name to filter on (substring match).",
    )


class AstQueryTool(Tool[AstQueryInput, list[dict[str, Any]]]):
    name = "ast_query"
    description = "List top-level symbols (functions/classes) under a path."
    Input = AstQueryInput
    requires_scopes = (PermissionScope.read_fs,)
    sandbox_limits = SandboxLimits.AST

    async def run(self, ctx: ToolContext, args: AstQueryInput) -> list[dict[str, Any]]:
        root = Path(ctx.workspace_root).resolve()
        target = resolve_path(ctx.workspace_root, args.path)
        files: list[Path]
        if target.is_file():
            files = [target]
        elif target.is_dir():
            files = [p for p in target.rglob("*") if p.is_file()]
        else:
            raise ToolExecutionError(f"not found: {args.path}")
        out: list[dict[str, Any]] = []
        for f in files[:500]:
            try:
                chunks = hotpath.chunk_file(str(f))
            except Exception:
                continue
            for c in chunks:
                sym = c.get("symbol")
                if not sym:
                    continue
                if args.symbol and args.symbol.lower() not in sym.lower():
                    continue
                out.append(
                    {
                        "file": str(f.relative_to(root)),
                        "symbol": sym,
                        "start_line": c.get("start_line"),
                        "end_line": c.get("end_line"),
                    }
                )
        return out
