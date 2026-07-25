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
4. Start uvicorn on the pre-bound socket, then print
   ``ZOC_STUDIO_AGENT_PORT=<port>`` to stdout and flush once the server reports
   startup complete. The supervisor captures that actual listening port (R10.3)
   and polls the Gateway's existing ``/health`` endpoint, which is preserved by
   using :func:`~zocai_gateway.app.create_app` unchanged.
5. Hand the *already-bound* socket to uvicorn so the port we announced is the
   exact port the server listens on — there is no bind-twice race window.

The workspace root the in-process memory matrix / diary workers run against is
resolved from the optional :data:`WORKSPACE_ENV_VAR` environment variable; when
unset, ``create_app`` runs without a workspace-backed matrix (its documented
``workspace_root=None`` behavior). ``GatewaySettings`` intentionally does not
carry the workspace root, so it is resolved here.
"""

from __future__ import annotations

import asyncio
import importlib
import os
import socket
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path

import uvicorn

from zocai_gateway.settings import GatewaySettings

__all__ = [
    "LAZY_INDEX_FLAG",
    "READY_PREFIX",
    "WORKSPACE_ENV_VAR",
    "bind_loopback_or_configured",
    "main",
    "resolve_lazy_index",
    "resolve_user_mcp_config_path",
    "resolve_workspace_root",
    "run_bundled_mcp_server",
]

#: Stdout prefix the Tauri supervisor matches to capture the sidecar port. Must
#: stay byte-for-byte identical to ``READY_PREFIX`` in ``sidecar.rs`` (R10.3).
READY_PREFIX = "ZOC_STUDIO_AGENT_PORT="

#: Optional environment variable naming the workspace the Gateway's memory
#: matrix / diary workers run against. Unset ⇒ ``create_app(workspace_root=None)``.
WORKSPACE_ENV_VAR = "ZOC_STUDIO_WORKSPACE"
USER_MCP_CONFIG_ENV_VAR = "ZOC_STUDIO_MCP_USER_CONFIG"
MCP_SERVER_FLAG = "--mcp-server"
LAZY_INDEX_FLAG = "--lazy-index"
LAZY_INDEX_ENV_VAR = "ZOC_STUDIO_LAZY_INDEX"
_BUNDLED_MCP_SERVERS = frozenset({"web_search", "docs", "git_history"})

HELP_TEXT = """zoc-studio-agent (Zoc AI Gateway sidecar)

Start the Gateway FastAPI sidecar on a loopback (or configured) port and print
ZOC_STUDIO_AGENT_PORT=<port> on stdout for the Tauri desktop shell to capture,
then serve until terminated.

Options:
  --lazy-index              skip the startup workspace index; index files only
                            when the agent first accesses them (large monorepos)

Configuration is read from environment variables:
  ZOC_STUDIO_GATEWAY_HOST   bind interface (default 127.0.0.1)
  ZOC_STUDIO_GATEWAY_PORT   bind port (default 0 = OS-assigned free port)
  ZOC_STUDIO_GATEWAY_TOKEN  shared-secret credential (required for non-loopback)
  ZOC_STUDIO_WORKSPACE      optional workspace root for the memory matrix
  ZOC_STUDIO_LAZY_INDEX     set to 1/true to imply --lazy-index
  ZOC_STUDIO_MCP_USER_CONFIG optional user-scoped mcp.json (default ~/.zoc/mcp.json)
