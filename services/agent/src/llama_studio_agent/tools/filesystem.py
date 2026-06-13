"""Filesystem tools: read_file, write_file, list_dir, apply_patch."""

from __future__ import annotations

import difflib
import re
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field
from shared_schema.models import PermissionScope

from .base import Tool, ToolContext, ToolExecutionError
from .sandbox import SandboxLimits, resolve_path


def _resolve(ctx: ToolContext, rel_or_abs: str) -> Path:
    return resolve_path(ctx.workspace_root, rel_or_abs)


# ── read_file ─────────────────────────────────────────────────────────────

class ReadFileInput(BaseModel):
    path: str = Field(description="Path relative to the workspace root.")
    start_line: int | None = Field(default=None, ge=1)
    end_line: int | None = Field(default=None, ge=1)


class ReadFileTool(Tool[ReadFileInput, dict[str, Any]]):
    name = "read_file"
    description = "Read a UTF-8 text file. Optionally slice [start_line, end_line] (1-indexed, inclusive)."
    Input = ReadFileInput
    requires_scopes = (PermissionScope.read_fs,)
    sandbox_limits = SandboxLimits.READ

    async def run(self, ctx: ToolContext, args: ReadFileInput) -> dict[str, Any]:
        p = _resolve(ctx, args.path)
        if not p.exists():
            raise ToolExecutionError(f"file not found: {args.path}")
        if p.is_dir():
            raise ToolExecutionError(f"path is a directory: {args.path}")
        text = p.read_text(encoding="utf-8", errors="replace")
        if args.start_line or args.end_line:
            lines = text.splitlines()
            s = (args.start_line or 1) - 1
            e = args.end_line or len(lines)
            text = "\n".join(lines[s:e])
        return {"path": str(p.relative_to(Path(ctx.workspace_root).resolve())), "content": text}


# ── write_file ────────────────────────────────────────────────────────────

class WriteFileInput(BaseModel):
    path: str
    content: str
    create_dirs: bool = True


class WriteFileTool(Tool[WriteFileInput, dict[str, Any]]):
    name = "write_file"
    description = "Create or overwrite a UTF-8 text file."
    Input = WriteFileInput
    requires_scopes = (PermissionScope.write_fs,)
    destructive = True
    sandbox_limits = SandboxLimits.WRITE

    async def run(self, ctx: ToolContext, args: WriteFileInput) -> dict[str, Any]:
        p = _resolve(ctx, args.path)
        if args.create_dirs:
            p.parent.mkdir(parents=True, exist_ok=True)
        before = p.read_text(encoding="utf-8", errors="replace") if p.exists() else ""
        p.write_text(args.content, encoding="utf-8")
        diff = "".join(
            difflib.unified_diff(
                before.splitlines(keepends=True),
                args.content.splitlines(keepends=True),
                fromfile=f"a/{args.path}",
                tofile=f"b/{args.path}",
            )
        )
        return {"path": args.path, "bytes_written": len(args.content), "diff": diff}


# ── list_dir ──────────────────────────────────────────────────────────────

class ListDirInput(BaseModel):
    path: str = "."
    max_entries: int = Field(default=200, ge=1, le=10_000)


class ListDirTool(Tool[ListDirInput, list[dict[str, Any]]]):
    name = "list_dir"
    description = "List the immediate children of a directory."
    Input = ListDirInput
    requires_scopes = (PermissionScope.read_fs,)
    sandbox_limits = SandboxLimits.LIST

    async def run(self, ctx: ToolContext, args: ListDirInput) -> list[dict[str, Any]]:
        p = _resolve(ctx, args.path)
        if not p.exists():
            raise ToolExecutionError(f"not found: {args.path}")
        if not p.is_dir():
            raise ToolExecutionError(f"not a directory: {args.path}")
        out: list[dict[str, Any]] = []
        for child in sorted(p.iterdir(), key=lambda c: (c.is_file(), c.name)):
            try:
                stat = child.stat()
            except OSError:
                continue
            out.append(
                {
                    "name": child.name,
                    "is_dir": child.is_dir(),
                    "bytes": stat.st_size if child.is_file() else None,
                }
            )
            if len(out) >= args.max_entries:
                break
        return out


# ── apply_patch ───────────────────────────────────────────────────────────

class ApplyPatchInput(BaseModel):
    unified_diff: str = Field(description="A standard unified diff (one or more files).")


_HUNK_HEADER = re.compile(r"^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@")


