"""Project test discovery and bounded PTY execution for Agent runs."""

from __future__ import annotations

import json
import os
import re
import select
import shlex
import signal
import subprocess
import time
import tomllib
from dataclasses import dataclass
from pathlib import Path

__all__ = [
    "ProjectTestCommand",
    "ProjectTestResult",
    "detect_project_test_command",
    "run_project_tests",
]

_ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
_DEFAULT_TIMEOUT_SECONDS = 300.0
_OUTPUT_LIMIT = 65_536


@dataclass(frozen=True, slots=True)
class ProjectTestCommand:
    command: str
    source: str


@dataclass(frozen=True, slots=True)
class ProjectTestResult:
    command: str
    source: str
    exit_code: int
    output: str
    passed: int
    failed: int
    duration_ms: int
    timed_out: bool = False


def detect_project_test_command(workspace_root: Path | str) -> ProjectTestCommand | None:
    """Return the first configured project test command in manifest priority order."""
    root = Path(workspace_root)
    package_command = _from_package_json(root)
    if package_command is not None:
        return package_command
    make_command = _from_makefile(root)
    if make_command is not None:
        return make_command
    return _from_pyproject(root)


def run_project_tests(
    workspace_root: Path | str,
    test: ProjectTestCommand,
    *,
    timeout_seconds: float = _DEFAULT_TIMEOUT_SECONDS,
) -> ProjectTestResult:
    """Run ``test`` in a PTY on POSIX, capture its tail, and summarize counts."""
    root = Path(workspace_root).resolve()
    started = time.monotonic()
    if os.name == "posix":
        exit_code, output, timed_out = _run_in_pty(root, test.command, timeout_seconds)
    else:  # pragma: no cover - exercised on Windows builds
        exit_code, output, timed_out = _run_in_subprocess(
            root, test.command, timeout_seconds
        )
    clean_output = _ANSI_RE.sub("", output).replace("\r\n", "\n").replace("\r", "\n")
    passed, failed = _parse_counts(clean_output, exit_code)
    return ProjectTestResult(
        command=test.command,
        source=test.source,
        exit_code=exit_code,
        output=clean_output,
        passed=passed,
        failed=failed,
        duration_ms=max(0, int((time.monotonic() - started) * 1000)),
        timed_out=timed_out,
    )


def _from_package_json(root: Path) -> ProjectTestCommand | None:
    path = root / "package.json"
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    scripts = payload.get("scripts") if isinstance(payload, dict) else None
    script = scripts.get("test") if isinstance(scripts, dict) else None
    if not isinstance(script, str) or not script.strip():
        return None
    manager = "npm"
    if (root / "pnpm-lock.yaml").exists():
        manager = "pnpm"
    elif (root / "yarn.lock").exists():
        manager = "yarn"
    elif (root / "bun.lockb").exists() or (root / "bun.lock").exists():
        manager = "bun"
    return ProjectTestCommand(command=f"{manager} test", source="package.json")


def _from_makefile(root: Path) -> ProjectTestCommand | None:
    for name in ("Makefile", "makefile", "GNUmakefile"):
        path = root / name
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if re.search(r"(?m)^test\s*::?", text):
            return ProjectTestCommand(command="make test", source=name)
    return None


def _from_pyproject(root: Path) -> ProjectTestCommand | None:
    path = root / "pyproject.toml"
    if not path.is_file():
        return None
    try:
        payload = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError):
        return None
    tool = payload.get("tool") if isinstance(payload, dict) else None
    tool = tool if isinstance(tool, dict) else {}
    runners = (
        ("pdm", "pdm run test", ("scripts", "test")),
        ("hatch", "hatch run test", ("envs", "default", "scripts", "test")),
        ("rye", "rye run test", ("scripts", "test")),
        ("poe", "poe test", ("tasks", "test")),
        ("poetry", "poetry run test", ("scripts", "test")),
    )
    for tool_name, command, path_parts in runners:
        section = tool.get(tool_name)
        if isinstance(section, dict) and _nested_value(section, path_parts) is not None:
            return ProjectTestCommand(command=command, source="pyproject.toml")
    if isinstance(tool.get("pytest"), dict) or _declares_pytest(payload):
        return ProjectTestCommand(command="python -m pytest", source="pyproject.toml")
    project = payload.get("project") if isinstance(payload, dict) else None
    scripts = project.get("scripts") if isinstance(project, dict) else None
    entrypoint = scripts.get("test") if isinstance(scripts, dict) else None
    if isinstance(entrypoint, str) and ":" in entrypoint:
        module, function = entrypoint.split(":", 1)
        code = (
            f"from {module.strip()} import {function.strip()} as _test; "
            "raise SystemExit(_test() or 0)"
        )
        return ProjectTestCommand(
            command=f"python -c {shlex.quote(code)}", source="pyproject.toml"
        )
    return None


