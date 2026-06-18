"""Gateway launch entrypoint with the Tauri readiness handshake.

This is the bundled sidecar entrypoint (``scripts/bundle_sidecar.py`` points
PyInstaller's ``ENTRY`` at this module). It mirrors the legacy
``scripts/launch.py`` contract the Tauri supervisor (``apps/desktop/src/sidecar.rs``)
depends on, so the Rust supervisor and the frontend readiness logic need **no**
behavioral change (R10.2/R10.3):

1. Load :class:`~zocai_gateway.settings.GatewaySettings` from the environment
   (host, port, optional auth token) (R12.1).
2. Enforce the R12 bind policy — refuse to start a non-loopback bind without an
   authentication credential (R12.2).
3. Bind the configured loopback-or-other interface, letting the OS assign a
   free port when ``port == 0``.
4. Print ``ZOC_STUDIO_AGENT_PORT=<port>`` to stdout and flush, so the supervisor
   can capture the actual listening port (R10.3). The supervisor then polls the
   Gateway's existing ``/health`` endpoint, which is preserved by using
   :func:`~zocai_gateway.app.create_app` unchanged.
5. Hand the *already-bound* socket to uvicorn so the port we announced is the
   exact port the server listens on — there is no bind-twice race window.

The workspace root the in-process memory matrix / diary workers run against is
resolved from the optional :data:`WORKSPACE_ENV_VAR` environment variable; when
unset, ``create_app`` runs without a workspace-backed matrix (its documented
``workspace_root=None`` behavior). ``GatewaySettings`` intentionally does not
carry the workspace root, so it is resolved here.
"""

from __future__ import annotations

import os
import socket
import sys
from collections.abc import Mapping
from pathlib import Path

import uvicorn

from zocai_gateway.app import create_app
from zocai_gateway.settings import GatewaySettings

__all__ = [
    "READY_PREFIX",
    "WORKSPACE_ENV_VAR",
    "bind_loopback_or_configured",
    "main",
    "resolve_workspace_root",
]

#: Stdout prefix the Tauri supervisor matches to capture the sidecar port. Must
#: stay byte-for-byte identical to ``READY_PREFIX`` in ``sidecar.rs`` (R10.3).
READY_PREFIX = "ZOC_STUDIO_AGENT_PORT="

#: Optional environment variable naming the workspace the Gateway's memory
#: matrix / diary workers run against. Unset ⇒ ``create_app(workspace_root=None)``.
WORKSPACE_ENV_VAR = "ZOC_STUDIO_WORKSPACE"

HELP_TEXT = """zoc-studio-agent (Zoc AI Gateway sidecar)

Start the Gateway FastAPI sidecar on a loopback (or configured) port and print
ZOC_STUDIO_AGENT_PORT=<port> on stdout for the Tauri desktop shell to capture,
then serve until terminated.

Configuration is read from environment variables:
  ZOC_STUDIO_GATEWAY_HOST   bind interface (default 127.0.0.1)
  ZOC_STUDIO_GATEWAY_PORT   bind port (default 0 = OS-assigned free port)
  ZOC_STUDIO_GATEWAY_TOKEN  shared-secret credential (required for non-loopback)
  ZOC_STUDIO_WORKSPACE      optional workspace root for the memory matrix
"""


def resolve_workspace_root(env: Mapping[str, str] | None = None) -> Path | None:
    """Resolve the optional workspace root from :data:`WORKSPACE_ENV_VAR`.

    Returns ``None`` when the variable is unset or empty, which selects
    ``create_app``'s no-workspace behavior.
    """
    source = os.environ if env is None else env
    raw = source.get(WORKSPACE_ENV_VAR)
    return Path(raw) if raw else None


def bind_loopback_or_configured(settings: GatewaySettings) -> socket.socket:
    """Bind a TCP socket to the configured host/port and return it.

    When ``settings.port == 0`` the OS assigns a free port, which the caller
    reads back via ``socket.getsockname()`` *before* announcing it — so the
    handshake reports the real listening port (R10.3). The socket is bound but
    not yet listening; uvicorn takes ownership and starts listening on it,
    avoiding any close/re-bind race window.
    """
    family = socket.AF_INET6 if ":" in settings.host else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((settings.host, settings.port))
    return sock


def main() -> int:
    """Launch the Gateway sidecar; return a process exit code.

    ``--help``/``-h`` prints usage and exits without binding so the PyInstaller
    bundle smoke test (``zoc-studio-agent --help``) stays fast and side-effect
    free.
    """
    if any(arg in {"-h", "--help"} for arg in sys.argv[1:]):
        print(HELP_TEXT, end="")
        return 0

    settings = GatewaySettings.from_env()  # host, port, auth token (R12.1)
    settings.enforce_bind_policy()  # refuse non-loopback w/o auth (R12.2)

    workspace_root = resolve_workspace_root()
    sock = bind_loopback_or_configured(settings)  # OS-assigned port if 0
    port = int(sock.getsockname()[1])

    # Announce the *actual* listening port to the parent (Tauri) process before
    # serving, so the supervisor's handshake + /health poll loop work unchanged
    # (R10.3). Flush because stdout is block-buffered when piped.
    print(f"{READY_PREFIX}{port}", flush=True)

    app = create_app(settings=settings, workspace_root=workspace_root)
    config = uvicorn.Config(app, host=settings.host, port=port, log_level="info")
    server = uvicorn.Server(config)
    # Hand uvicorn the already-bound socket so it listens on exactly the port we
    # announced (no second bind, no race).
    server.run(sockets=[sock])
    return 0


if __name__ == "__main__":
    sys.exit(main())
