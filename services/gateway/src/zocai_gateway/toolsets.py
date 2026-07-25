"""Mode capability toolsets (Requirements 2.3, 3.5, 8.6, 8.9).

Read-only enforcement in Ask Mode is implemented as a *capability gate*
rather than a runtime permission check: the Ask path is constructed with a
:class:`ReadOnlyToolset` that **physically lacks** write / shell / mkdir
operations, so a mutating call is unconstructable rather than merely
rejected at runtime (design "Mode_Router", R2.3). The Agent path is
constructed with a :class:`FullToolset` that additionally permits writes,
shell execution, and directory creation, all confined to the workspace
(R3.5).

File-system *reads* are available in both modes (R8.6), so they live on the
shared :class:`Toolset` base. Shell execution and mutation live only on
:class:`FullToolset` (R8.9).

Note: this module fixes the capability *shape* for routing (task 4.1). The
conversion of a :class:`ReadOnlyViolation` into an SSE error event and the
switch-to-Agent handling are wired in task 4.2.
"""

from __future__ import annotations

import subprocess
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Protocol
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from zocai_gateway.net_guard import (
    FETCH_TIMEOUT_SECONDS,
    MAX_RESPONSE_BYTES,
    check_command,
    check_url,
    strip_sensitive_headers,
)
from zocai_gateway.security import log_security_event

if TYPE_CHECKING:  # additive MCP seam types (no runtime import cycle)
    from zocai_gateway.context.mcp_host.models import McpToolRecord, ToolCallOutcome

__all__ = [
    "FetchResult",
    "FullToolset",
    "McpCallSeam",
    "ReadOnlyToolset",
    "ReadOnlyViolation",
    "Toolset",
]


@dataclass(frozen=True, slots=True)
class FetchResult:
    """The outcome of a guarded :meth:`FullToolset.fetch_url` call (§15.2)."""

    ok: bool
    status: int = 0
    headers: Mapping[str, str] = field(default_factory=dict)
    body: str = ""
    #: True when the response hit the size cap and was cut short.
    truncated: bool = False
    error: str = ""
    #: True when the host is not allowlisted, so the caller should ask the user.
    needs_approval: bool = False
    url: str = ""


class McpCallSeam(Protocol):
    """The run-bound bridge from :class:`FullToolset` to the generic MCP host.

    Constructed per run in the pipeline with the run's ``(emit, await_decision)``
    channel; ``proxy`` delegates to ``MCPHost.proxy_tool_call`` (R5.5).
    """

    def list_tools(self) -> list[McpToolRecord]: ...

    async def proxy(
        self, namespaced_name: str, arguments: Mapping[str, object]
    ) -> ToolCallOutcome: ...


class ReadOnlyViolation(Exception):
    """Raised when a mutating operation is attempted under a read-only path.

    The :class:`ReadOnlyToolset` does not expose mutating operations at all,
    so this is primarily raised by guards that reject an out-of-workspace
    target or a mutating request that reaches the read-only boundary. The
    Gateway converts it into an error event naming the rejected operation
    type while leaving the workspace untouched (R2.3); that wiring is task
    4.2.
    """

    def __init__(self, operation: str) -> None:
        self.operation = operation
        super().__init__(f"read-only path cannot perform operation: {operation!r}")


