"""Shared Pydantic schema.

This module is the single source of truth for cross-language types used by
the FastAPI agent and the React frontend. TS types are generated from this
package's JSON Schema via `packages/shared-types/scripts/generate_ts.py`.
"""

from .models import (
    AgentEvent,
    # Agent events
    AgentEventBase,
    CodeReviewFinding,
    CodeReviewReport,
    ContextStatus,
    CreateReplitPlanRequest,
    CreateReplitTaskRequest,
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
    ProviderDescriptor,
    # Provider types
    ProviderKind,
    ReplitCheckpoint,
    ReplitPlan,
    ReplitPlanStatus,
    ReplitTask,
    ReplitTaskLog,
    ReplitTaskPriority,
    # Replit workflow
    ReplitTaskStatus,
    ReviseReplitPlanRequest,
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
    UpdateSettingsRequest,
)

__all__ = [
    "AgentEvent",
    # Agent events
    "AgentEventBase",
    "CodeReviewFinding",
    "CodeReviewReport",
    "ContextStatus",
    "CreateReplitPlanRequest",
    "CreateReplitTaskRequest",
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
    "ProviderDescriptor",
    # Provider types
    "ProviderKind",
    "ReplitCheckpoint",
    "ReplitPlan",
    "ReplitPlanStatus",
    "ReplitTask",
    "ReplitTaskLog",
    "ReplitTaskPriority",
    # Replit workflow
    "ReplitTaskStatus",
    "ReviseReplitPlanRequest",
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
    "UpdateSettingsRequest",
]
__version__ = "0.1.0"
