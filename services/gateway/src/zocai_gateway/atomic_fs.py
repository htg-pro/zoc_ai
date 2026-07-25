"""Rollback-safe filesystem transaction used by live review-before-apply runs.

The desktop path uses the Rust hotpath transaction. The gateway owns a second
local process and cannot invoke Tauri IPC, so reviewed files use this equivalent
same-directory temp/replace algorithm instead of one-by-one ``copy2`` writes.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class CommitResult:
    written: int
    deleted: int


@dataclass(frozen=True, slots=True)
class _Write:
    path: Path
    content: bytes
    mode: int | None


@dataclass(frozen=True, slots=True)
class _Delete:
    path: Path


@dataclass(frozen=True, slots=True)
class _Backup:
    path: Path
    content: bytes | None
    mode: int | None


class TransactionError(RuntimeError):
    def __init__(self, path: Path, cause: BaseException, rollback_errors: tuple[str, ...] = ()):
        detail = f"transaction failed at {path}: {type(cause).__name__}: {cause}"
        if rollback_errors:
            detail += "; rollback errors: " + "; ".join(rollback_errors)
        super().__init__(detail)
        self.path = path
        self.cause = cause
        self.rollback_errors = rollback_errors


class CheckpointError(RuntimeError):
    """A post-commit Git checkpoint could not be created."""


def _git(root: Path, *args: str) -> str:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=root,
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise CheckpointError(f"git unavailable: {exc}") from exc
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise CheckpointError(f"git failed: {detail}")
    return result.stdout


def git_checkpoint(root: Path, message: str) -> str | None:
    """Commit a dirty Git tree after a successful filesystem transaction.

    A clean tree or non-repository is a no-op. Once a repository is detected,
    failures are reported so callers can surface them without pretending the
    already-committed filesystem transaction rolled back.
    """
    try:
        inside = _git(root, "rev-parse", "--is-inside-work-tree").strip()
    except CheckpointError:
        return None
    if inside != "true":
        return None
    if not _git(root, "status", "--porcelain").strip():
        return None
    _git(root, "add", "-A")
    _git(root, "commit", "--no-verify", "-m", message)
    return _git(root, "rev-parse", "HEAD").strip()


class AtomicFileTransaction:
    """Stage writes/deletes, then commit all-or-nothing."""

    def __init__(self) -> None:
        self._ops: list[_Write | _Delete] = []

    def add_write(self, path: Path, content: bytes, *, mode: int | None = None) -> None:
        self._ops.append(_Write(path=path, content=content, mode=mode))

    def add_delete(self, path: Path) -> None:
        self._ops.append(_Delete(path=path))

    def commit(self) -> CommitResult:
        backups = self._backups()
        temps: list[tuple[Path, Path]] = []
        created_dirs: set[Path] = set()

        try:
            for op in self._ops:
                if not isinstance(op, _Write):
                    continue
                self._ensure_parent(op.path.parent, created_dirs)
                fd, raw_temp = tempfile.mkstemp(
                    prefix=f".{op.path.name}.zoc_tmp_",
                    dir=op.path.parent,
                )
                temp = Path(raw_temp)
                try:
                    with os.fdopen(fd, "wb") as stream:
                        stream.write(op.content)
                        stream.flush()
                        os.fsync(stream.fileno())
                    mode = op.mode
                    if mode is None and op.path.exists():
                        mode = op.path.stat().st_mode
                    if mode is not None:
                        os.chmod(temp, mode)
                except BaseException:
                    temp.unlink(missing_ok=True)
                    raise
                temps.append((temp, op.path))
        except BaseException as exc:
            self._cleanup_temps(temps)
            self._cleanup_dirs(created_dirs)
            path = op.path if "op" in locals() else Path(".")
            raise TransactionError(path, exc) from exc

        written = 0
        deleted = 0
        current_path = Path(".")
        try:
            for temp, target in temps:
                current_path = target
                os.replace(temp, target)
                written += 1
            for op in self._ops:
                if not isinstance(op, _Delete):
                    continue
                current_path = op.path
                try:
                    op.path.unlink()
                    deleted += 1
                except FileNotFoundError:
                    pass
        except BaseException as exc:
            rollback_errors = self._restore(backups)
            self._cleanup_temps(temps)
            self._cleanup_dirs(created_dirs)
            raise TransactionError(current_path, exc, rollback_errors) from exc

        return CommitResult(written=written, deleted=deleted)

    def _backups(self) -> list[_Backup]:
        backups: dict[Path, _Backup] = {}
        for op in self._ops:
            path = op.path
            if path in backups:
                continue
            try:
                content = path.read_bytes()
                mode = path.stat().st_mode
            except FileNotFoundError:
                content = None
                mode = None
            except BaseException as exc:
                raise TransactionError(path, exc) from exc
            backups[path] = _Backup(path=path, content=content, mode=mode)
        return list(backups.values())

    @staticmethod
    def _ensure_parent(parent: Path, created_dirs: set[Path]) -> None:
        missing: list[Path] = []
        cursor = parent
        while not cursor.exists():
            missing.append(cursor)
            if cursor.parent == cursor:
                raise OSError(f"no existing ancestor for {parent}")
            cursor = cursor.parent
        parent.mkdir(parents=True, exist_ok=True)
        created_dirs.update(missing)

    @staticmethod
    def _cleanup_temps(temps: list[tuple[Path, Path]]) -> None:
        for temp, _target in temps:
            temp.unlink(missing_ok=True)

    @staticmethod
    def _cleanup_dirs(created_dirs: set[Path]) -> None:
        for directory in sorted(created_dirs, key=lambda path: len(path.parts), reverse=True):
            with suppress(OSError):
                directory.rmdir()

    @staticmethod
    def _restore(backups: list[_Backup]) -> tuple[str, ...]:
        errors: list[str] = []
        for backup in backups:
            try:
                if backup.content is None:
                    if backup.path.is_file() or backup.path.is_symlink():
                        backup.path.unlink(missing_ok=True)
                    continue
                backup.path.parent.mkdir(parents=True, exist_ok=True)
                fd, raw_temp = tempfile.mkstemp(
                    prefix=f".{backup.path.name}.zoc_restore_",
                    dir=backup.path.parent,
                )
                temp = Path(raw_temp)
                try:
                    with os.fdopen(fd, "wb") as stream:
                        stream.write(backup.content)
                        stream.flush()
                        os.fsync(stream.fileno())
                    if backup.mode is not None:
                        os.chmod(temp, backup.mode)
                    os.replace(temp, backup.path)
                finally:
                    temp.unlink(missing_ok=True)
            except BaseException as exc:  # best effort, but never hide it
                errors.append(f"{backup.path}: {type(exc).__name__}: {exc}")
        return tuple(errors)
