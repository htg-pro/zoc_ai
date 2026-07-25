"""Bundled workspace-confined git-history MCP server (Part 4, §4.2, R16).

Exposes ``git_log``, ``git_blame``, and ``git_show``. Every git invocation runs
the local ``git`` binary from an argument vector with the working directory
pinned to Workspace_Root (R16.9) via the injectable :data:`GitRunner` seam, so
tests drive the tools with a fake runner and no real subprocess. Every
filesystem-path parameter (``git_log.path`` and ``git_blame.file``) is
canonically resolved against Workspace_Root and *fails closed* — a resolution
error or an escape returns a typed failure and never invokes git (R16.10–R16.12).
A ``git_blame`` range with ``line_start`` past ``line_end`` fails before invoking
git (R16.5); a spawn failure or non-zero exit yields a typed failure carrying the
git error output (R16.14, R16.15). Every invocation is independent and inspects
only the local repository reachable from Workspace_Root (R16.13, R16.16, R16.17).
"""

from __future__ import annotations

import os
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

from ._mcp import Server, ToolHandler, error_result

__all__ = [
    "GitRunner",
    "build_server",
    "default_run_git",
    "git_blame",
    "git_log",
    "git_show",
    "main",
    "resolve_within",
]

DEFAULT_LOG_LIMIT = 10

# A git runner maps an argument vector to ``(returncode, stdout, stderr)``.
GitRunner = Callable[[list[str]], tuple[int, str, str]]


def resolve_within(workspace_root: Path, path: str) -> Path | None:
    """Canonically resolve ``path`` against ``workspace_root``, failing closed.

    Mirrors the confinement resolver: ``candidate = (root / path).resolve()`` is
    admitted only when it equals the resolved ``root`` or the resolved ``root`` is
    one of its parents. Any resolution error (for example an embedded null byte)
    or an escape outside Workspace_Root yields ``None`` (R16.10, R16.11).
    """
    root = Path(workspace_root).resolve()
    try:
        candidate = (root / path).resolve()
    except Exception:
        return None
    if candidate == root or root in candidate.parents:
        return candidate
    return None


def _git_argv(workspace_root: Path, *args: str) -> list[str]:
    """Build a ``git -C <root> ...`` argument vector rooted at Workspace_Root (R16.9)."""
    root = str(Path(workspace_root).resolve())
    return ["git", "-C", root, *args]


def _invoke(
    run_git: GitRunner, argv: list[str], tool: str
) -> tuple[str | None, dict[str, object] | None]:
    """Run ``argv`` via ``run_git``; return ``(stdout, None)`` or ``(None, failure)``.

    A raised exception is treated as a spawn failure (R16.14); a non-zero exit is
    treated as a failure carrying the git error output (R16.15).
    """
    try:
        returncode, stdout, stderr = run_git(argv)
    except Exception as exc:
        return None, error_result(f"{tool} failed to start git: {type(exc).__name__}: {exc}")
    if returncode != 0:
        return None, error_result(f"{tool} exited with status {returncode}: {stderr.strip()}")
    return stdout, None


def git_log(
    workspace_root: Path,
    run_git: GitRunner,
    path: str | None = None,
    n: int = DEFAULT_LOG_LIMIT,
) -> dict[str, object]:
    """Return at most ``n`` commit log entries, optionally confined to ``path`` (R16.1–R16.3)."""
    if n < 1:
        return error_result(f"git_log requires n >= 1; received {n!r}")

    args = ["log", f"--max-count={n}", "--pretty=oneline", "--no-color"]
    if path is not None:
        candidate = resolve_within(workspace_root, path)
        if candidate is None:
            return error_result(f"git_log path escapes the workspace: {path!r}")
        args += ["--", str(candidate)]

    argv = _git_argv(workspace_root, *args)
    stdout, failure = _invoke(run_git, argv, "git_log")
    if failure is not None:
        return failure

    entries = [line for line in (stdout or "").splitlines() if line.strip()][:n]
    return {
        "content": [{"type": "text", "text": "\n".join(entries)}],
        "isError": False,
        "entries": entries,
    }


def git_blame(
    workspace_root: Path,
    run_git: GitRunner,
    file: str,
    line_start: int,
    line_end: int,
) -> dict[str, object]:
    """Blame ``file`` over the 1-based inclusive range ``line_start``..``line_end`` (R16.4–R16.6)."""
    if line_start < 1 or line_end < 1:
        return error_result(
            f"git_blame requires 1-based positive lines; received {line_start!r}..{line_end!r}"
        )
    if line_start > line_end:
        # R16.5: an inverted range is rejected before git is invoked.
        return error_result(f"git_blame line_start {line_start} exceeds line_end {line_end}")

    candidate = resolve_within(workspace_root, file)
    if candidate is None:
        return error_result(f"git_blame file escapes the workspace: {file!r}")

    argv = _git_argv(
        workspace_root, "blame", "-L", f"{line_start},{line_end}", "--", str(candidate)
    )
    stdout, failure = _invoke(run_git, argv, "git_blame")
    if failure is not None:
        return failure
    return {"content": [{"type": "text", "text": stdout or ""}], "isError": False, "blame": stdout}


