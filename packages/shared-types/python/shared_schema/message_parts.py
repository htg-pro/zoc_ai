"""Zoc AI Wire_Protocol — Message_Part contract (zoc-agent-chat-rebuild).

The typed contract between Agent_Runtime and Chat_Surface. Replaces the 43
named SSE event types in `agent_events.py`, which is retained only so the
migration reader can parse pre-upgrade conversations (R23.1, R23.2).

Wire keys are camelCase; Python attributes are snake_case with aliases and
`populate_by_name` enabled, matching `agent_events.py`.

Thirteen discriminants. `source` and `compaction` land here in M1 even though
the behaviour that produces them ships in M2, so that every transcript
persisted from M1 onward is shaped by the final union (R7.9).

Requirements: 7.1, 7.2, 7.5, 7.6, 7.7, 7.9, 7.10, 10.10, 10.11, 10.14, 12.8,
12.10, 13.10, 24.1, 34.2
"""

from __future__ import annotations

from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, RootModel, model_validator

# ── Scalars ───────────────────────────────────────────────────────────────

#: Every part discriminant. A Chat_Surface that receives a value outside this
#: set renders a neutral placeholder and logs once per Run (R7.6).
PartType = Literal[
    "text",
    "reasoning",
    "tool-input",
    "tool-output",
    "tool-error",
    "plan",
    "diff",
    "permission-request",
    "run-lifecycle",
    "usage",
    "error",
    "source",
    "compaction",
]

#: Terminal and non-terminal Run states (R7.2, R16.1). `awaiting-approval` is
#: the Plan_Approval pause: a Run that is neither running nor terminal, so the
#: surface never has to infer "waiting" from the absence of parts (R32.8).
RunState = Literal[
    "queued",
    "running",
    "awaiting-approval",
    "completed",
    "cancelled",
    "failed",
    "interrupted",
]

#: The four workspace file actions (R10.10). An enum rather than a pair of
#: booleans so a fifth action is a schema change a reviewer sees.
HunkAction = Literal["create", "modify", "delete", "rename"]
PermissionScope = Literal["call", "run", "workspace"]
PermissionDecision = Literal["approve", "reject", "timeout"]
ToolKind = Literal["read", "write", "execute", "search", "network", "mcp"]

#: The class of effect a tool call has. Ported verbatim from
#: `mode_router.py`'s `Capability`; the Capability_Policy is keyed on it (R32.3).
Capability = Literal["read", "write", "execute"]

#: Which Conversation_Mode a Run was submitted in (R7.11, R32.1). Wire values
#: are lowercase; the surface displays them capitalised.
ConversationMode = Literal["ask", "plan", "agent"]

#: Whether a Source_Attribution entry is a web result or a provider-supplied
#: document. The two values line up with the AI SDK's `source-url` and
#: `source-document` parts, so no translation is needed either way.
SourceKind = Literal["url", "document"]

#: Sentinel `base_digest` for a `create`: distinct from the digest of an empty
#: file, so "did not exist" and "existed and was empty" cannot be confused by
#: rollback (R10.15).
ABSENT_DIGEST = "absent:0"