class ApplyPatchTool(Tool[ApplyPatchInput, dict[str, Any]]):
    """Unified-diff applier with fuzzy matching via hotpath CLI.
    
    Uses llama-studio-hotpath's fuzzy patch implementation for robust
    patch application with tolerance for line drift (±3 lines by default).
    """

    name = "apply_patch"
    description = "Apply a unified diff across one or more files in the workspace."
    Input = ApplyPatchInput
    requires_scopes = (PermissionScope.write_fs,)
    destructive = True
    sandbox_limits = SandboxLimits.PATCH

    async def run(self, ctx: ToolContext, args: ApplyPatchInput) -> dict[str, Any]:
        from .. import hotpath
        
        files_changed: list[str] = []
        for file_path, file_diff in _split_patch_with_diff(args.unified_diff):
            target = _resolve(ctx, file_path)
            if not str(target.resolve()).startswith(str(Path(ctx.workspace_root).resolve())):
                raise ToolExecutionError(f"patch target escapes workspace: {file_path}")
            
            # Use hotpath fuzzy patcher with fuzz=3
            result = hotpath.apply_patch(str(target), file_diff, fuzz=3)
            
            if not result.get("success"):
                failed_hunks = result.get("failed_hunks", [])
                error_msg = f"patch failed for {file_path}"
                if failed_hunks:
                    error_msg += f": {len(failed_hunks)} hunk(s) failed"
                    # Add details for first failed hunk
                    if failed_hunks:
                        first_fail = failed_hunks[0]
                        error_msg += f"\nFirst failure: {first_fail.get('reason', 'unknown')}"
                raise ToolExecutionError(error_msg)
            
            new_content = result.get("new_content")
            if new_content is None:
                raise ToolExecutionError(f"patch returned no content for {file_path}")
            
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(new_content, encoding="utf-8")
            files_changed.append(file_path)
        
        return {"files_changed": files_changed}


def _split_patch(text: str) -> list[tuple[str, list[list[str]]]]:
    files: list[tuple[str, list[list[str]]]] = []
    current_path: str | None = None
    current_hunks: list[list[str]] = []
    current_hunk: list[str] | None = None
    for line in text.splitlines():
        if line.startswith("--- "):
            # flush previous
            if current_path is not None:
                if current_hunk is not None:
                    current_hunks.append(current_hunk)
                files.append((current_path, current_hunks))
            current_path = None
            current_hunks = []
            current_hunk = None
            continue
        if line.startswith("+++ "):
            path = line[4:].strip()
            if path.startswith("b/"):
                path = path[2:]
            current_path = path
            continue
        if line.startswith("@@"):
            if current_hunk is not None:
                current_hunks.append(current_hunk)
            current_hunk = []
            continue
        if current_hunk is not None:
            current_hunk.append(line)
    if current_path is not None:
        if current_hunk is not None:
            current_hunks.append(current_hunk)
        files.append((current_path, current_hunks))
    if not files:
        raise ToolExecutionError("no file headers found in patch")
    return files


def _split_patch_with_diff(text: str) -> list[tuple[str, str]]:
    """Split a unified diff into (file_path, file_diff) pairs.
    
    Unlike _split_patch which parses hunks, this function returns the raw
    diff text for each file, suitable for passing to hotpath.apply_patch.
    """
    files: list[tuple[str, str]] = []
    current_path: str | None = None
    current_diff_lines: list[str] = []
    
    for line in text.splitlines():
        if line.startswith("--- "):
            # flush previous
            if current_path is not None:
                files.append((current_path, "\n".join(current_diff_lines)))
            current_path = None
            current_diff_lines = [line]
            continue
        if line.startswith("+++ "):
            path = line[4:].strip()
            if path.startswith("b/"):
                path = path[2:]
            current_path = path
            current_diff_lines.append(line)
            continue
        # Add all other lines to current diff
        current_diff_lines.append(line)
    
    # Flush last file
    if current_path is not None:
        files.append((current_path, "\n".join(current_diff_lines)))
    
    if not files:
        raise ToolExecutionError("no file headers found in patch")
    return files


def _apply_hunks(original: str, hunks: list[list[str]]) -> str:
    src_lines = original.splitlines(keepends=False)
    out: list[str] = list(src_lines)
    # Apply hunks bottom-up by matching context, so line numbers stay stable.
    for hunk in hunks:
        context_before: list[str] = []
        removed: list[str] = []
        added: list[str] = []
        for ln in hunk:
            if not ln:
                context_before.append("")
                continue
            tag = ln[0]
            body = ln[1:]
            if tag == " ":
                context_before.append(body)
            elif tag == "-":
                removed.append(body)
            elif tag == "+":
                added.append(body)
        target_block = context_before[: len(context_before) - len(added)] + removed + context_before[len(context_before) - len(added):]
        # Simpler model: locate the old block (context + removed lines in order)
        old_block: list[str] = []
        new_block: list[str] = []
        for ln in hunk:
            if not ln or ln[0] == " ":
                body = ln[1:] if ln else ""
                old_block.append(body)
                new_block.append(body)
            elif ln[0] == "-":
                old_block.append(ln[1:])
            elif ln[0] == "+":
                new_block.append(ln[1:])
        if not old_block:
            # Pure-add hunk (e.g. new file) → just append.
            out.extend(new_block)
            continue
        idx = _find_subseq(out, old_block)
        if idx < 0:
            raise ToolExecutionError(
                f"patch context not found:\n{chr(10).join(old_block[:5])}"
            )
        out[idx : idx + len(old_block)] = new_block
        _ = target_block  # quiet unused-var warning
    return "\n".join(out) + ("\n" if original.endswith("\n") or not original else "")


def _find_subseq(haystack: list[str], needle: list[str]) -> int:
    if not needle:
        return -1
    n = len(needle)
    for i in range(0, len(haystack) - n + 1):
        if haystack[i : i + n] == needle:
            return i
    return -1