def git_show(workspace_root: Path, run_git: GitRunner, sha: str) -> dict[str, object]:
    """Return the commit metadata and patch text for ``sha`` (R16.7, R16.8)."""
    argv = _git_argv(workspace_root, "show", "--no-color", sha)
    stdout, failure = _invoke(run_git, argv, "git_show")
    if failure is not None:
        return failure
    return {"content": [{"type": "text", "text": stdout or ""}], "isError": False, "output": stdout}


def default_run_git(workspace_root: Path) -> GitRunner:
    """Build the production :data:`GitRunner` backed by ``subprocess.run`` (R16.9).

    The runner executes the argv — already prefixed with ``git -C <root>`` — with
    the working directory pinned to Workspace_Root and text output captured. It
    never contacts a remote (R16.17); git_log/blame/show are local operations.
    """
    root = str(Path(workspace_root).resolve())

    def run(argv: list[str]) -> tuple[int, str, str]:
        completed = subprocess.run(  # argv is a list; no shell command string
            argv,
            cwd=root,
            capture_output=True,
            text=True,
            check=False,
        )
        return completed.returncode, completed.stdout, completed.stderr

    return run


def _as_int(value: object, default: int) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else default


def _make_git_log_handler(workspace_root: Path, run_git: GitRunner) -> ToolHandler:
    def handler(arguments: dict[str, object]) -> dict[str, object]:
        raw_path = arguments.get("path")
        path = raw_path if isinstance(raw_path, str) else None
        n = _as_int(arguments.get("n"), DEFAULT_LOG_LIMIT)
        return git_log(workspace_root, run_git, path, n)

    return handler


def _make_git_blame_handler(workspace_root: Path, run_git: GitRunner) -> ToolHandler:
    def handler(arguments: dict[str, object]) -> dict[str, object]:
        file = str(arguments.get("file", ""))
        line_start = _as_int(arguments.get("line_start"), 1)
        line_end = _as_int(arguments.get("line_end"), 1)
        return git_blame(workspace_root, run_git, file, line_start, line_end)

    return handler


def _make_git_show_handler(workspace_root: Path, run_git: GitRunner) -> ToolHandler:
    def handler(arguments: dict[str, object]) -> dict[str, object]:
        sha = str(arguments.get("sha", ""))
        return git_show(workspace_root, run_git, sha)

    return handler


_GIT_LOG_SCHEMA: dict[str, object] = {
    "type": "object",
    "properties": {
        "path": {"type": "string", "description": "Optional workspace path to limit history."},
        "n": {"type": "integer", "minimum": 1, "default": DEFAULT_LOG_LIMIT},
    },
    "additionalProperties": False,
}
_GIT_BLAME_SCHEMA: dict[str, object] = {
    "type": "object",
    "properties": {
        "file": {"type": "string", "description": "Workspace file to blame."},
        "line_start": {"type": "integer", "minimum": 1},
        "line_end": {"type": "integer", "minimum": 1},
    },
    "required": ["file", "line_start", "line_end"],
    "additionalProperties": False,
}
_GIT_SHOW_SCHEMA: dict[str, object] = {
    "type": "object",
    "properties": {"sha": {"type": "string", "description": "Commit identifier to show."}},
    "required": ["sha"],
    "additionalProperties": False,
}


def build_server(workspace_root: Path, run_git: GitRunner | None = None) -> Server:
    """Build the git-history :class:`Server`, confined to ``workspace_root``."""
    runner = run_git if run_git is not None else default_run_git(workspace_root)
    server = Server(name="zocai-git-history", version="1.0.0")
    server.register(
        "git_log",
        "Return recent commit log entries, optionally confined to a workspace path.",
        _GIT_LOG_SCHEMA,
        _make_git_log_handler(workspace_root, runner),
    )
    server.register(
        "git_blame",
        "Return git blame output for a 1-based inclusive line range of a workspace file.",
        _GIT_BLAME_SCHEMA,
        _make_git_blame_handler(workspace_root, runner),
    )
    server.register(
        "git_show",
        "Return the commit metadata and patch text for a commit identifier.",
        _GIT_SHOW_SCHEMA,
        _make_git_show_handler(workspace_root, runner),
    )
    return server


def main() -> None:  # pragma: no cover - real stdio entry point
    workspace_root = Path(os.environ.get("ZOC_WORKSPACE_ROOT") or Path.cwd()).resolve()
    build_server(workspace_root).serve(sys.stdin.buffer, sys.stdout.buffer, workspace_root)


if __name__ == "__main__":  # pragma: no cover
    main()
