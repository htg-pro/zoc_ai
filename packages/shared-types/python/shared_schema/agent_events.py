"""Zoc AI Ecosystem — Python Event_Contract (generated twin of the TS source).

This module mirrors `packages/shared-types/typescript/src/agent-events.ts`
field-for-field so the FastAPI gateway and the React frontend cannot drift.
It defines the eight flat row kinds streamed over the SSE bus (R6.3) plus the
``AgentEventModel`` discriminated union used by the Gateway emit gate
(``AgentEventModel.model_validate(payload)`` — see design.md "Contract
Validation").

Wire keys are camelCase to match the TS contract (``runId``, ``modelTier``,
``contextWindowTokens``, ``fallbackReason``, ``exitCode``, ``errorTag``). Python
attributes are snake_case with aliases, and ``populate_by_name`` is enabled so
models accept either form.

Spec: .kiro/specs/zocai-ecosystem-rebuild/design.md
      — "Shared Event Schema (packages/shared-types)"
Requirements: 6.2, 6.3 (plus allocator fields R1.6, R1.9 on IntentEvent).
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, RootModel

# ── Discriminator + scalar aliases ─────────────────────────────────────────

#: The eight row kinds. Exactly one per event type (R6.3).
EventType = Literal[
    "intent",
    "thinking",
    "read-files",
    "edit-file",
    "command",
    "summary",
    "approval",
    "done",
]

#: The model tier selected by the Allocator (R1.9).
ModelTier = Literal["local-slm", "edge", "cloud"]


class _EventBase(BaseModel):
    """Fields common to every event. ``seq`` is monotonic and defines order (R6.5)."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    seq: int  # monotonically increasing, defines order (R6.5)
    run_id: str = Field(alias="runId")
    ts: str  # ISO-8601


# ── The eight row kinds ─────────────────────────────────────────────────────

class IntentEvent(_EventBase):
    type: Literal["intent"] = "intent"
    text: str
    model_tier: ModelTier = Field(alias="modelTier")  # R1.9
    context_window_tokens: int = Field(alias="contextWindowTokens")  # R1.9
    fallback_reason: str | None = Field(default=None, alias="fallbackReason")  # R1.6


class ThinkingEvent(_EventBase):
    type: Literal["thinking"] = "thinking"
    text: str
    collapsible: Literal[True] = True  # R3.6


class ReadFileRef(BaseModel):
    """A single file reference inside a read-files event."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    path: str
    span: tuple[int, int] | None = None


class ReadFilesEvent(_EventBase):
    type: Literal["read-files"] = "read-files"
    files: list[ReadFileRef]


class EditFileEvent(_EventBase):
    type: Literal["edit-file"] = "edit-file"
    path: str
    diff: str


class CommandEvent(_EventBase):
    type: Literal["command"] = "command"
    command: str
    exit_code: int | None = Field(default=None, alias="exitCode")
    error_tag: str | None = Field(default=None, alias="errorTag")


class SummaryEvent(_EventBase):
    type: Literal["summary"] = "summary"
    text: str


class ApprovalEvent(_EventBase):
    type: Literal["approval"] = "approval"
    prompt: str
    decision: Literal["approve", "reject"] | None = None


class DoneEvent(_EventBase):
    type: Literal["done"] = "done"
    ok: bool
    reason: str | None = None


# ── Discriminated union + emit-gate entrypoint ──────────────────────────────

#: Discriminated union of all eight row kinds, keyed on the ``type`` field.
AgentEvent = Annotated[
    IntentEvent
    | ThinkingEvent
    | ReadFilesEvent
    | EditFileEvent
    | CommandEvent
    | SummaryEvent
    | ApprovalEvent
    | DoneEvent,
    Field(discriminator="type"),
]


class AgentEventModel(RootModel[AgentEvent]):
    """Validation entrypoint for the SSE emit gate.

    ``AgentEventModel.model_validate(payload)`` validates an arbitrary payload
    against the contract and returns a model whose ``.root`` is the concrete
    typed event. A non-conforming payload raises ``pydantic.ValidationError``,
    which the Gateway converts into a discarded-with-violation outcome (R6.4).
    """


__all__ = [
    "AgentEvent",
    "AgentEventModel",
    "ApprovalEvent",
    "CommandEvent",
    "DoneEvent",
    "EditFileEvent",
    "EventType",
    "IntentEvent",
    "ModelTier",
    "ReadFileRef",
    "ReadFilesEvent",
    "SummaryEvent",
    "ThinkingEvent",
]
