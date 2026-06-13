"""Python wrapper around the Rust hot-path CLI.

Every call shells out to the `llama-studio-hotpath` binary configured via
`Settings.hotpath_bin` and parses its JSON output. Streaming subcommands
(`pty spawn`, `watch run`) yield parsed JSON-line events.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
from collections.abc import AsyncIterator, Iterable
from dataclasses import dataclass
from typing import Any

from .config import Settings, get_settings


class HotPathError(RuntimeError):
    """Raised when the hot-path CLI returns a non-zero exit or invalid JSON."""


@dataclass(slots=True)
class HotPathResult:
    ok: bool
    data: Any


def _bin(settings: Settings | None) -> str:
    return (settings or get_settings()).hotpath_bin


def _run_json(args: Iterable[str], settings: Settings | None = None) -> HotPathResult:
    cmd = [_bin(settings), *args]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    except FileNotFoundError as exc:  # pragma: no cover - exercised in unit tests
        raise HotPathError(f"hotpath binary not found at {_bin(settings)!r}") from exc
    if proc.returncode != 0:
        raise HotPathError(
            f"hotpath exited {proc.returncode}: {proc.stderr.strip() or proc.stdout.strip()}"
        )
    line = proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else ""
    try:
        payload = json.loads(line)
    except json.JSONDecodeError as exc:
        raise HotPathError(f"hotpath stdout not JSON: {proc.stdout!r}") from exc
    return HotPathResult(ok=bool(payload.get("ok")), data=payload.get("data"))


def _run_json_with_stdin(
    args: Iterable[str], stdin_data: str, settings: Settings | None = None
) -> HotPathResult:
    """Run hotpath command with data passed via stdin."""
    cmd = [_bin(settings), *args]
    try:
        proc = subprocess.run(
            cmd, input=stdin_data, capture_output=True, text=True, check=False
        )
    except FileNotFoundError as exc:  # pragma: no cover
        raise HotPathError(f"hotpath binary not found at {_bin(settings)!r}") from exc
    if proc.returncode != 0:
        raise HotPathError(
            f"hotpath exited {proc.returncode}: {proc.stderr.strip() or proc.stdout.strip()}"
        )
    line = proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else ""
    try:
        payload = json.loads(line)
    except json.JSONDecodeError as exc:
        raise HotPathError(f"hotpath stdout not JSON: {proc.stdout!r}") from exc
    return HotPathResult(ok=bool(payload.get("ok")), data=payload.get("data"))


# ── one-shot helpers ──────────────────────────────────────────────────────

def version(settings: Settings | None = None) -> str:
    return str(_run_json(["version"], settings).data)


def index_walk(path: str, max_files: int | None = None) -> list[dict[str, Any]]:
    args = ["index", "walk", path]
    if max_files is not None:
        args += ["--max", str(max_files)]
    return list(_run_json(args).data or [])


def index_count(path: str) -> int:
    return int(_run_json(["index", "count", path]).data or 0)


def search(
    path: str,
    pattern: str,
    *,
    ignore_case: bool = False,
    max_results: int | None = None,
) -> list[dict[str, Any]]:
    args = ["search", path, "--pattern", pattern]
    if ignore_case:
        args.append("--ignore-case")
    if max_results is not None:
        args += ["--max", str(max_results)]
    return list(_run_json(args).data or [])


def chunk_file(path: str, target_lines: int | None = None) -> list[dict[str, Any]]:
    args = ["chunk", path]
    if target_lines is not None:
        args += ["--target-lines", str(target_lines)]
    return list(_run_json(args).data or [])


def apply_patch(
    file_path: str,
    unified_diff: str,
    fuzz: int = 3,
    settings: Settings | None = None,
) -> dict[str, Any]:
    """Apply a unified diff with fuzzy matching via hotpath CLI.
    
    Args:
        file_path: Path to the file to patch
        unified_diff: The unified diff to apply
        fuzz: Maximum line offset to search for hunk context (0 = strict, 3 = recommended)
        settings: Optional settings override
    
    Returns:
        Dict with keys:
            - success: bool - whether all hunks applied successfully
            - applied_hunks: int - number of hunks applied
            - failed_hunks: list - details of any failed hunks
            - new_content: str - the patched file content (only if success=True)
    """
    args = ["apply-patch", file_path, "--fuzz", str(fuzz)]
    result = _run_json_with_stdin(args, unified_diff, settings)
    if not isinstance(result.data, dict):
        raise HotPathError(f"apply-patch returned non-dict: {result.data!r}")
    return result.data


def pty_run(
    cmd: str,
    args: list[str] | None = None,
    *,
    cwd: str | None = None,
    cols: int = 120,
    rows: int = 32,
    timeout_ms: int | None = None,
) -> dict[str, Any]:
    argv: list[str] = ["pty", "run", "--cmd", cmd]
    for a in args or []:
        argv += ["--args", a]
    if cwd:
        argv += ["--cwd", cwd]
    argv += ["--cols", str(cols), "--rows", str(rows)]
    if timeout_ms is not None:
        argv += ["--timeout-ms", str(timeout_ms)]
    out = _run_json(argv).data
    if not isinstance(out, dict):
        raise HotPathError(f"pty run returned non-dict: {out!r}")
    return out


# ── streaming helpers ─────────────────────────────────────────────────────

async def stream_watch(path: str, settings: Settings | None = None) -> AsyncIterator[dict[str, Any]]:
    """Stream filesystem events as parsed JSON dicts."""

    proc = await asyncio.create_subprocess_exec(
        _bin(settings),
        "watch",
        "run",
        path,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    assert proc.stdout is not None
    try:
        async for raw in proc.stdout:
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue
    finally:
        if proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=1.0)
            except TimeoutError:  # pragma: no cover
                proc.kill()


async def stream_pty(
    cmd: str,
    args: list[str] | None = None,
    *,
    cwd: str | None = None,
    cols: int = 120,
    rows: int = 32,
    settings: Settings | None = None,
) -> AsyncIterator[dict[str, Any]]:
    argv: list[str] = [_bin(settings), "pty", "spawn", "--cmd", cmd]
    for a in args or []:
        argv += ["--args", a]
    if cwd:
        argv += ["--cwd", cwd]
    argv += ["--cols", str(cols), "--rows", str(rows)]
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    assert proc.stdout is not None
    try:
        async for raw in proc.stdout:
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue
    finally:
        if proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=1.0)
            except TimeoutError:  # pragma: no cover
                proc.kill()
