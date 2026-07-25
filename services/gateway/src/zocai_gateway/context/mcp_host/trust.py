"""MCP Trust_Gate: auto-approve decision + approval-prompt builder (Part 4, R7).

Auto-approval is decided purely by exact, case-sensitive, whole-string
membership of the bare tool name in the owning server's ``auto_approve`` list —
the Python twin of ``isToolAutoApproved`` in ``mcp-config.ts``. An absent or
empty list matches nothing, and a ``trusted`` field (if any) is ignored
(R7.1-R7.3, R7.10, R7.11).
"""

from __future__ import annotations

from collections.abc import Mapping

from .models import ServerDefinition

__all__ = ["build_approval_prompt", "is_auto_approved"]


def is_auto_approved(definition: ServerDefinition, bare_name: str) -> bool:
    """True iff ``bare_name`` is an exact member of ``definition.auto_approve``."""
    return bare_name in definition.auto_approve


def build_approval_prompt(
    definition: ServerDefinition, namespaced_name: str, arguments: Mapping[str, object]
) -> str:
    """A prompt identifying the owning server id, the Namespaced_Tool_Name, and
    the requested arguments (R7.4)."""
    return (
        f"MCP server '{definition.id}' requests to run tool '{namespaced_name}' "
        f"with arguments {dict(arguments)!r}. Approve this call?"
    )