class PartBase(BaseModel):
    """Fields on every Message_Part.

    `seq` is strictly increasing within a Run and defines order; the
    Chat_Surface detects gaps and duplicates from it alone (R7.7).
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    seq: int = Field(ge=1)
    run_id: str = Field(alias="runId")
    #: The `UIMessage.id` this part belongs to. Sub-agent parts carry the
    #: parent Run's message id and name the sub-agent (R25.5).
    message_id: str = Field(alias="messageId")
    ts: str  # ISO-8601
    #: Sub-agent name when this part came from a spawned agent, else null (R25.5).
    agent_name: str | None = Field(default=None, alias="agentName")


# ── 1. Assistant text ─────────────────────────────────────────────────────


class TextPart(PartBase):
    """An incremental slice of assistant answer text (R8.1).

    `delta` is appended to the part identified by `part_id`; the Chat_Surface
    never re-renders earlier messages to apply one.
    """

    type: Literal["text"] = "text"
    part_id: str = Field(alias="partId")
    delta: str
    #: True on the final slice of this text part.
    done: bool = False


# ── 2. Reasoning ──────────────────────────────────────────────────────────


class ReasoningPart(PartBase):
    """An incremental slice of model reasoning (R8.2, R8.3, R8.4)."""

    type: Literal["reasoning"] = "reasoning"
    part_id: str = Field(alias="partId")
    delta: str
    #: Milliseconds since this reasoning part opened. Drives the live elapsed
    #: readout while streaming (R8.3).
    elapsed_ms: int = Field(alias="elapsedMs", ge=0)
    done: bool = False
    #: Provider-side redaction marker: some providers emit reasoning they will
    #: not return in full. The surface shows the duration without content.
    redacted: bool = False


# ── 3. Tool input ─────────────────────────────────────────────────────────


class ToolInputPart(PartBase):
    """A tool call's arguments, streamed as they are generated (R9.1, R9.3)."""

    type: Literal["tool-input"] = "tool-input"
    tool_call_id: str = Field(alias="toolCallId")
    tool_name: str = Field(alias="toolName")
    kind: ToolKind
    #: Namespaced server id for an MCP tool, else null (R26.2).
    mcp_server: str | None = Field(default=None, alias="mcpServer")
    #: Partial JSON while streaming; complete when `done` is true.
    input_delta: str = Field(alias="inputDelta")
    done: bool = False


# ── 4. Tool output ────────────────────────────────────────────────────────


class ToolOutputPart(PartBase):
    """A completed tool call's result (R9.2, R9.4)."""

    type: Literal["tool-output"] = "tool-output"
    tool_call_id: str = Field(alias="toolCallId")
    #: Wall-clock duration of the tool execution (R9.2, R21.4).
    duration_ms: int = Field(alias="durationMs", ge=0)
    #: One-line collapsed summary (R9.2). Never contains file content.
    summary: str
    #: Full serialised output, shown on expand (R9.3). Bounded server-side.
    output: str
    #: Workspace-relative paths this call read (R9.4).
    read_paths: list[str] = Field(default_factory=list, alias="readPaths")
    #: Workspace-relative paths this call wrote (R9.4).
    written_paths: list[str] = Field(default_factory=list, alias="writtenPaths")
    truncated: bool = False


# ── 5. Tool error ─────────────────────────────────────────────────────────


class ToolErrorPart(PartBase):
    """A failed tool call (R9.6, R6.6).

    `retryable` is what the surface reads to decide whether to offer retry.
    Workspace_Services being unreachable is always retryable and never
    terminates the Run (R6.6).
    """

    type: Literal["tool-error"] = "tool-error"
    tool_call_id: str = Field(alias="toolCallId")
    duration_ms: int = Field(alias="durationMs", ge=0)
    code: str
    message: str
    details: str | None = None
    retryable: bool = False


# ── 6. Plan ───────────────────────────────────────────────────────────────


class PlanFile(BaseModel):
    """One target file in a plan, with its change counts (R10.1)."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    #: The path that will exist *after* this file's action applies. For a
    #: rename that is the target; the origin is `source_path` (R10.14).
    path: str
    action: HunkAction
    #: Set only when `action` is `rename`. Null for the other three.
    source_path: str | None = Field(default=None, alias="sourcePath")
    #: One-sentence reason this file is being changed.
    rationale: str
    added_lines: int = Field(alias="addedLines", ge=0)
    removed_lines: int = Field(alias="removedLines", ge=0)
    hunk_count: int = Field(alias="hunkCount", ge=0)

    @model_validator(mode="after")
    def rename_carries_both_paths(self) -> Self:
        if (self.action == "rename") != (self.source_path is not None):
            raise ValueError("sourcePath is required for rename and forbidden otherwise")
        return self


class PlanPart(PartBase):
    """A multi-file change plan, emitted before any file is written (R10.1).

    Produced by `Output.object()` against the plan schema, so the surface can
    rely on the shape rather than parsing prose.
    """

    type: Literal["plan"] = "plan"
    plan_id: str = Field(alias="planId")
    title: str
    files: list[PlanFile]
    #: The command the runtime will use to verify the change, if any.
    verification_command: str | None = Field(default=None, alias="verificationCommand")

    @model_validator(mode="after")
    def files_are_unique_by_path(self) -> Self:
        paths = [f.path for f in self.files]
        if len(paths) != len(set(paths)):
            raise ValueError("plan files must be unique by path")
        return self


# ── 7. Diff ───────────────────────────────────────────────────────────────


class Hunk(BaseModel):
    """One individually reviewable change region (R10.2, R10.3, R21.5)."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    hunk_id: str = Field(alias="hunkId")
    #: 1-based inclusive line range in the pre-change file. Also the accessible
    #: name's line range (R21.5).
    old_start: int = Field(alias="oldStart", ge=1)
    old_lines: int = Field(alias="oldLines", ge=0)
    new_start: int = Field(alias="newStart", ge=1)
    new_lines: int = Field(alias="newLines", ge=0)
    #: Unified-diff body for this hunk only, without the file header.
    patch: str


