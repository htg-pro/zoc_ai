"""Slash command recipes built on top of the orchestrator."""

from .registry import SlashCommandRegistry, build_default_registry

__all__ = ["SlashCommandRegistry", "build_default_registry"]