def _nested_value(payload: dict[str, object], parts: tuple[str, ...]) -> object | None:
    current: object = payload
    for part in parts:
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def _declares_pytest(payload: dict[str, object]) -> bool:
    project = payload.get("project")
    dependencies = project.get("dependencies") if isinstance(project, dict) else None
    if isinstance(dependencies, list):
        return any(
            isinstance(item, str) and item.lower().startswith("pytest")
            for item in dependencies
        )
    return False


def _run_in_pty(root: Path, command: str, timeout_seconds: float) -> tuple[int, str, bool]:
    import pty

    pid, fd = pty.fork()
    if pid == 0:  # child
        os.chdir(root)
        env = os.environ.copy()
        env.update({"CI": "1", "NO_COLOR": "1", "TERM": "dumb"})
        os.execvpe("/bin/sh", ["sh", "-lc", command], env)

    output = bytearray()
    deadline = time.monotonic() + max(timeout_seconds, 0.1)
    timed_out = False
    status: int | None = None
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                _terminate_pty(pid)
                break
            ready, _, _ = select.select([fd], [], [], min(0.1, remaining))
            if ready:
                try:
                    chunk = os.read(fd, 4096)
                except OSError:
                    chunk = b""
                if chunk:
                    output.extend(chunk)
                    if len(output) > _OUTPUT_LIMIT:
                        del output[:-_OUTPUT_LIMIT]
                else:
                    break
            if status is None:
                waited, next_status = os.waitpid(pid, os.WNOHANG)
                if waited == pid:
                    status = next_status
            if status is not None and not ready:
                break
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
    if status is None:
        try:
            _, status = os.waitpid(pid, 0)
        except ChildProcessError:
            status = 1 << 8
    exit_code = _status_exit_code(status)
    if timed_out:
        exit_code = 124
        output.extend(b"\nTest command timed out.\n")
    return exit_code, output.decode(errors="replace"), timed_out


def _terminate_pty(pid: int) -> None:
    try:
        os.killpg(pid, signal.SIGTERM)
    except OSError:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            return
    time.sleep(0.1)
    try:
        os.killpg(pid, signal.SIGKILL)
    except OSError:
        pass


def _status_exit_code(status: int) -> int:
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return 1


def _run_in_subprocess(
    root: Path, command: str, timeout_seconds: float
) -> tuple[int, str, bool]:
    env = os.environ.copy()
    env.update({"CI": "1", "NO_COLOR": "1"})
    try:
        completed = subprocess.run(
            command,
            cwd=root,
            env=env,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout_seconds,
            check=False,
        )
        output = completed.stdout[-_OUTPUT_LIMIT:].decode(errors="replace")
        return completed.returncode, output, False
    except subprocess.TimeoutExpired as exc:
        output = (exc.stdout or b"")[-_OUTPUT_LIMIT:].decode(errors="replace")
        return 124, output + "\nTest command timed out.\n", True


def _parse_counts(output: str, exit_code: int) -> tuple[int, int]:
    def last_count(patterns: tuple[str, ...]) -> int | None:
        matches: list[int] = []
        for pattern in patterns:
            matches.extend(int(match) for match in re.findall(pattern, output, re.IGNORECASE))
        return matches[-1] if matches else None

    passed = last_count((r"\b(\d+)\s+passed\b", r"#\s*pass\s+(\d+)\b"))
    failed = last_count((r"\b(\d+)\s+failed\b", r"#\s*fail\s+(\d+)\b"))
    if passed is None and failed is None:
        return (1, 0) if exit_code == 0 else (0, 1)
    normalized_failed = failed if failed is not None else (0 if exit_code == 0 else 1)
    return passed or 0, normalized_failed
