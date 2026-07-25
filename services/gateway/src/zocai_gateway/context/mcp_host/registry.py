"""Aggregated MCP tool registry with injective namespacing (Part 4, R4, R5).

``Namespaced_Tool_Name = "mcp::" + esc(server_id) + "::" + esc(bare_name)`` where
``esc`` escapes ``\\`` → ``\\\\`` and ``:`` → ``\\:``. Because ``esc`` is
reversible, distinct ``(server_id, bare_name)`` pairs always map to distinct
names — collision-freedom by construction, even when two servers expose the
same bare name (R4.1, R4.2).

Each server's tool subset is swapped/dropped atomically so a discovery or crash
touches only that one server (R4.4, R4.7, R8.2).
"""

from __future__ import annotations

from .models import McpToolRecord, RawTool

__all__ = ["McpToolRegistry", "escape_segment", "namespaced_name", "record_for"]


def escape_segment(segment: str) -> str:
    """Reversibly escape a namespace segment (``\\`` first, then ``:``)."""
    return segment.replace("\\", "\\\\").replace(":", "\\:")


def namespaced_name(server_id: str, bare_name: str) -> str:
    """Build the injective ``mcp::<id>::<bare>`` name for a tool (R4.1)."""
    return f"mcp::{escape_segment(server_id)}::{escape_segment(bare_name)}"


def record_for(server_id: str, tool: RawTool) -> McpToolRecord:
    """Build an aggregated record, preserving the server id, bare name, schema,
    and description exactly (R4.3)."""
    return McpToolRecord(
        server_id=server_id,
        bare_name=tool.name,
        namespaced_name=namespaced_name(server_id, tool.name),
        input_schema=tool.input_schema,
        description=tool.description,
    )


class McpToolRegistry:
    """The single live view of aggregated tools, keyed by owning server."""

    def __init__(self) -> None:
        # server_id -> { namespaced_name -> record }
        self._by_server: dict[str, dict[str, McpToolRecord]] = {}

    def replace_server_tools(self, server_id: str, tools: list[McpToolRecord]) -> None:
        """Atomically swap ``server_id``'s entire subset (R4.4). An empty list
        clears the subset (R4.6)."""
        self._by_server[server_id] = {record.namespaced_name: record for record in tools}

    def remove_server_tools(self, server_id: str) -> None:
        """Atomically drop ``server_id``'s subset (R4.7, R8.2). No-op if absent."""
        self._by_server.pop(server_id, None)

    def get(self, name: str) -> McpToolRecord | None:
        """Resolve a Namespaced_Tool_Name to its record, or ``None``."""
        for subset in self._by_server.values():
            record = subset.get(name)
            if record is not None:
                return record
        return None

    def list(self) -> list[McpToolRecord]:
        """All aggregated records (namespaced name + schema + description)."""
        out: list[McpToolRecord] = []
        for subset in self._by_server.values():
            out.extend(subset.values())
        return out
