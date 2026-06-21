"""Workspace file expansion for Composer `@filename` mentions."""

from __future__ import annotations

import html
import os
import re
from collections.abc import Iterable, Iterator, Mapping
from pathlib import Path

IGNORED_DIR_NAMES = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        "node_modules",
        "target",
        "dist",
        "build",
        ".next",
        ".turbo",
        ".cache",
        "__pycache__",
        ".pytest_cache",
        ".venv",
        "venv",
    }
)

MENTION_INLINE_CHAR_LIMIT = 12_000
MENTION_FILE_SCAN_LIMIT = 10_000
MENTION_SEARCH_LIMIT = 25
_MENTION_RE = re.compile(r"(?<!\S)@(?P<token>[A-Za-z0-9._/\-]+)")


def expand_prompt_file_mentions(
    prompt: str,
    workspace_root: Path | str,
    context_files: Iterable[object] = (),
    *,
    char_limit: int = MENTION_INLINE_CHAR_LIMIT,
) -> str:
    """Replace `@token` occurrences with bounded workspace file content.

    Explicit frontend selections in ``context_files`` win, keyed by the visible
    token. Manually typed mentions are resolved by safe relative path first and
    then by basename search within ``workspace_root``.
    """
    if "@" not in prompt:
        return prompt
    root = Path(workspace_root).resolve()
    explicit = _context_file_map(root, context_files)
    resolved: dict[str, Path | None] = {}
    snippets: dict[Path, str | None] = {}

    def replace(match: re.Match[str]) -> str:
        token = match.group("token")
        path = explicit.get(token)
        if path is None:
            if token not in resolved:
                resolved[token] = _resolve_mention_path(root, token)
            path = resolved[token]
        if path is None:
            return match.group(0)
        if path not in snippets:
            snippets[path] = _read_file_snippet(path, char_limit)
        snippet = snippets[path]
        if snippet is None:
            return match.group(0)
        rel = _display_path(root, path)
        escaped = html.escape(rel, quote=True)
        return (
            f"@{token}\n\n"
            f'<zoc_context_file path="{escaped}">\n'
            f"{snippet}\n"
            "</zoc_context_file>"
        )

    return _MENTION_RE.sub(replace, prompt)


def search_workspace_files(
    workspace_root: Path | str,
    query: str,
    limit: int = MENTION_SEARCH_LIMIT,
) -> list[Path]:
    """Return file paths matching ``query`` by basename or relative path."""
    root = Path(workspace_root).resolve()
    q = query.strip().lower()
    matches: list[Path] = []
    for path in _iter_workspace_files(root, max_files=MENTION_FILE_SCAN_LIMIT):
        rel = _display_path(root, path)
        haystack = f"{path.name}\n{rel}".lower()
        if q and q not in haystack:
            continue
        matches.append(path)
        if len(matches) >= limit:
            break
    return matches


def _context_file_map(root: Path, refs: Iterable[object]) -> dict[str, Path]:
    out: dict[str, Path] = {}
    for ref in refs:
        token = _ref_value(ref, "token")
        path_value = _ref_value(ref, "path")
        if not token or not path_value:
            continue
        token = token.lstrip("@").strip()
        if not token or any(ch.isspace() for ch in token):
            continue
        path = _safe_file_path(root, path_value)
        if path is not None:
            out.setdefault(token, path)
    return out


def _ref_value(ref: object, key: str) -> str | None:
    if isinstance(ref, Mapping):
        value = ref.get(key)
    else:
        value = getattr(ref, key, None)
    return value if isinstance(value, str) else None


def _safe_file_path(root: Path, value: str) -> Path | None:
    raw = Path(value)
    if ".." in raw.parts:
        return None
    candidate = (raw if raw.is_absolute() else root / raw).resolve()
    if not _is_within(root, candidate):
        return None
    try:
        return candidate if candidate.is_file() else None
    except OSError:
        return None


def _resolve_mention_path(root: Path, token: str) -> Path | None:
    token_path = Path(token)
    if token_path.is_absolute() or ".." in token_path.parts:
        return None
    if "/" in token or "\\" in token:
        return _safe_file_path(root, token)
    for path in _iter_workspace_files(root, max_files=MENTION_FILE_SCAN_LIMIT):
        if path.name == token:
            return path
    return None


def _iter_workspace_files(root: Path, *, max_files: int) -> Iterator[Path]:
    seen = 0

    def on_error(_err: OSError) -> None:
        return None

    for dirpath, dirnames, filenames in os.walk(root, onerror=on_error):
        dirnames[:] = sorted(
            name for name in dirnames if name not in IGNORED_DIR_NAMES
        )
        for name in sorted(filenames):
            path = Path(dirpath) / name
            try:
                if not path.is_file():
                    continue
            except OSError:
                continue
            yield path
            seen += 1
            if seen >= max_files:
                return


def _read_file_snippet(path: Path, char_limit: int) -> str | None:
    try:
        raw = path.read_bytes()
    except OSError:
        return None
    if b"\0" in raw[:4096]:
        return None
    text = raw.decode("utf-8", errors="replace")
    if len(text) <= char_limit:
        return text.rstrip()
    snippet = text[:char_limit].rstrip()
    return f"{snippet}\n\n[... truncated; file is {len(text)} characters ...]"


def _display_path(root: Path, path: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def _is_within(root: Path, path: Path) -> bool:
    return path == root or root in path.parents
