"""Validated structured planning models for Agent runs."""

from __future__ import annotations

from pathlib import PurePosixPath
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class _PlanModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class SearchReplace(_PlanModel):
    """One exact replacement proposed for a workspace file."""

    search: str
    replace: str


class EditStep(_PlanModel):
    """One workspace-relative edit in the model's ordered plan."""

    file: str
    action: Literal["create", "modify", "delete", "rename"]
    rationale: str
    search_replace: list[SearchReplace] | None = None

    @field_validator("file")
    @classmethod
    def workspace_relative_file(cls, value: str) -> str:
        normalized = value.strip().replace("\\", "/")
        path = PurePosixPath(normalized)
        if not normalized or path.is_absolute() or ".." in path.parts:
            raise ValueError("file must be a workspace-relative path")
        return normalized


class AgentPlan(_PlanModel):
    """Structured plan emitted before concrete file contents are generated."""

    steps: list[EditStep]
    verification_command: str | None = None
    confidence: float = Field(ge=0, le=1)


__all__ = ["AgentPlan", "EditStep", "SearchReplace"]
