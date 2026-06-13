"""Terminal agent mode.

Owns a registry of long-running PTY sessions. On Unix we use the stdlib
`pty.fork` to get a real bidirectional PTY (input + resize forwarding).
On Windows we fall back to the hot-path `pty spawn` streaming CLI which
is output-only; input/resize there become no-ops until a follow-up.
"""

from __future__ import annotations

import asyncio
import contextlib
import errno
import fcntl
import os
import shutil
import signal
import struct
import termios
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from uuid import UUID, uuid4

from shared_schema.models import TerminalSession, TerminalSessionStatus

_IS_POSIX = os.name == "posix"


@dataclass(slots=True)
class _Subscriber:
    queue: asyncio.Queue[dict | None]


@dataclass(slots=True)
class _Entry:
    session: TerminalSession
    task: asyncio.Task
    pid: int | None = None
    master_fd: int | None = None
    subscribers: list[_Subscriber] = field(default_factory=list)
    history: list[dict] = field(default_factory=list)


class TerminalAgent:
    def __init__(self) -> None:
        self._entries: dict[UUID, _Entry] = {}

    def list(self) -> list[TerminalSession]:
        return [e.session for e in self._entries.values()]

    def get(self, sid: UUID) -> TerminalSession | None:
        entry = self._entries.get(sid)
        return entry.session if entry else None

    async def spawn(
        self,
        *,
        cmd: str,
        args: list[str] | None = None,
        cwd: str | None = None,
        cols: int = 120,
        rows: int = 32,
    ) -> TerminalSession:
        session = TerminalSession(
            id=uuid4(),
            cmd=cmd,
            args=args or [],
            cwd=cwd,
            status=TerminalSessionStatus.running,
        )
        entry = _Entry(session=session, task=None)  # type: ignore[arg-type]
        if _IS_POSIX:
            self._start_posix(entry, cmd, args or [], cwd, cols, rows)
        else:  # pragma: no cover - windows fallback
            self._start_fallback(entry, cmd, args or [], cwd)
        self._entries[session.id] = entry
        return session

    async def stop(self, sid: UUID) -> None:
        entry = self._entries.get(sid)
        if not entry:
            return
        if entry.pid:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.kill(entry.pid, signal.SIGTERM)
        if entry.task and not entry.task.done():
            entry.task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await entry.task
        entry.session.status = TerminalSessionStatus.exited

    async def write(self, sid: UUID, data: str) -> bool:
        entry = self._entries.get(sid)
        if not entry or entry.master_fd is None:
            return False
        try:
            os.write(entry.master_fd, data.encode("utf-8", errors="replace"))
            return True
        except (BrokenPipeError, OSError):
            return False

    def resize(self, sid: UUID, cols: int, rows: int) -> bool:
        entry = self._entries.get(sid)
        if not entry or entry.master_fd is None or not _IS_POSIX:
            return False
        try:
            packed = struct.pack("HHHH", rows, cols, 0, 0)
            fcntl.ioctl(entry.master_fd, termios.TIOCSWINSZ, packed)
            return True
        except OSError:
            return False

    async def subscribe(self, sid: UUID) -> AsyncIterator[dict]:
        entry = self._entries.get(sid)
        if not entry:
            return
        sub = _Subscriber(queue=asyncio.Queue(maxsize=512))
        for ev in entry.history:
            await sub.queue.put(ev)
        entry.subscribers.append(sub)
        try:
            while True:
                ev = await sub.queue.get()
                if ev is None:
                    return
                yield ev
        finally:
            with contextlib.suppress(ValueError):
                entry.subscribers.remove(sub)

    # ── implementation ─────────────────────────────────────────────────

    def _start_posix(
        self,
        entry: _Entry,
        cmd: str,
        args: list[str],
        cwd: str | None,
        cols: int,
        rows: int,
    ) -> None:
        import pty as _pty

        pid, fd = _pty.fork()
        if pid == 0:  # child
            try:
                if cwd:
                    os.chdir(cwd)
                # Ensure xterm-256color env so prompts render correctly.
                os.environ.setdefault("TERM", "xterm-256color")
                # Resolve executable so PATH is honoured.
                resolved = shutil.which(cmd) or cmd
                os.execvp(resolved, [cmd, *args])
            except Exception:
                os._exit(127)

        entry.pid = pid
        entry.master_fd = fd
        # Initial window size.
        with contextlib.suppress(OSError):
            packed = struct.pack("HHHH", rows, cols, 0, 0)
            fcntl.ioctl(fd, termios.TIOCSWINSZ, packed)
        loop = asyncio.get_event_loop()
        entry.task = loop.create_task(self._run_posix(entry))

    async def _run_posix(self, entry: _Entry) -> None:
        loop = asyncio.get_event_loop()
        fd = entry.master_fd
        assert fd is not None
        try:
            while True:
                try:
                    data = await loop.run_in_executor(None, _safe_read, fd)
                except Exception as exc:
                    self._fanout(entry.session.id, {"type": "error", "message": str(exc)})
                    break
                if data is None:
                    break
                if not data:
                    continue
                self._fanout(
                    entry.session.id,
                    {"type": "data", "chunk": data.decode("utf-8", errors="replace")},
                )
        finally:
            code = await loop.run_in_executor(None, _wait_pid, entry.pid)
            entry.session.exit_code = code
            entry.session.status = TerminalSessionStatus.exited
            self._fanout(entry.session.id, {"type": "exit", "code": code})
            self._fanout(entry.session.id, None)

    def _start_fallback(
        self,
        entry: _Entry,
        cmd: str,
        args: list[str],
        cwd: str | None,
    ) -> None:  # pragma: no cover - windows path
        from .. import hotpath

        async def runner() -> None:
            try:
                async for ev in hotpath.stream_pty(cmd, args, cwd=cwd):
                    self._fanout(entry.session.id, ev)
                    if ev.get("type") == "exit":
                        entry.session.exit_code = ev.get("code")
            except Exception as exc:
                self._fanout(entry.session.id, {"type": "error", "message": str(exc)})
            finally:
                entry.session.status = TerminalSessionStatus.exited
                self._fanout(entry.session.id, None)

        entry.task = asyncio.create_task(runner())

    def _fanout(self, sid: UUID, ev: dict | None) -> None:
        entry = self._entries.get(sid)
        if not entry:
            return
        if ev is not None:
            entry.history.append(ev)
        for sub in list(entry.subscribers):
            with contextlib.suppress(asyncio.QueueFull):
                sub.queue.put_nowait(ev)


def _safe_read(fd: int) -> bytes | None:
    try:
        data = os.read(fd, 4096)
    except OSError as exc:
        if exc.errno == errno.EIO:
            return None
        raise
    if not data:
        return None
    return data


def _wait_pid(pid: int | None) -> int | None:
    if not pid:
        return None
    try:
        _, status = os.waitpid(pid, 0)
        if os.WIFEXITED(status):
            return os.WEXITSTATUS(status)
        if os.WIFSIGNALED(status):
            return -os.WTERMSIG(status)
    except ChildProcessError:
        return None
    return None
