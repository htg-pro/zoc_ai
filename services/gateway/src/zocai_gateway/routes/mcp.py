"""Admitted MCP control surface: ``/v1/mcp/{servers,reload,test}`` (Part 4, R10, R11, R13).

An ``APIRouter`` with ``dependencies=[Depends(require_admission)]`` on the router
so **every** ``/v1/mcp/*`` route is admitted before its handler runs and a
rejected request performs no side effect (R10.1-R10.3). It is included on the
existing gateway listener in :func:`zocai_gateway.app.create_app` — no new
interface (R10.5).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

from fastapi import APIRouter, Body, Depends, HTTPException, status

from zocai_gateway.auth import require_admission
from zocai_gateway.context.mcp_host.models import (
    TestFailure,
    TestSuccess,
    TestUnsupported,
    TestValidationFailure,
)
from zocai_gateway.errors import ErrorCode, error_body

if TYPE_CHECKING:  # avoid importing the heavy host module at import time
    from zocai_gateway.context.mcp_host.host import MCPHost

__all__ = ["McpHostResolver", "create_mcp_router", "serialize_test_outcome"]

#: Resolves the MCP host of the *current* workspace scope, or ``None`` when no
#: workspace is open. Async because resolving the scope may build/rebind it.
McpHostResolver = Callable[[], "Awaitable[MCPHost | None]"]


def serialize_test_outcome(outcome: object) -> dict[str, object]:
    """Project a :data:`TestOutcome` onto a stable JSON shape for the frontend."""
    if isinstance(outcome, TestSuccess):
        return {
            "outcome": "success",
            "toolCount": outcome.tool_count,
            "bareNames": list(outcome.bare_names),
        }
    if isinstance(outcome, TestValidationFailure):
        return {"outcome": "validation-failure", "reason": outcome.reason}
    if isinstance(outcome, TestUnsupported):
        return {"outcome": "unsupported", "transport": outcome.transport}
    if isinstance(outcome, TestFailure):
        return {"outcome": "failure", "reason": outcome.reason}
    return {"outcome": "failure", "reason": "unknown outcome"}


def create_mcp_router(resolve_host: McpHostResolver) -> APIRouter:
    """Build the admitted MCP control router bound to a current-scope resolver.

    ``resolve_host`` returns the MCP host of the workspace open right now (D3),
    so a workspace rebind is reflected without a restart, or ``None`` when no
    workspace is open. With no workspace there is no legitimate root to pin MCP
    server subprocesses to, so ``/servers`` answers with an honest empty list
    and the mutating ``/reload`` and ``/test`` routes return a typed
    ``no_workspace`` 409 — never a ``/nonexistent`` sentinel host.
    """
    router = APIRouter(prefix="/v1/mcp", dependencies=[Depends(require_admission)])

    @router.get("/servers")
    async def list_servers() -> dict[str, object]:
        """Runtime state for every configured server (R13.1, R13.2)."""
        host = await resolve_host()
        if host is None:
            return {"servers": []}
        return {"servers": host.servers()}

    @router.post("/reload")
    async def reload_servers() -> dict[str, object]:
        """Recompute MCP_Config and apply lifecycle diffs (R1.11-R1.14)."""
        host = await resolve_host()
        if host is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=error_body(ErrorCode.NO_WORKSPACE),
            )
        return {"servers": await host.reload()}

    @router.post("/test")
    async def test_server(candidate: dict[str, object] = Body(...)) -> dict[str, object]:
        """Test one candidate definition in full isolation (R11)."""
        host = await resolve_host()
        if host is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=error_body(ErrorCode.NO_WORKSPACE),
            )
        return serialize_test_outcome(await host.test_candidate(candidate))

    return router