class DiffPart(PartBase):
    """One file's diff, split into individually selectable Hunks (R10.2)."""

    type: Literal["diff"] = "diff"
    plan_id: str = Field(alias="planId")
    #: The post-apply path, matching `PlanFile.path` (R10.14).
    path: str
    action: HunkAction
    #: Set only when `action` is `rename`; the path the file moves from.
    source_path: str | None = Field(default=None, alias="sourcePath")
    language: str | None = None
    #: A `create` or `delete` carries exactly one whole-file hunk; a pure
    #: `rename` carries none (R10.12, R10.13, R10.14).
    hunks: list[Hunk]
    #: Content hash of the file as the diff was generated against. The surface
    #: compares it before apply to detect staleness (R10.8). For `create` this
    #: is the `ABSENT_DIGEST` sentinel, which is distinct from the digest of an
    #: empty file so that "did not exist" and "existed and was empty" cannot be
    #: confused by rollback (R10.15).
    base_digest: str = Field(alias="baseDigest")
    #: Set by the runtime when it already knows the file moved under it.
    stale: bool = False


# ── 8. Permission request ─────────────────────────────────────────────────


def _all_permission_scopes() -> list[PermissionScope]:
    """The default scope set a request offers (R11.7).

    A named factory rather than a lambda so the element type is
    ``PermissionScope`` rather than ``str`` — an inline lambda widens it, which
    is a real typing hole on the one field whose values are a grant boundary.
    """
    return ["call", "run", "workspace"]


class PermissionRequestPart(PartBase):
    """A paused side-effecting tool call awaiting a decision (R11.2, R11.5-R11.9)."""

    type: Literal["permission-request"] = "permission-request"
    request_id: str = Field(alias="requestId")
    tool_call_id: str = Field(alias="toolCallId")
    tool_name: str = Field(alias="toolName")
    kind: ToolKind
    #: Human-readable statement of what will happen if approved.
    prompt: str
    #: Workspace-relative paths the call would touch. Announced to screen
    #: readers when focus moves to the request (R21.3).
    paths: list[str] = Field(default_factory=list)
    #: Why approval is required even in `auto` mode: `out-of-plan-path` (R11.5),
    #: `destructive` (R11.6), or `mode-ask` (R11.2).
    reason: Literal["mode-ask", "out-of-plan-path", "destructive"]
    #: Grant scopes the surface may offer for this request (R11.7).
    offered_scopes: list[PermissionScope] = Field(
        default_factory=_all_permission_scopes,
        alias="offeredScopes",
    )
    #: Absolute deadline. The runtime cancels the call at this instant (R11.9).
    expires_at: str = Field(alias="expiresAt")
    #: Populated once decided, so a replayed stream reconstructs the outcome.
    decision: PermissionDecision | None = None
    decided_scope: PermissionScope | None = Field(default=None, alias="decidedScope")


# ── 9. Run lifecycle ──────────────────────────────────────────────────────


class RunLifecyclePart(PartBase):
    """A Run state transition (R7.2, R16.1, R16.5, R25.2)."""

    type: Literal["run-lifecycle"] = "run-lifecycle"
    state: RunState
    #: Set on `queued` — the Run's position in the Slot queue (R25.2).
    queue_position: int | None = Field(default=None, alias="queuePosition")
    #: Required when `state` is `failed` or `interrupted`.
    code: str | None = None
    message: str | None = None
    #: Provider and model actually used, recorded in the transcript (R27.4).
    provider: str | None = None
    model: str | None = None

    @model_validator(mode="after")
    def failure_states_carry_a_code(self) -> Self:
        if self.state in ("failed", "interrupted") and not self.code:
            raise ValueError(f"state {self.state!r} requires a code")
        return self


