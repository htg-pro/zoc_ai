"""Workspace-aware tools for agentic project inspection."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field
from shared_schema.models import PermissionScope

from .base import Tool, ToolContext
from .filesystem import ListDirInput, ListDirTool, ReadFileInput, ReadFileTool
from .sandbox import SandboxLimits, resolve_path
from .search import SearchInput, SearchTool

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
    ".llama-studio-agent",
}

_PACKAGE_FILES = (
    "package.json",
    "pnpm-workspace.yaml",
    "vite.config.ts",
    "tsconfig.json",
    "Cargo.toml",
    "pyproject.toml",
    "requirements.txt",
    "README.md",
    "apps/frontend/package.json",
    "services/agent/pyproject.toml",
    "apps/desktop/Cargo.toml",
)


def _rel(root: Path, path: Path) -> str:
    try:
        return str(path.relative_to(root))
    except ValueError:
        return str(path)


def _is_ignored(path: Path, root: Path) -> bool:
    try:
        parts = path.relative_to(root).parts
    except ValueError:
        return True
    return any(part in _IGNORE_DIRS for part in parts)


def _safe_read(path: Path, limit: int = 12_000) -> str | None:
    try:
        if not path.exists() or not path.is_file() or path.stat().st_size > 1_000_000:
            return None
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    return text[:limit]


def _json_dependencies(text: str) -> dict[str, list[str]]:
    try:
        data = json.loads(text)
    except ValueError:
        return {}
    out: dict[str, list[str]] = {}
    for key in ("dependencies", "devDependencies", "peerDependencies"):
        deps = data.get(key)
        if isinstance(deps, dict):
            out[key] = sorted(str(name) for name in deps)
    scripts = data.get("scripts")
    if isinstance(scripts, dict):
        out["scripts"] = sorted(str(name) for name in scripts)
    return out


def build_project_summary(workspace_root: str, *, max_files: int = 240) -> dict[str, Any]:
    root = Path(workspace_root).expanduser().resolve()
    summary: dict[str, Any] = {
        "workspace_root": str(root),
        "exists": root.exists(),
        "frameworks": [],
        "top_level": [],
        "package_files": {},
        "important_files": [],
        "source_dirs": [],
        "potential_issues": [],
    }
    if not root.exists() or not root.is_dir():
        summary["potential_issues"].append("Workspace path does not exist or is not a directory.")
        return summary

    top_level: list[dict[str, Any]] = []
    for path in sorted(root.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
        if _is_ignored(path, root):
            continue
        item: dict[str, Any] = {
            "path": _rel(root, path),
            "kind": "dir" if path.is_dir() else "file",
        }
        if path.is_file():
            item["bytes"] = path.stat().st_size
        top_level.append(item)
    summary["top_level"] = top_level[:200]

    package_info: dict[str, Any] = {}
    frameworks: set[str] = set()
    for rel_path in _PACKAGE_FILES:
        path = root / rel_path
        text = _safe_read(path)
        if text is None:
            continue
        info: dict[str, Any] = {"bytes": path.stat().st_size}
        if path.name == "package.json":
            deps = _json_dependencies(text)
            info.update(deps)
            dep_names = set().union(*(set(v) for k, v in deps.items() if k != "scripts"))
            if "react" in dep_names:
                frameworks.add("React")
            if "vite" in dep_names or (root / "vite.config.ts").exists():
                frameworks.add("Vite")
            if "@tauri-apps/api" in dep_names:
                frameworks.add("Tauri")
            if "zustand" in dep_names:
                frameworks.add("Zustand")
            if "tailwindcss" in dep_names:
                frameworks.add("Tailwind CSS")
        elif path.name == "pyproject.toml":
            if "fastapi" in text.lower():
                frameworks.add("FastAPI")
            if "pytest" in text.lower():
                frameworks.add("pytest")
        elif path.name == "Cargo.toml":
            if "tauri" in text.lower():
                frameworks.add("Tauri")
            frameworks.add("Rust")
        elif path.name == "README.md":
            info["preview"] = "\n".join(text.splitlines()[:12])
        package_info[rel_path] = info

    for name in ("src", "apps", "services", "packages", "crates"):
        path = root / name
        if path.exists() and path.is_dir():
            summary["source_dirs"].append(name)

    important: list[dict[str, Any]] = []
    for path in sorted(root.rglob("*")):
        if len(important) >= max_files:
            break
        if _is_ignored(path, root) or not path.is_file():
            continue
        if path.suffix.lower() in {
            ".ts",
            ".tsx",
            ".js",
            ".jsx",
            ".py",
            ".rs",
            ".json",
            ".toml",
            ".md",
            ".css",
        }:
            important.append({"path": _rel(root, path), "bytes": path.stat().st_size})

    if not package_info:
        summary["potential_issues"].append("No common package/config files found at the workspace root.")
    if not important:
        summary["potential_issues"].append("No source files found after ignoring generated directories.")

    summary["frameworks"] = sorted(frameworks)
    summary["package_files"] = package_info
    summary["important_files"] = important[:max_files]
    return summary


class GrepSearchTool(SearchTool):
    name = "grep_search"
    description = "Ripgrep-style regex search across the workspace, honoring .gitignore."
    Input = SearchInput


class GlobFilesInput(BaseModel):
    pattern: str = Field(default="**/*", description="Glob pattern relative to the workspace root.")
    path: str = Field(default=".", description="Subdirectory relative to the workspace root.")
    max_results: int = Field(default=500, ge=1, le=5000)


class GlobFilesTool(Tool[GlobFilesInput, list[str]]):
    name = "glob_files"
    description = "Find files matching a glob pattern inside the workspace."
    Input = GlobFilesInput
    requires_scopes = (PermissionScope.read_fs,)
    sandbox_limits = SandboxLimits.LIST

    async def run(self, ctx: ToolContext, args: GlobFilesInput) -> list[str]:
        root = Path(ctx.workspace_root).expanduser().resolve()
        base = resolve_path(ctx.workspace_root, args.path)
        out: list[str] = []
        for path in sorted(base.glob(args.pattern)):
            if len(out) >= args.max_results:
                break
            if _is_ignored(path, root) or not path.is_file():
                continue
            out.append(_rel(root, path))
        return out


class ProjectSummaryInput(BaseModel):
    path: str = Field(default=".", description="Workspace subdirectory to summarize.")
    max_files: int = Field(default=240, ge=20, le=1000)


class ProjectSummaryTool(Tool[ProjectSummaryInput, dict[str, Any]]):
    name = "get_project_summary"
    description = "Inspect project files, package metadata, source directories, frameworks, and likely issues."
    Input = ProjectSummaryInput
    requires_scopes = (PermissionScope.read_fs,)
    sandbox_limits = SandboxLimits.READ

    async def run(self, ctx: ToolContext, args: ProjectSummaryInput) -> dict[str, Any]:
        target = resolve_path(ctx.workspace_root, args.path)
        return build_project_summary(str(target), max_files=args.max_files)


class OpenWorkspaceInput(BaseModel):
    include_top_level: bool = True


class OpenWorkspaceTool(Tool[OpenWorkspaceInput, dict[str, Any]]):
    name = "get_open_workspace"
    description = "Return the current workspace root and, optionally, top-level entries."
    Input = OpenWorkspaceInput
    requires_scopes = (PermissionScope.read_fs,)
    sandbox_limits = SandboxLimits.LIST

    async def run(self, ctx: ToolContext, args: OpenWorkspaceInput) -> dict[str, Any]:
        root = Path(ctx.workspace_root).expanduser().resolve()
        data: dict[str, Any] = {"workspace_root": str(root), "exists": root.exists()}
        if args.include_top_level and root.exists():
            data["top_level"] = await ListDirTool().run(ctx, ListDirInput(path=".", max_entries=200))
        return data


class ActiveFileInput(BaseModel):
    include_content: bool = True


class ActiveFileTool(Tool[ActiveFileInput, dict[str, Any]]):
    name = "get_active_file"
    description = "Return the active editor file path, selected text, and current unsaved editor content."
    Input = ActiveFileInput
    requires_scopes = (PermissionScope.read_fs,)
    sandbox_limits = SandboxLimits.READ

    async def run(self, ctx: ToolContext, args: ActiveFileInput) -> dict[str, Any]:
        data: dict[str, Any] = {
            "active_file": ctx.active_file,
            "selected_text": ctx.selected_text,
            "has_editor_content": bool(ctx.editor_content),
        }
        if args.include_content:
            if ctx.editor_content is not None:
                data["content"] = ctx.editor_content
                data["source"] = "editor"
            elif ctx.active_file:
                data.update(
                    await ReadFileTool().run(
                        ctx,
                        ReadFileInput(path=ctx.active_file, start_line=None, end_line=None),
                    )
                )
                data["source"] = "workspace"
        return data


class GitStatusInput(BaseModel):
    porcelain: bool = True


class GitStatusTool(Tool[GitStatusInput, dict[str, Any]]):
    name = "get_git_status"
    description = "Return git status for the workspace."
    Input = GitStatusInput
    requires_scopes = (PermissionScope.read_fs,)
    sandbox_limits = SandboxLimits.RUN_COMMAND

    async def run(self, ctx: ToolContext, args: GitStatusInput) -> dict[str, Any]:
        cmd = ["git", "status", "--short" if args.porcelain else "--branch"]
        return _run_readonly(cmd, ctx.workspace_root, timeout=10)


class GitDiffInput(BaseModel):
    staged: bool = False
    max_bytes: int = Field(default=80_000, ge=1000, le=500_000)


class GitDiffTool(Tool[GitDiffInput, dict[str, Any]]):
    name = "get_git_diff"
    description = "Return the current git diff for the workspace."
    Input = GitDiffInput
    requires_scopes = (PermissionScope.read_fs,)
    sandbox_limits = SandboxLimits.RUN_COMMAND

    async def run(self, ctx: ToolContext, args: GitDiffInput) -> dict[str, Any]:
        cmd = ["git", "diff", "--staged"] if args.staged else ["git", "diff"]
        result = _run_readonly(cmd, ctx.workspace_root, timeout=15)
        output = str(result.get("stdout") or "")
        truncated = len(output.encode("utf-8")) > args.max_bytes
        result["stdout"] = output[: args.max_bytes]
        result["truncated"] = truncated
        return result


class RunTestsInput(BaseModel):
    max_commands: int = Field(default=4, ge=1, le=12)
    timeout_ms: int = Field(default=120_000, ge=1000, le=10 * 60_000)


class RunTestsTool(Tool[RunTestsInput, dict[str, Any]]):
    name = "run_tests"
    description = "Discover and run the workspace validation suite (TypeScript, build, Python, Rust/Tauri as applicable)."
    Input = RunTestsInput
    requires_scopes = (PermissionScope.run_command,)
    destructive = True
    sandbox_limits = SandboxLimits.RUN_COMMAND

    async def run(self, ctx: ToolContext, args: RunTestsInput) -> dict[str, Any]:
        from ..agent.validation import discover_validation_commands

        root = Path(ctx.workspace_root).expanduser().resolve()
        commands = discover_validation_commands(root)[: args.max_commands]
        results = []
        for item in commands:
            completed = subprocess.run(
                item.cmd,
                cwd=str(item.cwd),
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=max(1, args.timeout_ms // 1000),
                check=False,
            )
            results.append(
                {
                    "label": item.label,
                    "command": " ".join(item.cmd),
                    "exit_code": completed.returncode,
                    "output": completed.stdout[-24_000:],
                }
            )
            if completed.returncode != 0:
                break
        return {"ok": all(r["exit_code"] == 0 for r in results), "results": results}


def _run_readonly(cmd: list[str], cwd: str, *, timeout: int) -> dict[str, Any]:
    try:
        completed = subprocess.run(
            cmd,
            cwd=str(Path(cwd).expanduser().resolve()),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"exit_code": 1, "stdout": "", "error": str(exc)}
    return {
        "exit_code": completed.returncode,
        "stdout": completed.stdout,
        "error": None if completed.returncode == 0 else completed.stdout[-2000:],
    }
