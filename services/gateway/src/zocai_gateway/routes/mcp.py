"""Admitted MCP control surface: ``/v1/mcp/{servers,reload,test}`` (Part 4, R10, R11, R13).

An ``APIRouter`` with ``dependencies=[Depends(require_admission)]`` on the router
so **every** ``/v1/mcp/*`` route is admitted before its handler runs and a
rejected request performs no side effect (R10.1-R10.3). It is included on the
existing gateway listener in :func:`zocai_gateway.app.create_app` — no new
interface (R10.5).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import APIRouter, Body, Depends

from zocai_gateway.auth import require_admission
from zocai_gateway.context.mcp_host.models import (
    TestFailure,
    TestSuccess,
    TestUnsupported,
    TestValidationFailure,
)

if TYPE_CHECKING:  # avoid importing the heavy host module at import time
    from zocai_gateway.context.mcp_host.host import MCPHost

__all__ = ["create_mcp_router", "serialize_test_outcome"]


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


def create_mcp_router(host: MCPHost) -> APIRouter:
    """Build the admitted MCP control router bound to ``host``."""
    router = APIRouter(prefix="/v1/mcp", dependencies=[Depends(require_admission)])

    @router.get("/servers")
    async def list_servers() -> dict[str, object]:
        """Runtime state for every configured server (R13.1, R13.2)."""
        return {"servers": host.servers()}

    @router.post("/reload")
    async def reload_servers() -> dict[str, object]:
        """Recompute MCP_Config and apply lifecycle diffs (R1.11-R1.14)."""
        return {"servers": await host.reload()}

    @router.post("/test")
    async def test_server(candidate: dict[str, object] = Body(...)) -> dict[str, object]:
        """Test one candidate definition in full isolation (R11)."""
        return serialize_test_outcome(await host.test_candidate(candidate))

    return router