"""

#: Environment values treated as "on" for boolean flags.
_TRUTHY = frozenset({"1", "true", "yes", "on"})


def resolve_lazy_index(
    args: Sequence[str] | None = None, env: Mapping[str, str] | None = None
) -> bool:
    """Whether the workspace index should be built lazily (§9.1).

    True when ``--lazy-index`` is passed **or**
    :data:`LAZY_INDEX_ENV_VAR` is set to a truthy value, so the desktop shell
    can enable it without changing its argv.
    """
    argv = sys.argv[1:] if args is None else list(args)
    source = os.environ if env is None else env
    if LAZY_INDEX_FLAG in argv:
        return True
    return (source.get(LAZY_INDEX_ENV_VAR) or "").strip().lower() in _TRUTHY


def resolve_workspace_root(env: Mapping[str, str] | None = None) -> Path | None:
    """Resolve the optional workspace root from :data:`WORKSPACE_ENV_VAR`.

    Returns ``None`` when the variable is unset or empty, which selects
    ``create_app``'s no-workspace behavior.
    """
    source = os.environ if env is None else env
    raw = source.get(WORKSPACE_ENV_VAR)
    return Path(raw) if raw else None


def resolve_user_mcp_config_path(env: Mapping[str, str] | None = None) -> Path:
    """Return the user-scoped MCP document consumed by the runtime host."""
    source = os.environ if env is None else env
    override = source.get(USER_MCP_CONFIG_ENV_VAR)
    return Path(override).expanduser() if override else Path.home() / ".zoc" / "mcp.json"


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


def run_bundled_mcp_server(name: str) -> int:
    """Run one bundled stdio MCP server inside the frozen sidecar executable.

    PyInstaller's ``sys.executable`` is the one-file sidecar, not a general
    Python interpreter, so child definitions use ``--mcp-server <name>`` in a
    frozen build. Only shipped module names are accepted.
    """
    if name not in _BUNDLED_MCP_SERVERS:
        print(f"unknown bundled MCP server: {name}", file=sys.stderr)
        return 2
    module = importlib.import_module(f"mcp_servers.{name}")
    entrypoint = getattr(module, "main", None)
    if not callable(entrypoint):
        print(f"bundled MCP server has no main(): {name}", file=sys.stderr)
        return 2
    entrypoint()
    return 0


def main() -> int:
    """Launch the Gateway sidecar; return a process exit code.

    ``--help``/``-h`` prints usage and exits without binding so the PyInstaller
    bundle smoke test (``zoc-studio-agent --help``) stays fast and side-effect
    free.
    """
    args = sys.argv[1:]
    if args and args[0] == MCP_SERVER_FLAG:
        if len(args) != 2:
            print("usage: zoc-studio-agent --mcp-server <web_search|docs|git_history>", file=sys.stderr)
            return 2
        return run_bundled_mcp_server(args[1])
    if any(arg in {"-h", "--help"} for arg in args):
        print(HELP_TEXT, end="")
        return 0

    settings = GatewaySettings.from_env()  # host, port, auth token (R12.1)
    settings.enforce_bind_policy()  # refuse non-loopback w/o auth (R12.2)

    workspace_root = resolve_workspace_root()
    lazy_index = resolve_lazy_index(args)
    sock = bind_loopback_or_configured(settings)  # OS-assigned port if 0
    port = int(sock.getsockname()[1])

    return asyncio.run(_serve(settings, workspace_root, sock, port, lazy_index))


async def _serve(
    settings: GatewaySettings,
    workspace_root: Path | None,
    sock: socket.socket,
    port: int,
    lazy_index: bool = False,
) -> int:
    from zocai_gateway.app import create_app

    app = create_app(
        settings=settings,
        workspace_root=workspace_root,
        start_mcp=True,
        lazy_index=lazy_index,
        mcp_user_config_path=resolve_user_mcp_config_path(),
    )
    config = uvicorn.Config(app, host=settings.host, port=port, log_level="info")
    server = uvicorn.Server(config)
    serve_task = asyncio.create_task(server.serve(sockets=[sock]))

    # Announce readiness only after uvicorn has completed startup and begun
    # serving the socket. This keeps the Tauri supervisor from publishing a
    # loopback port that still fails `/health`.
    while not server.started:
        if serve_task.done():
            await serve_task
            return 1
        await asyncio.sleep(0.025)

    print(f"{READY_PREFIX}{port}", flush=True)
    await serve_task
    return 0


if __name__ == "__main__":
    sys.exit(main())
