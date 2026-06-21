"""Core shared models. Pydantic v2.

Authoritative schema for all wire types crossing the FastAPI ↔ Tauri/React
boundary. Mirror in `packages/shared-types/typescript/src/index.ts` whenever
this file changes.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Annotated, Any, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field


class _Base(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


# ── Health ────────────────────────────────────────────────────────────────

class HealthResponse(_Base):
    status: str
    version: str


# ── Messages ──────────────────────────────────────────────────────────────

class MessageRole(str, Enum):
    user = "user"
    assistant = "assistant"
    system = "system"
    tool = "tool"


class Message(_Base):
    id: UUID = Field(default_factory=uuid4)
    role: MessageRole
    content: str
    name: str | None = None  # tool name for tool-role messages
    tool_call_id: UUID | None = None
    created_at: datetime = Field(default_factory=datetime.utcnow)


class OpenFileContext(_Base):
    path: str
    name: str | None = None
    language: str | None = None
    content: str | None = None
    dirty: bool = False


# ── Tool calls ────────────────────────────────────────────────────────────

class ToolCallStatus(str, Enum):
    pending = "pending"
    running = "running"
    succeeded = "succeeded"
    failed = "failed"
    cancelled = "cancelled"
    needs_approval = "needs_approval"


class ToolCall(_Base):
    id: UUID = Field(default_factory=uuid4)
    name: str
    arguments: dict[str, Any]
    status: ToolCallStatus = ToolCallStatus.pending
    result: Any | None = None
    error: str | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None


# ── Plans ─────────────────────────────────────────────────────────────────

class PlanStepStatus(str, Enum):
    pending = "pending"
    running = "running"
    done = "done"
    failed = "failed"
    repairing = "repairing"
    skipped = "skipped"


class PlanStep(_Base):
    id: UUID = Field(default_factory=uuid4)
    title: str
    detail: str | None = None
    status: PlanStepStatus = PlanStepStatus.pending
    attempt: int = 0
    error: str | None = None
    # Convenience boolean kept for backward compat with Phase 1 schema.
    done: bool = False


class Plan(_Base):
    id: UUID = Field(default_factory=uuid4)
    goal: str
    steps: list[PlanStep] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=datetime.utcnow)


# ── Diff patches ──────────────────────────────────────────────────────────

class DiffPatch(_Base):
    id: UUID = Field(default_factory=uuid4)
    file_path: str
    unified_diff: str
    summary: str | None = None


# ── Inline edit (Cmd-K) ───────────────────────────────────────────────────

class InlineEditResult(_Base):
    """Result of an inline-edit request: the rewritten replacement for the
    user's selection. The frontend splices this back into the file and routes
    the change through the normal diff-review/apply flow."""

    edited: str


# ── Project rules (.zoc/rules) ────────────────────────────────────────────

class ProjectRulesInfo(_Base):
    """Whether per-project agent rules are active for a session, and which
    files they came from."""

    active: bool = False
    sources: list[str] = Field(default_factory=list)
    rules: str = ""


# ── Checkpoints (restore points) ──────────────────────────────────────────

class CheckpointInfo(_Base):
    """A restorable checkpoint captured before an agent run's changes were
    applied. `run_id` is the restore handle (POST /runs/{run_id}/restore)."""

    run_id: str
    label: str = ""
    created_at: str = ""
    files: list[str] = Field(default_factory=list)


# ── Context mentions (@ picker) ───────────────────────────────────────────

class ContextCandidate(_Base):
    """A candidate for the `@` context picker: a file, folder, or code symbol."""

    kind: Literal["file", "folder", "symbol"]
    label: str
    path: str
    detail: str | None = None
    line: int | None = None


# ── Local model benchmarks ───────────────────────────────────────────────

class RunModelBenchmarkRequest(_Base):
    """Run the fixed benchmark suite against an already-loaded local model."""

    model_id: str = Field(alias="modelId", min_length=1, max_length=500)
    model_name: str = Field(alias="modelName", min_length=1, max_length=200)
    base_url: str = Field(alias="baseUrl", min_length=1, max_length=1000)


class ModelBenchmarkPromptResult(_Base):
    prompt_id: str = Field(alias="promptId")
    label: str
    time_to_first_token_ms: float = Field(alias="timeToFirstTokenMs", ge=0)
    tokens_per_second: float = Field(alias="tokensPerSecond", ge=0)
    quality_score: float = Field(alias="qualityScore", ge=0, le=100)
    output_tokens: int = Field(alias="outputTokens", ge=0)
    error: str | None = None


class ModelBenchmarkRun(_Base):
    id: str
    model_id: str = Field(alias="modelId")
    model_name: str = Field(alias="modelName")
    created_at: str = Field(alias="createdAt")
    duration_seconds: float = Field(alias="durationSeconds", ge=0)
    average_time_to_first_token_ms: float = Field(
        alias="averageTimeToFirstTokenMs",
        ge=0,
    )
    average_tokens_per_second: float = Field(alias="averageTokensPerSecond", ge=0)
    average_quality_score: float = Field(alias="averageQualityScore", ge=0, le=100)
    prompts: list[ModelBenchmarkPromptResult] = Field(default_factory=list)


class ModelBenchmarkHistory(_Base):
    model_id: str = Field(alias="modelId")
    runs: list[ModelBenchmarkRun] = Field(default_factory=list)


# ── Sessions ──────────────────────────────────────────────────────────────

class SessionStatus(str, Enum):
    active = "active"
    idle = "idle"
    closed = "closed"


class Session(_Base):
    id: UUID = Field(default_factory=uuid4)
    title: str
    status: SessionStatus = SessionStatus.active
    workspace_root: str
    provider: str | None = None
    model: str | None = None
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    messages: list[Message] = Field(default_factory=list)
    plan: Plan | None = None
    tool_calls: list[ToolCall] = Field(default_factory=list)


# ── Providers / models registry ───────────────────────────────────────────

class ProviderKind(str, Enum):
    llamacpp = "llamacpp"
    openai = "openai"
    anthropic = "anthropic"
    gemini = "gemini"
    mock = "mock"


# ── Memory ────────────────────────────────────────────────────────────────


class MemoryStats(_Base):
    """Snapshot of how the orchestrator filled the model's context window.

    Surfaced in the run-agent response and at GET /sessions/{id}/memory-stats
    so the UI can render a usage indicator and decide when to suggest
    compaction or a model switch.
    """

    context_window: int
    tokens_used: int
    tokens_available: int
    messages_in_context: int
    total_messages: int
    dropped_messages: int
    has_summary: bool = False


class ContextStatus(MemoryStats):
    """Extended context status with model recommendations and action flags."""

    model: str
    recommended_model: str | None = None
    can_continue: bool = True
    compaction_available: bool = False
    usage_percent: float = 0.0


class ModelCapability(_Base):
    context_window: int
    supports_tools: bool = False
    supports_vision: bool = False
    supports_streaming: bool = True
    supports_embeddings: bool = False


class ModelDescriptor(_Base):
    provider: ProviderKind
    model_id: str
    display_name: str
    capability: ModelCapability


class ProviderDescriptor(_Base):
    kind: ProviderKind
    display_name: str
    base_url: str | None = None
    requires_api_key: bool = False
    models: list[ModelDescriptor] = Field(default_factory=list)


# ── Permissions ───────────────────────────────────────────────────────────

class PermissionScope(str, Enum):
    read_fs = "read_fs"
    write_fs = "write_fs"
    run_command = "run_command"
    network = "network"


class PermissionGrant(_Base):
    scope: PermissionScope
    granted: bool
    note: str | None = None


class ToolGrant(_Base):
    """A per-tool approval override.

    Tracked alongside the coarser scope grants so a user can approve a
    single tool (e.g. `run_command`) without unlocking every other tool
    that shares the same scope. `once` marks an "allow once" grant that is
    consumed the first time the tool runs.
    """

    tool: str
    granted: bool
    once: bool = False
    note: str | None = None


# ── Tools ─────────────────────────────────────────────────────────────────

class ToolDescriptor(_Base):
    name: str
    description: str
    json_schema: dict[str, Any]
    destructive: bool = False
    requires_approval: bool = False
    requires_scopes: list[PermissionScope] = Field(default_factory=list)


class ToolResult(_Base):
    ok: bool
    data: Any | None = None
    error: str | None = None


# ── Slash commands ────────────────────────────────────────────────────────

class SlashCommandName(str, Enum):
    review = "review"
    test = "test"
    explain = "explain"
    fix = "fix"
    refactor = "refactor"
    docs = "docs"
    grok = "grok"


class SlashCommandDescriptor(_Base):
    name: SlashCommandName
    summary: str
    args_schema: dict[str, Any]


# ── Code review findings ──────────────────────────────────────────────────

class FindingSeverity(str, Enum):
    info = "info"
    low = "low"
    medium = "medium"
    high = "high"
    critical = "critical"


class CodeReviewFinding(_Base):
    file: str
    line: int
    severity: FindingSeverity
    message: str
    suggestion: str | None = None
    patch: DiffPatch | None = None


class CodeReviewReport(_Base):
    findings: list[CodeReviewFinding] = Field(default_factory=list)
    summary: str | None = None


# ── Test generation result ────────────────────────────────────────────────

class TestGenerationResult(_Base):
    framework: str
    target: str
    test_file: str
    test_source: str
    passed: bool
    attempts: int
    last_output: str | None = None


# ── Indexer ───────────────────────────────────────────────────────────────

class IndexChunk(_Base):
    id: str
    file: str
    start_line: int
    end_line: int
    symbol: str | None = None
    text: str


class IndexQueryResult(_Base):
    chunk: IndexChunk
    score: float


class EmbedderInfo(_Base):
    # Backing model family: "hash", "openai", "llamacpp", …
    kind: str
    # Concrete model id, or None for the dependency-free hash embedder.
    model: str | None = None
    dim: int
    # True when semantic search is running on the offline hash fallback,
    # which gives much weaker results than a real embedding model.
    is_fallback: bool = False


class IndexStatus(_Base):
    workspace_root: str
    file_count: int
    chunk_count: int
    last_indexed_at: datetime | None = None
    watching: bool = False
    embedder: EmbedderInfo | None = None


class IndexConfig(_Base):
    # Folder that gets scanned/indexed for the session.
    workspace_root: str
    # Glob/name patterns skipped during indexing (e.g. "node_modules", "*.log").
    exclude_globs: list[str] = Field(default_factory=list)
    # Whether a file watcher is (or should be) running for incremental reindex.
    watch: bool = False


class UpdateIndexConfigRequest(_Base):
    workspace_root: str | None = None
    exclude_globs: list[str] | None = None
    watch: bool | None = None


# ── Settings ──────────────────────────────────────────────────────────────

class EmbeddingProvider(str, Enum):
    auto = "auto"
    openai = "openai"
    llamacpp = "llamacpp"
    hash = "hash"


class EmbeddingSettings(_Base):
    provider: EmbeddingProvider = EmbeddingProvider.auto
    model: str | None = None


class SettingsSnapshot(_Base):
    embedding: EmbeddingSettings


class UpdateSettingsRequest(_Base):
    embedding: EmbeddingSettings | None = None


# ── Terminal sessions ─────────────────────────────────────────────────────

class TerminalSessionStatus(str, Enum):
    running = "running"
    exited = "exited"


class TerminalSession(_Base):
    id: UUID = Field(default_factory=uuid4)
    cmd: str
    args: list[str] = Field(default_factory=list)
    cwd: str | None = None
    status: TerminalSessionStatus = TerminalSessionStatus.running
    exit_code: int | None = None
    created_at: datetime = Field(default_factory=datetime.utcnow)


# ── Agent / SSE events ────────────────────────────────────────────────────

class AgentEventBase(_Base):
    session_id: UUID
    seq: int
    at: datetime = Field(default_factory=datetime.utcnow)
    run_id: str | None = None


class TokenEvent(AgentEventBase):
    type: Literal["token"] = "token"
    delta: str


class MessageDeltaEvent(AgentEventBase):
    type: Literal["message.delta"] = "message.delta"
    delta: str
    message_id: UUID | None = None


class MessageEvent(AgentEventBase):
    type: Literal["message"] = "message"
    message: Message


class AgentLifecycleEvent(AgentEventBase):
    type: Literal[
        "agent.started",
        "agent.context.loading",
        "agent.context.ready",
        "agent.completed",
        "agent.error",
    ]
    message: str | None = None
    detail: str | None = None


class PlanEvent(AgentEventBase):
    type: Literal["plan"] = "plan"
    plan: Plan


class PlanCreatedEvent(AgentEventBase):
    type: Literal["plan.created"] = "plan.created"
    plan: Plan


class PlanStepEvent(AgentEventBase):
    type: Literal["plan_step"] = "plan_step"
    step: PlanStep


class ToolCallEvent(AgentEventBase):
    type: Literal["tool_call"] = "tool_call"
    tool_call: ToolCall


class ToolStartedEvent(AgentEventBase):
    type: Literal["tool.started"] = "tool.started"
    tool_call: ToolCall


class ToolCompletedEvent(AgentEventBase):
    type: Literal["tool.completed"] = "tool.completed"
    tool_call: ToolCall


class DiffEvent(AgentEventBase):
    type: Literal["diff"] = "diff"
    patch: DiffPatch


class TestLifecycleEvent(AgentEventBase):
    type: Literal["test.started", "test.completed"]
    name: str
    command: str | None = None
    ok: bool | None = None
    output: str | None = None


class LogEvent(AgentEventBase):
    type: Literal["log"] = "log"
    level: Literal["debug", "info", "warning", "error"]
    message: str


class ErrorEvent(AgentEventBase):
    type: Literal["error"] = "error"
    message: str
    detail: str | None = None


class DoneEvent(AgentEventBase):
    type: Literal["done"] = "done"
    ok: bool
    summary: str | None = None


# ── Live agent-authored to-do list (Cursor/Claude Code TodoWrite pattern) ──

class TodoStatus(str, Enum):
    pending = "pending"
    in_progress = "in_progress"
    completed = "completed"


class TodoItem(_Base):
    id: str
    content: str
    status: TodoStatus = TodoStatus.pending


class TodoUpdateEvent(AgentEventBase):
    """Full snapshot of the agent's live to-do list. Fired any time the
    LLM calls the `todo_write` tool. The UI renders the latest `todos[]`
    snapshot — there is no separate per-step event."""

    type: Literal["todo_update"] = "todo_update"
    todos: list[TodoItem] = Field(default_factory=list)


# ── Unified run lifecycle events (redesign Part 4) ─────────────────────────
# These rename/collapse the older `agent.*` lifecycle events into a single
# run-scoped vocabulary. Emitted additively alongside the legacy events so
# existing consumers keep working during the migration.

class RunLifecycleEvent(AgentEventBase):
    type: Literal[
        "run.started",
        "run.context_ready",
        "run.awaiting_review",
        "run.applied",
        "run.discarded",
        "run.error",
    ]
    # Correlates the run across SSE events and the apply/discard endpoints.
    run_id: str | None = None
    # "ask" | "agent" — carried on run.started so the UI can branch.
    mode: str | None = None
    message: str | None = None
    detail: str | None = None
    # Number of changed files, set on run.awaiting_review / run.applied.
    changed_files: int | None = None


class CheckpointCreatedEvent(AgentEventBase):
    """Fired once, right before the first file-mutating tool call in a run,
    so the UI can offer rollback. `checkpoint_id` references a snapshot the
    backend can restore from."""

    type: Literal["checkpoint.created"] = "checkpoint.created"
    run_id: str | None = None
    checkpoint_id: str
    label: str | None = None


class DiffReadyEvent(AgentEventBase):
    """Aggregated diff for a finished run, fired once at run end when files
    changed. Complements the per-write `diff` events with a single summary."""

    type: Literal["diff.ready"] = "diff.ready"
    run_id: str | None = None
    patches: list[DiffPatch] = Field(default_factory=list)
    validation: dict[str, str] = Field(default_factory=dict)


# ── API requests ──────────────────────────────────────────────────────────

class CreateSessionRequest(_Base):
    title: str
    workspace_root: str
    provider: str | None = None
    model: str | None = None


class UpdateSessionRequest(_Base):
    title: str | None = None
    provider: str | None = None
    model: str | None = None


class PostMessageRequest(_Base):
    content: str
    role: MessageRole = MessageRole.user


class RunAgentRequest(_Base):
    # Backward compatible with the old `{ prompt }` shape while accepting
    # the richer Cursor-style request sent by the frontend.
    prompt: str | None = None
    message: str | None = None
    session_id: UUID | None = Field(default=None, alias="sessionId")
    # Optional client-supplied run id. When absent the backend mints one
    # (uuid4 hex) so every run — isolated/review or direct — has a stable id
    # that is returned in the response and stamped onto its emitted events.
    run_id: str | None = Field(default=None, alias="runId")
    workspace_path: str | None = Field(default=None, alias="workspacePath")
    active_file: str | None = Field(default=None, alias="activeFile")
    open_files: list[OpenFileContext] = Field(default_factory=list, alias="openFiles")
    selected_text: str | None = Field(default=None, alias="selectedText")
    editor_content: str | None = Field(default=None, alias="editorContent")
    mode: str | None = "agent"
    model: str | None = None
    # Bring-your-own cloud provider (redesign): when the frontend selects a
    # model from a configured cloud provider it passes its OpenAI-compatible
    # base URL + key so the run routes there directly, without the key ever
    # being baked into the sidecar's env.
    provider: str | None = None
    api_key: str | None = Field(default=None, alias="apiKey")
    base_url: str | None = Field(default=None, alias="baseUrl")
    # When true (Agent mode), the run executes in an isolated copy of the
    # workspace; changes are reviewed and only land on Apply (redesign Part 2.5).
    review_changes: bool = Field(default=False, alias="reviewChanges")
    max_iterations: int = Field(default=12, alias="maxIterations", ge=1, le=50)
    max_repair_attempts: int = Field(default=2, alias="maxRepairAttempts")


class RunSlashCommandRequest(_Base):
    name: SlashCommandName
    args: dict[str, Any] = Field(default_factory=dict)


AgentEvent = Annotated[
    AgentLifecycleEvent
    | MessageDeltaEvent
    | TokenEvent
    | MessageEvent
    | PlanCreatedEvent
    | PlanEvent
    | PlanStepEvent
    | ToolStartedEvent
    | ToolCompletedEvent
    | ToolCallEvent
    | TodoUpdateEvent
    | RunLifecycleEvent
    | CheckpointCreatedEvent
    | DiffReadyEvent
    | TestLifecycleEvent
    | DiffEvent
    | LogEvent
    | ErrorEvent
    | DoneEvent,
    Field(discriminator="type"),
]


__all__ = [
    "AgentEvent",
    "AgentEventBase",
    "AgentLifecycleEvent",
    "CheckpointCreatedEvent",
    "CheckpointInfo",
    "CodeReviewFinding",
    "CodeReviewReport",
    "ContextCandidate",
    "ContextStatus",
    "CreateSessionRequest",
    "DiffEvent",
    "DiffPatch",
    "DiffReadyEvent",
    "DoneEvent",
    "EmbedderInfo",
    "EmbeddingProvider",
    "EmbeddingSettings",
    "ErrorEvent",
    "FindingSeverity",
    "HealthResponse",
    "IndexChunk",
    "IndexConfig",
    "IndexQueryResult",
    "IndexStatus",
    "InlineEditResult",
    "LogEvent",
    "MemoryStats",
    "Message",
    "MessageDeltaEvent",
    "MessageEvent",
    "MessageRole",
    "ModelBenchmarkHistory",
    "ModelBenchmarkPromptResult",
    "ModelBenchmarkRun",
    "ModelCapability",
    "ModelDescriptor",
    "OpenFileContext",
    "PermissionGrant",
    "PermissionScope",
    "Plan",
    "PlanCreatedEvent",
    "PlanEvent",
    "PlanStep",
    "PlanStepEvent",
    "PlanStepStatus",
    "PostMessageRequest",
    "ProjectRulesInfo",
    "ProviderDescriptor",
    "ProviderKind",
    "RunAgentRequest",
    "RunModelBenchmarkRequest",
    "RunLifecycleEvent",
    "RunSlashCommandRequest",
    "Session",
    "SessionStatus",
    "SettingsSnapshot",
    "SlashCommandDescriptor",
    "SlashCommandName",
    "TerminalSession",
    "TerminalSessionStatus",
    "TestGenerationResult",
    "TestLifecycleEvent",
    "TodoItem",
    "TodoStatus",
    "TodoUpdateEvent",
    "TokenEvent",
    "ToolCall",
    "ToolCallEvent",
    "ToolCallStatus",
    "ToolCompletedEvent",
    "ToolDescriptor",
    "ToolGrant",
    "ToolResult",
    "ToolStartedEvent",
    "UpdateIndexConfigRequest",
    "UpdateSessionRequest",
    "UpdateSettingsRequest",
]
