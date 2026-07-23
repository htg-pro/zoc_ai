"""Zoc AI Ecosystem — Python Event_Contract (generated twin of the TS source).

This module mirrors `packages/shared-types/typescript/src/agent-events.ts`
field-for-field so the FastAPI gateway and the React frontend cannot drift.
It defines the structured row kinds streamed over the SSE bus (R6.3) plus the
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

from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, RootModel, model_validator

# ── Discriminator + scalar aliases ─────────────────────────────────────────

#: Event kinds with dedicated frontend row components. Validated-only telemetry
#: (for example ``budget`` and ``context-compressed``) intentionally stays out.
EventType = Literal[
    "intent",
    "thinking",
    "plan",
    "plan-update",
    "map-files",
    "read-files",
    "edit-file",
    "command",
    "review",
    "summary",
    "approval",
    "done",
]

#: The model tier selected by the Allocator (R1.9).
ModelTier = Literal["local-slm", "edge", "cloud"]


class BaseEvent(BaseModel):
    """Fields common to every event. ``seq`` is monotonic and defines order (R6.5)."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    seq: int  # monotonically increasing, defines order (R6.5)
    run_id: str = Field(alias="runId")
    ts: str  # ISO-8601


# ── Structured event payloads ───────────────────────────────────────────────

class IntentEvent(BaseEvent):
    type: Literal["intent"] = "intent"
    text: str
    model_tier: ModelTier = Field(alias="modelTier")  # R1.9
    context_window_tokens: int = Field(alias="contextWindowTokens")  # R1.9
    fallback_reason: str | None = Field(default=None, alias="fallbackReason")  # R1.6


class ThinkingEvent(BaseEvent):
    type: Literal["thinking"] = "thinking"
    text: str
    collapsible: Literal[True] = True  # R3.6
    gist: str | None = None
    elapsed_ms: int | None = Field(default=None, alias="elapsedMs")
    truncated: bool = False


PlanItemStatus = Literal["pending", "active", "done"]


class PlanItem(BaseModel):
    """A single live to-do item inside a plan event."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: str
    label: str
    status: PlanItemStatus = "pending"


class PlanEvent(BaseEvent):
    type: Literal["plan"] = "plan"
    items: list[PlanItem]
    checkpoint_id: str | None = Field(default=None, alias="checkpointId")


class PlanUpdateEvent(BaseEvent):
    type: Literal["plan-update"] = "plan-update"
    id: str
    status: PlanItemStatus


class ReadFileRef(BaseModel):
    """A single file reference inside a read-files event."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    path: str
    span: tuple[int, int] | None = None


class MapFilesEvent(BaseEvent):
    """The confined file scope selected before READ_FILES and APPLY_EDITS."""

    type: Literal["map-files"] = "map-files"
    read_list: list[str] = Field(alias="readList", max_length=8)
    write_list: list[str] = Field(alias="writeList")
    rationale: str


class ReadFilesEvent(BaseEvent):
    type: Literal["read-files"] = "read-files"
    files: list[ReadFileRef]


class ContextCompressedEvent(BaseEvent):
    """Token counts emitted after best-effort conversation compression."""

    type: Literal["context-compressed"] = "context-compressed"
    original_tokens: int = Field(alias="originalTokens", gt=0)
    compressed_tokens: int = Field(alias="compressedTokens", ge=0)
    compression_ratio: float = Field(alias="compressionRatio", ge=0, le=1)

    @model_validator(mode="after")
    def compressed_count_does_not_exceed_original(self) -> Self:
        if self.compressed_tokens > self.original_tokens:
            raise ValueError("compressedTokens must not exceed originalTokens")
        return self


class EditFileEvent(BaseEvent):
    type: Literal["edit-file"] = "edit-file"
    path: str
    diff: str
    adds: int = 0
    dels: int = 0
    status: Literal["running", "done", "failed"] = "done"


