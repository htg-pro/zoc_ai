"""Tool registry assembled at startup."""

from __future__ import annotations

from shared_schema.models import ToolDescriptor

from .ast import AstQueryTool
from .base import Tool
from .filesystem import ApplyPatchTool, ListDirTool, ReadFileTool, WriteFileTool
from .index import IndexQueryTool
from .search import SearchTool
from .shell import RunCommandTool
from .workspace import (
    ActiveFileTool,
    GitDiffTool,
    GitStatusTool,
    GlobFilesTool,
    GrepSearchTool,
    OpenWorkspaceTool,
    ProjectSummaryTool,
    RunTestsTool,
)


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> None:
        self._tools[tool.name] = tool

    def get(self, name: str) -> Tool:
        if name not in self._tools:
            raise KeyError(f"unknown tool: {name}")
        return self._tools[name]

    def names(self) -> list[str]:
        return sorted(self._tools.keys())

    def list(self) -> list[Tool]:
        return [self._tools[n] for n in self.names()]

    def descriptors(self) -> list[ToolDescriptor]:
        return [t.descriptor() for t in self.list()]


def build_default_registry() -> ToolRegistry:
    reg = ToolRegistry()
    for tool in (
        ReadFileTool(),
        WriteFileTool(),
        ListDirTool(),
        ApplyPatchTool(),
        SearchTool(),
        GrepSearchTool(),
        GlobFilesTool(),
        ProjectSummaryTool(),
        OpenWorkspaceTool(),
        ActiveFileTool(),
        RunCommandTool(),
        RunTestsTool(),
        GitStatusTool(),
        GitDiffTool(),
        AstQueryTool(),
        IndexQueryTool(),
    ):
        reg.register(tool)
    return reg