class Toolset:
    """Shared capabilities available to every execution path.

    Only non-mutating, file-system *read* operations live here, because they
    are permitted in both Ask Mode and Agent Mode (R8.6). All operations are
    confined to ``workspace_root``; a target resolving outside the workspace
    is rejected.
    """

    def __init__(
        self,
        workspace_root: Path | str = ".",
        *,
        run_id: str = "",
    ) -> None:
        self.workspace_root: Path = Path(workspace_root).resolve()
        self.run_id = run_id

    def _resolve_within_workspace(self, rel_path: Path | str, operation: str) -> Path:
        """Resolve ``rel_path`` and assert it stays inside the workspace.

        Raises :class:`ReadOnlyViolation` naming ``operation`` if the target
        escapes the workspace, so even read targets cannot wander outside the
        confined root.
        """
        candidate = (self.workspace_root / Path(rel_path)).resolve()
        if candidate != self.workspace_root and self.workspace_root not in candidate.parents:
            log_security_event(
                "path_traversal",
                f"blocked {operation} outside the workspace",
                path=str(rel_path),
                operation=operation,
                workspace=str(self.workspace_root),
                run_id=self.run_id or None,
            )
            raise ReadOnlyViolation(operation)
        return candidate

    def read_file(self, rel_path: Path | str) -> str:
        """Read and return the text of a workspace file (R8.6)."""
        target = self._resolve_within_workspace(rel_path, "read_file")
        return target.read_text(encoding="utf-8")


class ReadOnlyToolset(Toolset):
    """Ask-Mode toolset that physically lacks any mutating operation (R2.3).

    It inherits only :meth:`Toolset.read_file`. There is intentionally no
    ``write_file``, ``run_shell``, or ``make_dir`` here: the absence of these
    methods is the read-only guarantee, verified by Property 9 (task 4.4).
    """


