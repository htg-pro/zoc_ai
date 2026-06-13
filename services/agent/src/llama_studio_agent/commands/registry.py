"""Slash command registry. Each command is a recipe over the orchestrator."""

from __future__ import annotations

import abc
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from pydantic import BaseModel
from shared_schema.models import SlashCommandDescriptor, SlashCommandName

from ..agent.orchestrator import AgentOrchestrator, OrchestratorResult


class SlashCommand(abc.ABC):
    name: SlashCommandName
    summary: str
    Args: type[BaseModel]

    def descriptor(self) -> SlashCommandDescriptor:
        return SlashCommandDescriptor(
            name=self.name, summary=self.summary, args_schema=self.Args.model_json_schema()
        )

    @abc.abstractmethod
    async def run(
        self,
        *,
        orchestrator: AgentOrchestrator,
        session_id: UUID,
        workspace_root: str,
        args: BaseModel,
    ) -> OrchestratorResult:
        ...


@dataclass(slots=True)
class _Entry:
    cmd: SlashCommand


class SlashCommandRegistry:
    def __init__(self) -> None:
        self._entries: dict[SlashCommandName, _Entry] = {}

    def register(self, cmd: SlashCommand) -> None:
        self._entries[cmd.name] = _Entry(cmd=cmd)

    def get(self, name: SlashCommandName | str) -> SlashCommand:
        key = name if isinstance(name, SlashCommandName) else SlashCommandName(name)
        if key not in self._entries:
            raise KeyError(f"unknown slash command: {key.value}")
        return self._entries[key].cmd

    def list(self) -> list[SlashCommandDescriptor]:
        return [e.cmd.descriptor() for e in self._entries.values()]

    async def run(
        self,
        *,
        name: SlashCommandName,
        args: dict[str, Any],
        orchestrator: AgentOrchestrator,
        session_id: UUID,
        workspace_root: str,
    ) -> OrchestratorResult:
        cmd = self.get(name)
        parsed = cmd.Args.model_validate(args or {})
        return await cmd.run(
            orchestrator=orchestrator,
            session_id=session_id,
            workspace_root=workspace_root,
            args=parsed,
        )


# ── recipes ───────────────────────────────────────────────────────────────


from .recipes import (  # noqa: E402
    DocsCommand,
    ExplainCommand,
    FixCommand,
    GrokCommand,
    RefactorCommand,
    ReviewCommand,
    TestCommand,
)


def build_default_registry() -> SlashCommandRegistry:
    reg = SlashCommandRegistry()
    for cmd in (
        ReviewCommand(),
        TestCommand(),
        ExplainCommand(),
        FixCommand(),
        RefactorCommand(),
        DocsCommand(),
        GrokCommand(),
    ):
        reg.register(cmd)
    return reg
