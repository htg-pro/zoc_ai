"""Pytest configuration for the gateway test suite.

Ensures the ``services/`` directory is importable so the bundled MCP servers in
``services/mcp_servers/`` can be imported as ``mcp_servers`` from the tests.
"""

from __future__ import annotations

import pathlib
import sys

_SERVICES_DIR = str(pathlib.Path(__file__).resolve().parents[2])
if _SERVICES_DIR not in sys.path:
    sys.path.insert(0, _SERVICES_DIR)
