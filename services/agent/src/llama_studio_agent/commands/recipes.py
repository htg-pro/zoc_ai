"""Concrete slash-command recipes.

Each command picks a system prompt and an allowed tool subset, then drives
the orchestrator. The orchestrator does the heavy lifting (planning, tool
execution, repair) — recipes only customise the framing.
"""

from __future__ import annotations

from pydantic import BaseModel, Field
from shared_schema.models import SlashCommandName

from ..agent.orchestrator import OrchestratorConfig
from .registry import SlashCommand

_READ_TOOLS = ("read_file", "list_dir", "search", "ast_query", "index_query")
_WRITE_TOOLS = (*_READ_TOOLS, "write_file", "apply_patch")
_FULL_TOOLS = (*_WRITE_TOOLS, "run_command")


class _Target(BaseModel):
    target: str = Field(description="File, directory, or symbol to operate on.")


class _Query(BaseModel):
    query: str


class ReviewCommand(SlashCommand):
    name = SlashCommandName.review
    summary = "Review the given file/diff and report structured findings."
    Args = _Target

    async def run(self, *, orchestrator, session_id, workspace_root, args):
        prompt = (
            f"Review `{args.target}`. Identify bugs, security issues, perf"
            " regressions, and style violations. Produce findings as JSON"
            " matching the CodeReviewReport schema."
        )
        return await orchestrator.run(
            session_id=session_id,
            workspace_root=workspace_root,
            prompt=prompt,
            config=OrchestratorConfig(allowed_tools=_READ_TOOLS, skip_planner=True),
        )


class TestCommand(SlashCommand):
    name = SlashCommandName.test
    summary = "Generate unit tests for the target and run them until green."
    Args = _Target

    async def run(self, *, orchestrator, session_id, workspace_root, args):
        prompt = (
            f"Generate unit tests for `{args.target}` using the project's"
            " existing test framework. Run the tests with `run_command` and"
            " iterate until they pass or the repair budget is exhausted."
        )
        return await orchestrator.run(
            session_id=session_id,
            workspace_root=workspace_root,
            prompt=prompt,
            config=OrchestratorConfig(allowed_tools=_FULL_TOOLS),
        )


class ExplainCommand(SlashCommand):
    name = SlashCommandName.explain
    summary = "Explain how a piece of code works, in plain prose."
    Args = _Target

    async def run(self, *, orchestrator, session_id, workspace_root, args):
        prompt = (
            f"Explain `{args.target}` to a competent engineer who has not"
            " seen the code before. Cover purpose, key data flows, and"
            " any surprising behaviours."
        )
        return await orchestrator.run(
            session_id=session_id,
            workspace_root=workspace_root,
            prompt=prompt,
            config=OrchestratorConfig(allowed_tools=_READ_TOOLS, skip_planner=True),
        )


class FixCommand(SlashCommand):
    name = SlashCommandName.fix
    summary = "Investigate the reported bug and produce a minimal patch."
    Args = _Query

    async def run(self, *, orchestrator, session_id, workspace_root, args):
        prompt = (
            "Diagnose and fix the following issue. Produce a minimal patch"
            f" via `apply_patch` once you understand the bug.\n\n{args.query}"
        )
        return await orchestrator.run(
            session_id=session_id,
            workspace_root=workspace_root,
            prompt=prompt,
            config=OrchestratorConfig(allowed_tools=_FULL_TOOLS),
        )


class RefactorCommand(SlashCommand):
    name = SlashCommandName.refactor
    summary = "Refactor the target without changing behaviour."
    Args = _Target

    async def run(self, *, orchestrator, session_id, workspace_root, args):
        prompt = (
            f"Refactor `{args.target}` to improve clarity and structure"
            " without changing observable behaviour. Use `apply_patch`."
        )
        return await orchestrator.run(
            session_id=session_id,
            workspace_root=workspace_root,
            prompt=prompt,
            config=OrchestratorConfig(allowed_tools=_WRITE_TOOLS),
        )


class DocsCommand(SlashCommand):
    name = SlashCommandName.docs
    summary = "Add or improve docstrings/comments for the target."
    Args = _Target

    async def run(self, *, orchestrator, session_id, workspace_root, args):
        prompt = (
            f"Add or improve documentation for `{args.target}`. Update"
            " docstrings and comments via `apply_patch`."
        )
        return await orchestrator.run(
            session_id=session_id,
            workspace_root=workspace_root,
            prompt=prompt,
            config=OrchestratorConfig(allowed_tools=_WRITE_TOOLS),
        )


class GrokCommand(SlashCommand):
    name = SlashCommandName.grok
    summary = "Repository-wide Q&A using the workspace index."
    Args = _Query

    async def run(self, *, orchestrator, session_id, workspace_root, args):
        prompt = (
            "Answer the user's repository question. Always consult"
            f" `index_query` first to ground your answer.\n\nQuestion: {args.query}"
        )
        return await orchestrator.run(
            session_id=session_id,
            workspace_root=workspace_root,
            prompt=prompt,
            config=OrchestratorConfig(allowed_tools=_READ_TOOLS, skip_planner=True),
        )
