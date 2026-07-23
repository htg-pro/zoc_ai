"""Layer 4 — Three-Tier Local Memory Matrix (``.zocai/``).

This package holds the per-workspace memory matrix. Task 9.1 implements the
matrix initialization: every store is confined under ``.zocai/`` (R9.1) and any
missing directory or tier sub-store is created on init (R9.2). The Diary_Worker
(Tier 1), State_Wrapper store (Tier 2), and Hermes_Evolution loop (Tier 3) are
implemented in later tasks.
"""

from zocai_gateway.memory.diary_worker import DiaryEntry, DiaryWorker
from zocai_gateway.memory.hermes_evolution import (
    DEFAULT_IDLE_SECONDS,
    DEFAULT_POLL_INTERVAL,
    DeterministicGepaStub,
    GepaResult,
    GepaStep,
    HermesEvolution,
    Trace,
)
from zocai_gateway.memory.matrix import (
    COMPRESSED_HISTORY_PREFIX,
    COMPRESSION_TRIGGER_RATIO,
    CONTEXT_COMPRESSED_TOPIC,
    CROSS_MODEL_BUS_DIR,
    GEPA_STATE_FILE,
    HERMES_EVOLUTION_DIR,
    PRESERVED_TAIL_TURNS,
    SESSION_DIARY_FILE,
    SKILL_FILE,
    STATE_WRAPPER_FILE,
    SUMMARY_INSTRUCTION,
    TRACES_DIR,
    ZOCAI_DIR,
    CompressionError,
    ContextCompressedEvent,
    ContextEmitter,
    ConversationMemory,
    MemoryMatrix,
    Message,
    Role,
    Summarizer,
    TokenizerKind,
    count_history_tokens,
    count_tokens,
    model_summarizer,
    runtime_summarizer,
    tokenizer_kind_for_tier,
)
from zocai_gateway.memory.reconstruction import (
    ReconstructedRun,
    active_run_id,
    read_diary_entries,
    reconstruct_run_state,
    trailing_entries,
)
from zocai_gateway.memory.state_wrapper import (
    LOG_MAX_CHARS,
    SCHEMA_KEYS,
    SCHEMA_VERSION,
    Diff,
    FailureRecord,
    StateWrapper,
    StateWrapperError,
    StateWrapperStore,
)

__all__ = [
    "COMPRESSED_HISTORY_PREFIX",
    "COMPRESSION_TRIGGER_RATIO",
    "CONTEXT_COMPRESSED_TOPIC",
    "CROSS_MODEL_BUS_DIR",
    "DEFAULT_IDLE_SECONDS",
    "DEFAULT_POLL_INTERVAL",
    "GEPA_STATE_FILE",
    "HERMES_EVOLUTION_DIR",
    "LOG_MAX_CHARS",
    "PRESERVED_TAIL_TURNS",
    "SCHEMA_KEYS",
    "SCHEMA_VERSION",
    "SESSION_DIARY_FILE",
    "SKILL_FILE",
    "STATE_WRAPPER_FILE",
    "SUMMARY_INSTRUCTION",
    "TRACES_DIR",
    "ZOCAI_DIR",
    "CompressionError",
    "ContextCompressedEvent",
    "ContextEmitter",
    "ConversationMemory",
    # Tier 3 — Hermes_Evolution idle loop (task 9.4)
    "DeterministicGepaStub",
    "DiaryEntry",
    "DiaryWorker",
    "Diff",
    "FailureRecord",
    "GepaResult",
    "GepaStep",
    "HermesEvolution",
    "MemoryMatrix",
    "Message",
    # Resilience & crash recovery (task 9.5, R10.1/R10.3/R10.4)
    "ReconstructedRun",
    # Intelligent context compression (§2.2)
    "Role",
    # Tier 2 — State_Wrapper store (task 9.3)
    "StateWrapper",
    "StateWrapperError",
    "StateWrapperStore",
    "Summarizer",
    "TokenizerKind",
    "Trace",
    "active_run_id",
    "count_history_tokens",
    "count_tokens",
    "model_summarizer",
    "read_diary_entries",
    "reconstruct_run_state",
    "runtime_summarizer",
    "tokenizer_kind_for_tier",
    "trailing_entries",
]
