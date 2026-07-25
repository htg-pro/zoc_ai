"""Bundled stdio MCP servers for the Zoc AI gateway (Part 4, §4.2).

This package ships three standalone Model Context Protocol servers — web search,
documentation retrieval, and workspace-confined git history — each a
self-contained stdio program built on the reusable scaffold in
:mod:`mcp_servers._mcp`. The servers are net-new: they do not modify, replace, or
depend on the fixed ``MCPGateway`` surface in
:mod:`zocai_gateway.context.mcp_gateway`.
"""

from __future__ import annotations
