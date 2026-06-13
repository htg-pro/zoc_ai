"""`index_query` tool — semantic + lexical lookup over the workspace index."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field
from shared_schema.models import PermissionScope

from .base import Tool, ToolContext, ToolExecutionError
from .sandbox import SandboxLimits


class IndexQueryInput(BaseModel):
    query: str = Field(description="Natural-language or code query.")
    top_k: int = Field(default=8, ge=1, le=64)


class IndexQueryTool(Tool[IndexQueryInput, list[dict[str, Any]]]):
    name = "index_query"
    description = "Retrieve the top-k most relevant chunks from the repo index."
    Input = IndexQueryInput
    requires_scopes = (PermissionScope.read_fs,)
    sandbox_limits = SandboxLimits.INDEX_QUERY

    async def run(self, ctx: ToolContext, args: IndexQueryInput) -> list[dict[str, Any]]:
        if ctx.indexer is None:
            raise ToolExecutionError("indexer not available on this session")
        hits = await ctx.indexer.query(args.query, top_k=args.top_k)
        return [h.model_dump(mode="json") for h in hits]