class CommandEvent(BaseEvent):
    type: Literal["command"] = "command"
    command: str
    command_id: str | None = Field(default=None, alias="commandId")
    status: Literal["queued", "running", "pass", "fail", "skipped"] | None = None
    exit_code: int | None = Field(default=None, alias="exitCode")
    error_tag: str | None = Field(default=None, alias="errorTag")
    output_delta: str | None = Field(default=None, alias="outputDelta")
    output_tail: str | None = Field(default=None, alias="outputTail")


ReviewCheckStatus = Literal["pass", "fail", "skipped", "running"]


class ReviewCheck(BaseModel):
    """Status for one validation lane shown in the review gate."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    status: ReviewCheckStatus
    output: str | None = None


class ReviewValidation(BaseModel):
    """Validation badges attached to a review event."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    typecheck: ReviewCheck = Field(default_factory=lambda: ReviewCheck(status="skipped"))
    build: ReviewCheck = Field(default_factory=lambda: ReviewCheck(status="skipped"))
    tests: ReviewCheck = Field(default_factory=lambda: ReviewCheck(status="skipped"))


class ReviewFile(BaseModel):
    """A single file diff offered for review-before-apply."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    path: str
    diff: str
    adds: int = 0
    dels: int = 0
    summary: str | None = None


class ReviewEvent(BaseEvent):
    type: Literal["review"] = "review"
    files: list[ReviewFile]
    validation: ReviewValidation = Field(default_factory=ReviewValidation)
    checkpoint_id: str | None = Field(default=None, alias="checkpointId")


class SummaryEvent(BaseEvent):
    type: Literal["summary"] = "summary"
    text: str


class ApprovalEvent(BaseEvent):
    type: Literal["approval"] = "approval"
    prompt: str
    decision: Literal["approve", "reject"] | None = None


class RecoveryAttemptEvent(BaseEvent):
    type: Literal["recovery-attempt"] = "recovery-attempt"
    attempt: int = Field(ge=1)
    failures: list[str]


class BudgetEvent(BaseEvent):
    """Latest run-scoped execution and context-budget usage."""

    type: Literal["budget"] = "budget"
    tokens_used: int = Field(alias="tokensUsed", ge=0)
    token_limit: int = Field(alias="tokenLimit", ge=0)
    iterations: int = Field(ge=0)
    recoveries: int = Field(ge=0)


class TestResultsEvent(BaseEvent):
    """Result of the project test command run after Agent edits."""

    type: Literal["test-results"] = "test-results"
    status: Literal["pass", "fail"]
    command: str
    source: str
    passed: int = Field(ge=0)
    failed: int = Field(ge=0)
    exit_code: int = Field(alias="exitCode")
    output_tail: str = Field(default="", alias="outputTail")
    duration_ms: int = Field(default=0, alias="durationMs", ge=0)
    timed_out: bool = Field(default=False, alias="timedOut")


class DoneEvent(BaseEvent):
    type: Literal["done"] = "done"
    ok: bool
    reason: str | None = None


# ── Discriminated union + emit-gate entrypoint ──────────────────────────────

#: Discriminated union of every validated structured event, keyed on ``type``.
AgentEvent = Annotated[
    IntentEvent
    | ThinkingEvent
    | PlanEvent
    | PlanUpdateEvent
    | MapFilesEvent
    | ReadFilesEvent
    | ContextCompressedEvent
    | EditFileEvent
    | CommandEvent
    | ReviewEvent
    | SummaryEvent
    | ApprovalEvent
    | RecoveryAttemptEvent
    | BudgetEvent
    | TestResultsEvent
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
    "BaseEvent",
    "BudgetEvent",
    "CommandEvent",
    "ContextCompressedEvent",
    "DoneEvent",
    "EditFileEvent",
    "EventType",
    "IntentEvent",
    "MapFilesEvent",
    "ModelTier",
    "PlanEvent",
    "PlanItem",
    "PlanItemStatus",
    "PlanUpdateEvent",
    "ReadFileRef",
    "ReadFilesEvent",
    "RecoveryAttemptEvent",
    "ReviewCheck",
    "ReviewCheckStatus",
    "ReviewEvent",
    "ReviewFile",
    "ReviewValidation",
    "SummaryEvent",
    "TestResultsEvent",
    "ThinkingEvent",
]