class FullToolset(Toolset):
    """Agent-Mode toolset permitting write / shell / mkdir in the workspace.

    Adds mutating and shell capabilities on top of the shared read
    capability (R3.5, R8.9). Every operation is confined to
    ``workspace_root``.
    """

    def __init__(
        self,
        workspace_root: Path | str = ".",
        *,
        mcp: McpCallSeam | None = None,
        network_allowlist: Iterable[str] | None = None,
        run_id: str = "",
    ) -> None:
        super().__init__(workspace_root, run_id=run_id)
        self._mcp = mcp
        # ``None`` means no workspace permission policy was supplied (legacy
        # direct callers). An empty tuple is a real policy that allows no hosts
        # until the user explicitly approves one.
        self._network_allowlist = (
            tuple(network_allowlist) if network_allowlist is not None else None
        )

    def mcp_tools(self) -> list[McpToolRecord]:
        """Aggregated MCP tools exposed to the model, or ``[]`` when no host is
        attached (additive; native tools are unaffected, R5.1, R5.2, R5.4)."""
        return self._mcp.list_tools() if self._mcp is not None else []

    async def call_mcp_tool(
        self, namespaced_name: str, arguments: Mapping[str, object]
    ) -> ToolCallOutcome:
        """Invoke an aggregated MCP tool through the run-bound seam (R5.5).

        Returns a typed :class:`ToolCallError` (``unavailable``) when no MCP host
        is configured, so the call still never raises into the run.
        """
        if self._mcp is None:
            from zocai_gateway.context.mcp_host.models import ToolCallError, ToolCallErrorKind

            return ToolCallError(
                server_id=None,
                tool=namespaced_name,
                kind=ToolCallErrorKind.UNAVAILABLE,
                reason="no MCP host configured",
            )
        return await self._mcp.proxy(namespaced_name, arguments)

    def write_file(self, rel_path: Path | str, content: str) -> None:
        """Write ``content`` to a workspace file (R3.5)."""
        target = self._resolve_within_workspace(rel_path, "write_file")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

    def make_dir(self, rel_path: Path | str) -> None:
        """Create a directory within the workspace (R3.5)."""
        target = self._resolve_within_workspace(rel_path, "make_dir")
        target.mkdir(parents=True, exist_ok=True)

    def delete_file(self, rel_path: Path | str) -> None:
        """Delete a workspace file, confined to the workspace (R8.5, R10.1).

        Resolves ``rel_path`` through :meth:`_resolve_within_workspace`, so an
        out-of-workspace target raises :class:`ReadOnlyViolation` before any
        filesystem effect (R9.5). An in-workspace failure — most commonly the
        target not existing — surfaces the underlying :class:`OSError`
        (e.g. :class:`FileNotFoundError`) unchanged (R9.6).
        """
        target = self._resolve_within_workspace(rel_path, "delete_file")
        target.unlink()

    def move_file(self, src_rel: Path | str, dst_rel: Path | str) -> None:
        """Rename/move a workspace file, confining **both** ends (R8.5, R10.1).

        Both the source and the destination are resolved through
        :meth:`_resolve_within_workspace`, so an out-of-workspace source *or*
        destination raises :class:`ReadOnlyViolation` before any filesystem
        effect (R9.5). Moving a missing source or onto an existing destination
        surfaces the underlying error (:class:`FileNotFoundError` /
        :class:`FileExistsError`) unchanged rather than silently clobbering the
        target (R9.6).
        """
        source = self._resolve_within_workspace(src_rel, "move_file")
        destination = self._resolve_within_workspace(dst_rel, "move_file")
        if destination.exists():
            raise FileExistsError(f"move destination already exists: {destination.name!r}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        source.rename(destination)

    def run_shell(self, argv: list[str]) -> subprocess.CompletedProcess[str]:
        """Run a shell command with the workspace as the working directory.

        Accepts an argument vector (``argv``) rather than a command string so
        the command is executed without a shell, avoiding injection (R3.5,
        R8.9). The process runs with ``cwd`` set to the workspace root.

        §15.2: network clients are refused before the process is spawned. The
        agent must go through :meth:`fetch_url`, which enforces the address-space
        and allowlist rules and is audited; an unaudited ``curl`` would bypass
        both. The refusal is returned as a failed
        :class:`~subprocess.CompletedProcess` rather than raised, so the calling
        tool loop reports it like any other command failure.
        """
        command = " ".join(argv)
        screened = check_command(command, run_id=self.run_id)
        if not screened.allowed:
            return subprocess.CompletedProcess(
                args=argv, returncode=126, stdout="", stderr=screened.reason
            )
        return subprocess.run(
            argv,
            cwd=self.workspace_root,
            capture_output=True,
            text=True,
            check=False,
        )

    def fetch_url(
        self,
        url: str,
        *,
        allowlist: Iterable[str] | None = None,
        allow_unlisted: bool = False,
        timeout: float = FETCH_TIMEOUT_SECONDS,
        max_bytes: int = MAX_RESPONSE_BYTES,
    ) -> FetchResult:
        """Fetch ``url`` under the §15.2 network restrictions.

        Enforced, in order: http/https only, no private/loopback/link-local
        targets (checked against *resolved* addresses, so a hostname cannot be
        used to reach an internal service), the workspace allowlist, a
        ``timeout``-second ceiling, and a ``max_bytes`` response cap. Session and
        credential headers are stripped from the result.

        A host that is merely not allowlisted comes back with
        ``needs_approval=True`` so the caller can raise a ``decision_required``
        instead of failing outright; every other refusal is terminal.
        """
        configured_allowlist = (
            tuple(allowlist) if allowlist is not None else self._network_allowlist
        )
        verdict = check_url(
            url,
            allowlist=configured_allowlist or (),
            enforce_allowlist=(False if allow_unlisted else configured_allowlist is not None),
            run_id=self.run_id,
        )
        if not verdict.allowed:
            return FetchResult(
                ok=False,
                error=verdict.reason,
                needs_approval=verdict.needs_approval,
                url=url,
            )

        request = Request(url, headers={"User-Agent": "zoc-studio-agent"})
        try:
            with urlopen(request, timeout=timeout) as response:
                body = response.read(max_bytes + 1)
                headers = strip_sensitive_headers(dict(response.headers.items()))
                status = int(getattr(response, "status", 0) or 0)
        except (URLError, HTTPError, OSError, ValueError) as exc:
            return FetchResult(ok=False, error=f"fetch failed: {exc}", url=url)

        truncated = len(body) > max_bytes
        text = body[:max_bytes].decode("utf-8", errors="replace")
        return FetchResult(
            ok=True,
            status=status,
            headers=headers,
            body=text,
            truncated=truncated,
            url=url,
        )
