"""Workspace-specific instructions applied to every model run."""

from __future__ import annotations

from pathlib import Path

PROJECT_INSTRUCTIONS_PATH = Path(".zoc") / "instructions.md"


def read_project_instructions(workspace_root: Path | str) -> str:
    """Read the root ``.zoc/instructions.md`` file when it is usable."""
    try:
        root = Path(workspace_root).resolve()
        path = (root / PROJECT_INSTRUCTIONS_PATH).resolve()
        path.relative_to(root)
        return path.read_text(encoding="utf-8").strip()
    except (OSError, RuntimeError, UnicodeDecodeError, ValueError):
        return ""


def prepend_project_instructions(system_prompt: str, instructions: str) -> str:
    """Place project instructions before the built-in system prompt."""
    content = instructions.strip()
    if not content:
        return system_prompt
    return f"{content}\n\n{system_prompt}"
