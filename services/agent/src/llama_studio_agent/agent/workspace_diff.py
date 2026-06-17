"""Pure workspace filesystem primitives: copy, enumerate, diff.

Extracted from ``replit_workflow`` so the redesign's isolated-run flow
(``zoc_run``) no longer depends on the legacy planning module. These helpers
are intentionally pure/stateless and shared by both the legacy Replit workflow
and the new review-before-apply isolation flow.

This decoupling is the enabling step for the "dual-system collapse" (see
``doc/dev/agent-collapse-plan.md``): once the legacy planning layer's only
remaining ties to the new system are gone, ``ReplitPlan``/``ReplitTask`` and
their routes can be removed without touching the isolation flow.
"""

from __future__ import annotations

import difflib
import fnmatch
import os
import shutil
from pathlib import Path

_IGNORE_DIRS = {
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    ".next",
    ".nuxt",
    "dist",
    "build",
    "target",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".venv",
    "venv",
    ".agent",
    ".llama-studio-agent",
}
_IGNORE_FILES = {"*.pyc", "*.pyo", "*.sqlite", "*.sqlite3", "*.db", "*.log"}
_MAX_TEXT_FILE_BYTES = 512_000


def copy_workspace(source: Path, dest: Path) -> None:
    def ignore(_dirpath: str, names: list[str]) -> set[str]:
        ignored: set[str] = set()
        for name in names:
            if name in _IGNORE_DIRS:
                ignored.add(name)
                continue
            if any(fnmatch.fnmatch(name, pat) for pat in _IGNORE_FILES):
                ignored.add(name)
        return ignored

    shutil.copytree(source, dest, ignore=ignore)


def _is_text(path: Path) -> bool:
    try:
        if path.stat().st_size > _MAX_TEXT_FILE_BYTES:
            return False
        path.read_text(encoding="utf-8")
        return True
    except Exception:
        return False


def iter_files(root: Path) -> list[Path]:
    out: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _IGNORE_DIRS]
        for filename in filenames:
            if any(fnmatch.fnmatch(filename, pat) for pat in _IGNORE_FILES):
                continue
            path = Path(dirpath) / filename
            if path.is_file():
                out.append(path.relative_to(root))
    return sorted(out, key=lambda p: str(p))


def changed_files(base: Path, work: Path) -> list[str]:
    rels = set(iter_files(base)) | set(iter_files(work))
    changed: list[str] = []
    for rel in sorted(rels, key=lambda p: str(p)):
        a = base / rel
        b = work / rel
        if not b.exists():
            changed.append(str(rel))
            continue
        if not a.exists():
            changed.append(str(rel))
            continue
        if a.is_file() and b.is_file():
            # Cheap size check first — a differing size guarantees differing
            # content, so we avoid reading (potentially large) file bodies.
            try:
                if a.stat().st_size != b.stat().st_size:
                    changed.append(str(rel))
                    continue
            except OSError:
                changed.append(str(rel))
                continue
            if a.read_bytes() != b.read_bytes():
                changed.append(str(rel))
    return changed


def build_workspace_diff(base: Path, work: Path) -> str:
    hunks: list[str] = []
    for rel_s in changed_files(base, work):
        rel = Path(rel_s)
        a = base / rel
        b = work / rel
        before = a.read_text(encoding="utf-8").splitlines(keepends=True) if a.exists() and _is_text(a) else []
        if not b.exists():
            after: list[str] = []
        elif not _is_text(b):
            hunks.append(f"Binary or large file changed: {rel_s}\n")
            continue
        else:
            after = b.read_text(encoding="utf-8").splitlines(keepends=True)
        hunks.extend(
            difflib.unified_diff(
                before,
                after,
                fromfile=f"a/{rel_s}",
                tofile=f"b/{rel_s}",
                lineterm="",
            )
        )
        hunks.append("\n")
    return "\n".join(hunks).strip()


__all__ = [
    "build_workspace_diff",
    "changed_files",
    "copy_workspace",
    "iter_files",
]
