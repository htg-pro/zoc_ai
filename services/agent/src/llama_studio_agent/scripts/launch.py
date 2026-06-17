"""Launcher for the agent sidecar.

Binds to a free loopback port (or the configured one) and prints a single
line `LLAMA_STUDIO_AGENT_PORT=<n>` on stdout so the Tauri shell can capture
it. After that, hands off to uvicorn for the lifetime of the process.
"""

from __future__ import annotations

import socket
import sys

import structlog
import uvicorn

from llama_studio_agent.app import create_app
from llama_studio_agent.config import get_settings

_log = structlog.get_logger(__name__)


HELP_TEXT = """llama-studio-agent

Start the Zoc AI FastAPI sidecar on a loopback port and print
LLAMA_STUDIO_AGENT_PORT=<port> for the desktop shell.

Configuration is read from LLAMA_STUDIO_* environment variables.
"""


def _pick_free_port(host: str, requested: int) -> int:
    if requested and requested > 0:
        return requested
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return int(sock.getsockname()[1])


def main() -> None:
    if any(arg in {"-h", "--help"} for arg in sys.argv[1:]):
        print(HELP_TEXT, end="")
        return

    cfg = get_settings()
    port = _pick_free_port(cfg.host, cfg.port)

    # Announce the port to the parent (Tauri) process. Must be the *first*
    # line of stdout so the shell sidecar handshake can match cheaply.
    print(f"LLAMA_STUDIO_AGENT_PORT={port}", flush=True)
    _log.info("agent.launch", host=cfg.host, port=port)

    app = create_app(cfg)
    uvicorn.run(
        app,
        host=cfg.host,
        port=port,
        log_level="info" if not cfg.debug else "debug",
        access_log=cfg.debug,
    )


if __name__ == "__main__":
    sys.exit(main())
