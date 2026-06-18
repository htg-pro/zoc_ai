"""Subprocess Shell Spawner and FS read adapter (Layer 3, R8.6 + R8.9).

The Context Enrichment Bus exposes two native-host capabilities to the rest
of the system (design "Subprocess Shell Spawner / FS adapters"):

* **FS read adapter** — native file-system *read* operations, available
  regardless of whether Ask Mode or Agent Mode is active (R8.6). Inspecting
  code is safe in both modes, so reads are an unconditional shared capability.
* **Subprocess shell spawner** — shell command execution, permitted *only*
  while Agent Mode is active and refused while Ask Mode is active. The
  permission is therefore a strict biconditional: shell execution is allowed
  **if and only if** Agent Mode is active (R8.9).

Both adapters delegate the actual host interaction to the workspace-confined
:class:`~zocai_gateway.toolsets.Toolset` / :class:`~zocai_gateway.toolsets.FullToolset`
primitives, so workspace confinement (no target may escape ``workspace_root``)
and the shell-as-argv guarantee (no shell string, hence no shell injection)
remain the single source of truth shared with the mode toolsets (task 4.1).
What this module adds is the *explicit, testable mode gate* the context bus
requires: the spawner is constructed with the current :class:`Mode`, and
:meth:`ShellSpawner.run_shell` refuses execution unless that mode is
:attr:`Mode.AGENT`.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from zocai_gateway.mode_router import Mode
from zocai_gateway.toolsets import FullToolset, ReadOnlyViolation, Toolset

__all__ = [
    "FSReadAdapter",
    "ShellExecutionNotPermitted",
    "ShellSpawner",
]


class FSReadAdapter:
    """Native FS read adapter available in both Ask and Agent Mode (R8.6).

    The adapter wraps the shared, workspace-confined
    :class:`~zocai_gateway.toolsets.Toolset` so reads are subject to the same
    confinement guarantee as every other workspace access: a target resolving
    outside ``workspace_root`` raises :class:`ReadOnlyViolation`. It carries no
    mode and applies no mode gate, because file reads are permitted
    unconditionally regardless of the active mode (R8.6).
    """

    def __init__(self, workspace_root: Path | str = ".") -> None:
        self._toolset = Toolset(workspace_root)

    @property
    def workspace_root(self) -> Path:
        """The resolved workspace root all reads are confined to."""
        return self._toolset.workspace_root

    def read_file(self, rel_path: Path | str) -> str:
        """Read and return the text of a workspace file (R8.6).

        Available in both modes. Raises :class:`ReadOnlyViolation` if
        ``rel_path`` resolves outside the workspace.
        """
        return self._toolset.read_file(rel_path)


class ShellExecutionNotPermitted(ReadOnlyViolation):
    """Raised when shell execution is attempted while Agent Mode is inactive.

    Shell execution is permitted iff Agent Mode is active (R8.9); attempting
    it in any other mode is rejected. Subclassing :class:`ReadOnlyViolation`
    keeps the rejected-operation semantics uniform: the Gateway converts the
    violation into an error indication naming the rejected operation type
    (``"run_shell"``) while leaving the workspace untouched (R2.3, wired in
    task 4.2).
    """

    def __init__(self) -> None:
        super().__init__("run_shell")


class ShellSpawner:
    """Subprocess shell spawner gated on Agent Mode (R8.9).

    The current :class:`Mode` is supplied explicitly at construction so the
    biconditional "shell ⇔ Agent Mode" is a visible, testable gate rather than
    an implicit consequence of which toolset happens to be wired in. When the
    gate is open (Agent Mode), execution is delegated to the workspace-confined
    :meth:`FullToolset.run_shell`, which runs the command from an argument
    vector (no shell string) with ``cwd`` set to the workspace root.
    """

    def __init__(self, mode: Mode, workspace_root: Path | str = ".") -> None:
        self.mode = mode
        self._toolset = FullToolset(workspace_root)

    @property
    def workspace_root(self) -> Path:
        """The resolved workspace root commands run from."""
        return self._toolset.workspace_root

    @property
    def shell_permitted(self) -> bool:
        """Whether shell execution is permitted: ``True`` iff Agent Mode (R8.9)."""
        return self.mode is Mode.AGENT

    def run_shell(self, argv: list[str]) -> subprocess.CompletedProcess[str]:
        """Run a workspace-confined shell command, gated on Agent Mode (R8.9).

        While Agent Mode is active the command is executed and its completed
        process returned. While Agent Mode is inactive the spawner refuses:
        it raises :class:`ShellExecutionNotPermitted` and runs nothing, so the
        permission holds if and only if Agent Mode is active.
        """
        if not self.shell_permitted:
            raise ShellExecutionNotPermitted()
        return self._toolset.run_shell(argv)