# ── 10. Usage ─────────────────────────────────────────────────────────────


class UsagePart(PartBase):
    """Token accounting for a Run (R12.5, R12.8, R13.8, R27.1-R27.3).

    Reconciled by `run_id`: each emission replaces the previous total rather
    than adding a row.
    """

    type: Literal["usage"] = "usage"
    input_tokens: int = Field(alias="inputTokens", ge=0)
    output_tokens: int = Field(alias="outputTokens", ge=0)
    reasoning_tokens: int = Field(default=0, alias="reasoningTokens", ge=0)
    cached_input_tokens: int = Field(default=0, alias="cachedInputTokens", ge=0)
    #: The selected model's context limit, for the usage proportion (R27.3).
    context_limit: int = Field(alias="contextLimit", ge=0)
    #: Estimated cost in USD cents; null when the model has no published price.
    estimated_cost_cents: float | None = Field(default=None, alias="estimatedCostCents")
    #: Token_Rate — provider-reported output tokens per second of elapsed
    #: *generation* time (R13.8). Null until the first output token has arrived,
    #: because before that there is no generation interval to divide by.
    tokens_per_second: float | None = Field(default=None, alias="tokensPerSecond", ge=0)
    #: ── The context census R12.8 asks for. ───────────────────────────────
    #: These ride here rather than on `CompactionPart` because R12.8 requires
    #: them for the active Session *always*, including a Session that has never
    #: compacted and therefore has no `CompactionPart` to read them from. A
    #: figure that only exists after a fold is not an indicator, it is an
    #: artefact of one. `UsagePart` is already reconciled by `run_id` and
    #: already carries `context_limit`, so this is the one part that is both
    #: always present and already about context.
    #: Messages the assembled request actually included, and the Session's
    #: total message count.
    messages_in_context: int = Field(default=0, alias="messagesInContext", ge=0)
    session_message_count: int = Field(default=0, alias="sessionMessageCount", ge=0)
    #: Messages that fall outside the window — folded, or trimmed and not yet
    #: folded. `session_message_count - messages_in_context` is *not* a
    #: substitute: a folded message is represented in context by the summary,
    #: so the two figures answer different questions.
    messages_out_of_window: int = Field(default=0, alias="messagesOutOfWindow", ge=0)
    #: True while a pinned compaction summary is part of the assembled context.
    summary_active: bool = Field(default=False, alias="summaryActive")


# ── 11. Error ─────────────────────────────────────────────────────────────


class ErrorPart(PartBase):
    """A renderable Run-level error (R7.5, R16.6).

    Carries the same four fields as the Gateway's `ErrorEnvelope` so one
    normaliser handles both surfaces.
    """

    type: Literal["error"] = "error"
    code: str
    message: str
    details: str | None = None
    retryable: bool = False


# ── 12. Source attribution ────────────────────────────────────────────────


class VisitedSource(BaseModel):
    """One source a Run consulted, whether or not the answer cites it (R7.10)."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    #: Provider-assigned identifier, reused verbatim as the AI SDK `sourceId`,
    #: so the native `source-url` chunk and this entry name the same source.
    source_id: str = Field(alias="sourceId")
    kind: SourceKind = "url"
    #: Set when `kind` is `url`.
    url: str | None = None
    title: str | None = None
    #: IANA media type; set when `kind` is `document`.
    media_type: str | None = Field(default=None, alias="mediaType")


class Citation(BaseModel):
    """One inline citation: a span of answer text and the source it cites (R7.10)."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    #: The `VisitedSource.source_id` this citation points at.
    source_id: str = Field(alias="sourceId")
    #: The text part the cited span lives in, matching `TextPart.part_id`.
    part_id: str = Field(alias="partId")
    #: Half-open character range into that text part's accumulated text.
    start: int = Field(ge=0)
    end: int = Field(ge=0)
    #: The cited text itself, carried so a citation stays renderable even if
    #: the transcript re-flows the text part it annotates.
    quote: str = ""

    @model_validator(mode="after")
    def span_is_ordered(self) -> Self:
        if self.end < self.start:
            raise ValueError("citation end must not precede start")
        return self


