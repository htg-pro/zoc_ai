"""A concrete, git-backed :class:`VersionControl` adapter (Requirement 13).

The :class:`MigrationController` is pure policy and never touches git itself; it
drives the :class:`~zocai_migration.controller.VersionControl` port. This module
supplies the real implementation of that port used by the legacy cutover
(task 15): it shells out to the ``git`` binary against a working repository to

* create the legacy preservation branch (``git checkout -b <name>``), and
* commit it (``git add -A`` + ``git commit``), capturing the complete legacy
  implementation before any legacy directory is removed (R13.2).

Every operation reports success purely through the git process exit code, which
is exactly the contract the controller relies on: a failed create (R13.3) or a
failed commit (R13.8) returns ``False`` and the controller deletes nothing.

The adapter holds no migration policy; it only knows how to talk to git. This
keeps it trivially substitutable by the in-memory fakes used elsewhere in the
test-suite while remaining faithful to real version-control behaviour.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

__all__ = ["GitVersionControl", "git_available"]


def git_available(git_binary: str = "git") -> bool:
    """Return ``True`` when a usable ``git`` executable is on the PATH."""
    return shutil.which(git_binary) is not None


class GitVersionControl:
    """Git-backed implementation of the ``VersionControl`` port.

    Parameters
    ----------
    repo_dir:
        Path to the working git repository the branch is created and committed
        in. The directory must already be a git repository (``git init`` has
        been run) for operations to succeed.
    git_binary:
        Name or path of the git executable. Defaults to ``"git"``.

    The adapter is deliberately thin: it runs ``git`` subcommands with
    ``-C <repo_dir>`` and maps the process exit code onto the ``bool`` contract
    of the port. It never raises for an ordinary git failure (a non-zero exit is
    reported as ``False``); only programmer errors propagate.
    """

    def __init__(self, repo_dir: str | Path, *, git_binary: str = "git") -> None:
        self._repo = Path(repo_dir)
        self._git = git_binary

    # -- VersionControl port ----------------------------------------------

    def create_branch(self, name: str) -> bool:
        """Create and switch to ``name``; return ``True`` on success (R13.2)."""
        return self._run("checkout", "-b", name).returncode == 0

    def commit_branch(self, name: str, message: str) -> bool:
        """Stage everything and commit on ``name``; return ``True`` on success.

        The current branch is verified to be ``name`` first so the preservation
        commit lands on the branch the controller asked for. ``--allow-empty``
        lets the branch be committed even when it merely marks the already
        committed legacy state, which is the common case for a preservation
        branch cut from a clean tree.
        """
        if self.current_branch() != name:
            return False
        if self._run("add", "-A").returncode != 0:
            return False
        return self._run("commit", "--allow-empty", "-m", message).returncode == 0

    # -- inspection helpers (used by tests / rollback tooling) -------------

    def current_branch(self) -> str | None:
        """Return the checked-out branch name, or ``None`` if unavailable."""
        proc = self._run("rev-parse", "--abbrev-ref", "HEAD")
        if proc.returncode != 0:
            return None
        return proc.stdout.strip() or None

    def branch_exists(self, name: str) -> bool:
        """Return ``True`` when a local branch ``name`` exists."""
        return (
            self._run(
                "show-ref", "--verify", "--quiet", f"refs/heads/{name}"
            ).returncode
            == 0
        )

    def branch_has_commit(self, name: str) -> bool:
        """Return ``True`` when ``name`` resolves to at least one commit."""
        return self._run("rev-parse", "--verify", "--quiet", f"{name}^{{commit}}").returncode == 0

    # -- internals ---------------------------------------------------------

    def _run(self, *args: str) -> subprocess.CompletedProcess[str]:
        """Run a git subcommand against the repository, capturing output."""
        return subprocess.run(
            [self._git, "-C", str(self._repo), *args],
            capture_output=True,
            text=True,
            check=False,
        )
