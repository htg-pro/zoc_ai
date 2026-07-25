"""Generic, configuration-driven MCP host (Part 4, §4.1).

A second, generic Model Context Protocol surface that coexists with the fixed
``MCPGateway`` tools (``mcp::web::search`` / ``mcp::github``) without modifying
them. See :mod:`.host` for the lifecycle/aggregation/proxy entry point.
"""

from __future__ import annotations
