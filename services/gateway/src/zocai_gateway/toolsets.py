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
from pathlib import Path

__all__ = [
    "ReadOnlyViolation",
    "Toolset",
    "ReadOnlyToolset",
    "FullToolset",
]


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

    def __init__(self, workspace_root: Path | str = ".") -> None:
        self.workspace_root: Path = Path(workspace_root).resolve()

    def _resolve_within_workspace(self, rel_path: Path | str, operation: str) -> Path:
        """Resolve ``rel_path`` and assert it stays inside the workspace.

        Raises :class:`ReadOnlyViolation` naming ``operation`` if the target
        escapes the workspace, so even read targets cannot wander outside the
        confined root.
        """
        candidate = (self.workspace_root / Path(rel_path)).resolve()
        if candidate != self.workspace_root and self.workspace_root not in candidate.parents:
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

    def write_file(self, rel_path: Path | str, content: str) -> None:
        """Write ``content`` to a workspace file (R3.5)."""
        target = self._resolve_within_workspace(rel_path, "write_file")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

    def make_dir(self, rel_path: Path | str) -> None:
        """Create a directory within the workspace (R3.5)."""
        target = self._resolve_within_workspace(rel_path, "make_dir")
        target.mkdir(parents=True, exist_ok=True)

    def run_shell(self, argv: list[str]) -> subprocess.CompletedProcess[str]:
        """Run a shell command with the workspace as the working directory.

        Accepts an argument vector (``argv``) rather than a command string so
        the command is executed without a shell, avoiding injection (R3.5,
        R8.9). The process runs with ``cwd`` set to the workspace root.
        """
        return subprocess.run(  # noqa: S603 - argv form, no shell, workspace-confined cwd
            argv,
            cwd=self.workspace_root,
            capture_output=True,
            text=True,
            check=False,
        )
