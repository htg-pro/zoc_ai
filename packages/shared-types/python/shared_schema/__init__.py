"""Shared Pydantic schema.

This module is the single source of truth for cross-language types used by
the FastAPI agent and the React frontend. TS types are generated from this
package's JSON Schema via `packages/shared-types/scripts/generate_ts.py`.
"""

from .models import (
    AgentEvent,
    # Agent events
    AgentEventBase,
    CheckpointInfo,
    CodeReviewFinding,
    CodeReviewReport,
    ContextCandidate,
    ContextStatus,
    # API requests
    CreateSessionRequest,
    DiffEvent,
    DiffPatch,
    DoneEvent,
    EmbedderInfo,
    # Settings
    EmbeddingProvider,
    EmbeddingSettings,
    ErrorEvent,
    # Code review
    FindingSeverity,
    # Core types
    HealthResponse,
    # Indexer
    IndexChunk,
    IndexConfig,
    IndexQueryResult,
    IndexStatus,
    InlineEditResult,
    LogEvent,
    # Memory and context
    MemoryStats,
    Message,
    MessageEvent,
    MessageRole,
    ModelCapability,
    ModelDescriptor,
    PermissionGrant,
    # Permissions
    PermissionScope,
    Plan,
    PlanEvent,
    PlanStep,
    PlanStepEvent,
    PlanStepStatus,
    PostMessageRequest,
    ProjectRulesInfo,
    ProviderDescriptor,
    # Provider types
    ProviderKind,
    RunAgentRequest,
    RunSlashCommandRequest,
    Session,
    SessionStatus,
    SettingsSnapshot,
    SlashCommandDescriptor,
    # Slash commands
    SlashCommandName,
    TerminalSession,
    # Terminal
    TerminalSessionStatus,
    # Test generation
    TestGenerationResult,
    TokenEvent,
    ToolCall,
    ToolCallEvent,
    ToolCallStatus,
    # Tool descriptors
    ToolDescriptor,
    ToolGrant,
    ToolResult,
    UpdateIndexConfigRequest,
    UpdateSessionRequest,
    UpdateSettingsRequest,
)

__all__ = [
    "AgentEvent",
    # Agent events
    "AgentEventBase",
    "CheckpointInfo",
    "CodeReviewFinding",
    "CodeReviewReport",
    "ContextCandidate",
    "ContextStatus",
    # API requests
    "CreateSessionRequest",
    "DiffEvent",
    "DiffPatch",
    "DoneEvent",
    "EmbedderInfo",
    # Settings
    "EmbeddingProvider",
    "EmbeddingSettings",
    "ErrorEvent",
    # Code review
    "FindingSeverity",
    # Core types
    "HealthResponse",
    # Indexer
    "IndexChunk",
    "IndexConfig",
    "IndexQueryResult",
    "IndexStatus",
    "InlineEditResult",
    "LogEvent",
    # Memory and context
    "MemoryStats",
    "Message",
    "MessageEvent",
    "MessageRole",
    "ModelCapability",
    "ModelDescriptor",
    "PermissionGrant",
    # Permissions
    "PermissionScope",
    "Plan",
    "PlanEvent",
    "PlanStep",
    "PlanStepEvent",
    "PlanStepStatus",
    "PostMessageRequest",
    "ProjectRulesInfo",
    "ProviderDescriptor",
    # Provider types
    "ProviderKind",
    "RunAgentRequest",
    "RunSlashCommandRequest",
    "Session",
    "SessionStatus",
    "SettingsSnapshot",
    "SlashCommandDescriptor",
    # Slash commands
    "SlashCommandName",
    "TerminalSession",
    # Terminal
    "TerminalSessionStatus",
    # Test generation
    "TestGenerationResult",
    "TokenEvent",
    "ToolCall",
    "ToolCallEvent",
    "ToolCallStatus",
    # Tool descriptors
    "ToolDescriptor",
    "ToolGrant",
    "ToolResult",
    "UpdateIndexConfigRequest",
    "UpdateSessionRequest",
    "UpdateSettingsRequest",
]
__version__ = "0.1.0"