class SourcePart(PartBase):
    """Web-search provenance for a Run — Source_Attribution (R7.2, R7.9, R7.10).

    Two **separately addressable** collections, which is the whole of R7.10: a
    source the Run merely consulted lives in `sources` and nowhere else, while a
    source the answer actually cites appears in `citations` bound to the span it
    annotates. Collapsing them into one list would make "consulted" and "cited"
    indistinguishable, which is the distinction the requirement names.

    Reconciled by `run_id`: each emission replaces the previous snapshot rather
    than appending a row, so the Sources row grows in place as results arrive.

    Defined in the M1 schema although the behaviour that fills it ships in M2
    (R7.9) — same reasoning as `agent_name` and the `mcp` tool kind.
    """

    type: Literal["source"] = "source"
    sources: list[VisitedSource] = Field(default_factory=list)
    citations: list[Citation] = Field(default_factory=list)
    #: The provider-native search tool that produced these sources, when the
    #: provider named one.
    tool_name: str | None = Field(default=None, alias="toolName")

    @model_validator(mode="after")
    def citations_name_known_sources(self) -> Self:
        known = {s.source_id for s in self.sources}
        dangling = sorted({c.source_id for c in self.citations} - known)
        if dangling:
            raise ValueError(f"citations reference unlisted sources: {dangling}")
        return self


# ── 13. Compaction record ─────────────────────────────────────────────────


class CompactionPart(PartBase):
    """One context compaction — Compaction_Record (R7.2, R7.9, R34.2).

    Deliberately *not* a banner: the retired-behaviour register's argument
    against `ContextCompressedEvent`'s banner still stands. This is the row that
    replaces it, expandable, naming which turns were folded and showing the
    summary that took their place.

    Not reconciled by `run_id`: a Session compacts more than once over its life
    and each fold is its own transcript row, so the reconciliation id is
    `compaction_id`.
    """

    type: Literal["compaction"] = "compaction"
    compaction_id: str = Field(alias="compactionId")
    #: The message ids folded into `summary`, in transcript order.
    folded_message_ids: list[str] = Field(alias="foldedMessageIds")
    #: How many user turns those messages span — the count the row headlines.
    folded_turn_count: int = Field(alias="foldedTurnCount", ge=1)
    #: Context tokens before and after the fold, so the row can state what the
    #: compaction actually bought.
    context_tokens_before: int = Field(alias="contextTokensBefore", ge=0)
    context_tokens_after: int = Field(alias="contextTokensAfter", ge=0)
    #: The summary text that replaced the folded messages.
    summary: str

    @model_validator(mode="after")
    def the_fold_is_a_reduction(self) -> Self:
        if not self.folded_message_ids:
            raise ValueError("a compaction must fold at least one message")
        if self.context_tokens_after > self.context_tokens_before:
            raise ValueError("compaction must not increase the context token count")
        return self


# ── Union + validation entrypoint ─────────────────────────────────────────

MessagePart = Annotated[
    TextPart
    | ReasoningPart
    | ToolInputPart
    | ToolOutputPart
    | ToolErrorPart
    | PlanPart
    | DiffPart
    | PermissionRequestPart
    | RunLifecyclePart
    | UsagePart
    | ErrorPart
    | SourcePart
    | CompactionPart,
    Field(discriminator="type"),
]


class MessagePartModel(RootModel[MessagePart]):
    """Validation entrypoint for the runtime's emit gate and the HTTP 422 path.

    `MessagePartModel.model_validate(payload)` returns a model whose `.root` is
    the concrete typed part. A non-conforming payload raises
    `pydantic.ValidationError`, which the request handler converts into the
    `code`/`message`/`details`/`retryable` body R7.5 requires.
    """


__all__ = [
    "Capability",
    "Citation",
    "CompactionPart",
    "ConversationMode",
    "DiffPart",
    "ErrorPart",
    "Hunk",
    "HunkAction",
    "MessagePart",
    "MessagePartModel",
    "PartBase",
    "PartType",
    "PermissionDecision",
    "PermissionRequestPart",
    "PermissionScope",
    "PlanFile",
    "PlanPart",
    "ReasoningPart",
    "RunLifecyclePart",
    "RunState",
    "SourceKind",
    "SourcePart",
    "TextPart",
    "ToolErrorPart",
    "ToolInputPart",
    "ToolKind",
    "ToolOutputPart",
    "UsagePart",
    "VisitedSource",
]
