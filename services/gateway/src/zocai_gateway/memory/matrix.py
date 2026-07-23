"""``.zocai/`` initialization for the three-tier memory matrix (task 9.1).

This module owns the on-disk layout of the per-workspace memory matrix and its
idempotent initialization. Two invariants drive the design:

* **Confinement (R9.1).** Every store the matrix touches lives *under* the
  workspace ``.zocai/`` directory. Initialization never creates a file or
  directory outside that subtree.
* **Create-on-init (R9.2).** When the matrix is initialized and the ``.zocai/``
  directory or any of its tier sub-stores is absent, the missing directory and
  sub-stores are created. Initialization is idempotent: existing stores are
  left exactly as they are (no truncation, no overwrite).

The on-disk layout mirrors the design's "Three-Tier Local Memory Matrix
(Layer 4, ``.zocai/``)" section::

    project-root/
    └── .zocai/
        ├── session_diary.jsonl              # Tier 1 — append-only event log
        ├── traces/                          # execution step histories
        ├── cross_model_bus/
        │   └── state_wrapper.json           # Tier 2 — model-agnostic state
        └── hermes-evolution/
            ├── SKILL.md                     # Tier 3 — evolved prompt scripts
            └── gepa_state.json              # GEPA population / Pareto front

The workspace root is injectable so tests (and embedding callers) can point the
matrix at a temporary directory. The Diary_Worker (Tier 1), State_Wrapper store
(Tier 2), and Hermes_Evolution loop (Tier 3) build on this layout in later
tasks; this module only guarantees the stores exist.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING, Protocol

from zocai_gateway.context.token_gate import estimate_tokens
from zocai_gateway.model_interface import ModelInterface, ModelRequest, ModelTier

if TYPE_CHECKING:
    from zocai_gateway.mode_router import AgentRunRequest

__all__ = [
    "COMPRESSED_HISTORY_PREFIX",
    "COMPRESSION_TRIGGER_RATIO",
    "CONTEXT_COMPRESSED_TOPIC",
    "CROSS_MODEL_BUS_DIR",
    "GEPA_STATE_FILE",
    "HERMES_EVOLUTION_DIR",
    "PRESERVED_TAIL_TURNS",
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
    "MemoryMatrix",
    "Message",
    # -- Intelligent context compression (§2.2) ------------------------------
    "Role",
    "Summarizer",
    "TokenizerKind",
    "count_history_tokens",
    "count_tokens",
    "model_summarizer",
    "runtime_summarizer",
    "tokenizer_kind_for_tier",
]

# Root of the matrix, relative to the workspace root (R9.1).
ZOCAI_DIR = ".zocai"

# Tier 1 — append-only session diary (R9.3, R9.4).
SESSION_DIARY_FILE = "session_diary.jsonl"
# Execution step histories consumed by Hermes_Evolution (Tier 3).
TRACES_DIR = "traces"

# Tier 2 — cross-model bus / model-agnostic state wrapper (R9.5, R9.6).
CROSS_MODEL_BUS_DIR = "cross_model_bus"
STATE_WRAPPER_FILE = "state_wrapper.json"

# Tier 3 — Hermes-Evolution / GEPA prompt self-evolution (R9.7).
HERMES_EVOLUTION_DIR = "hermes-evolution"
SKILL_FILE = "SKILL.md"
GEPA_STATE_FILE = "gepa_state.json"

# Initial content for freshly created sub-stores. Append-only / markdown stores
# start empty; JSON stores start as a valid empty document so downstream readers
# never have to special-case a zero-byte file.
_EMPTY_JSON_OBJECT = "{}\n"


@dataclass(frozen=True, slots=True)
class MemoryMatrix:
    """The per-workspace three-tier memory matrix rooted at ``.zocai/``.

    The matrix is constructed against an injectable ``workspace_root`` so the
    whole tree can be redirected at a temporary directory in tests. All paths
    the matrix exposes resolve under :attr:`zocai_dir`, enforcing the R9.1
    confinement invariant.
    """

    workspace_root: Path

    def __init__(self, workspace_root: Path | str) -> None:
        # Normalize to an absolute Path so every derived store path is stable
        # and confinement can be reasoned about without surprises from a
        # relative cwd. ``object.__setattr__`` is required because the
        # dataclass is frozen.
        object.__setattr__(self, "workspace_root", Path(workspace_root).resolve())

    # -- Derived store paths (all confined under ``.zocai/``, R9.1) ---------

    @property
    def zocai_dir(self) -> Path:
        """The matrix root, ``<workspace_root>/.zocai`` (R9.1)."""
        return self.workspace_root / ZOCAI_DIR

    @property
    def session_diary_path(self) -> Path:
        """Tier 1 append-only event log."""
        return self.zocai_dir / SESSION_DIARY_FILE

    @property
    def traces_dir(self) -> Path:
        """Execution step histories directory."""
        return self.zocai_dir / TRACES_DIR

    @property
    def cross_model_bus_dir(self) -> Path:
        """Tier 2 cross-model bus directory."""
        return self.zocai_dir / CROSS_MODEL_BUS_DIR

    @property
    def state_wrapper_path(self) -> Path:
        """Tier 2 model-agnostic state wrapper."""
        return self.cross_model_bus_dir / STATE_WRAPPER_FILE

    @property
    def hermes_evolution_dir(self) -> Path:
        """Tier 3 Hermes-Evolution directory."""
        return self.zocai_dir / HERMES_EVOLUTION_DIR

    @property
    def skill_path(self) -> Path:
        """Tier 3 evolved prompt scripts."""
        return self.hermes_evolution_dir / SKILL_FILE

    @property
    def gepa_state_path(self) -> Path:
        """Tier 3 GEPA population / Pareto front state."""
        return self.hermes_evolution_dir / GEPA_STATE_FILE

    def directories(self) -> tuple[Path, ...]:
        """Every directory the matrix owns, parents before children."""
        return (
            self.zocai_dir,
            self.traces_dir,
            self.cross_model_bus_dir,
            self.hermes_evolution_dir,
        )

    def files(self) -> tuple[Path, ...]:
        """Every tier sub-store file the matrix owns."""
        return (
            self.session_diary_path,
            self.state_wrapper_path,
            self.skill_path,
            self.gepa_state_path,
        )

    # -- Initialization (R9.2) ---------------------------------------------

    def initialize(self) -> None:
        """Create any missing ``.zocai/`` directory or tier sub-store (R9.2).

        Idempotent: directories are created with ``exist_ok=True`` and files
        are only written when absent, so an already-initialized matrix is left
        untouched (existing diary/state content is never truncated). All writes
        stay confined under :attr:`zocai_dir` (R9.1).
        """
        for directory in self.directories():
            directory.mkdir(parents=True, exist_ok=True)

        # Seed each missing sub-store with its initial content. JSON stores get
        # a valid empty document; append-only and markdown stores start empty.
        self._create_if_missing(self.session_diary_path, "")
        self._create_if_missing(self.state_wrapper_path, _EMPTY_JSON_OBJECT)
        self._create_if_missing(self.skill_path, "")
        self._create_if_missing(self.gepa_state_path, _EMPTY_JSON_OBJECT)

    def is_initialized(self) -> bool:
        """Return whether every owned directory and sub-store already exists."""
        return all(d.is_dir() for d in self.directories()) and all(
            f.is_file() for f in self.files()
        )

    @staticmethod
    def _create_if_missing(path: Path, content: str) -> None:
        """Write ``content`` to ``path`` only when ``path`` does not yet exist.

        Uses exclusive creation (``"x"``) so an existing store is preserved even
        under a race, satisfying the "create the missing sub-store" wording of
        R9.2 without clobbering retained history.
        """
        if path.exists():
            return
        try:
            with path.open("x", encoding="utf-8") as handle:
                handle.write(content)
        except FileExistsError:
            # Created concurrently between the check and the open; the store
            # exists, which is all R9.2 requires.
            return


# ===========================================================================
# Intelligent context compression (§2.2)
# ===========================================================================
#
# When the conversation history grows large the full history would otherwise be
# replayed to the model on every turn, burning context-window tokens. The
# :class:`ConversationMemory` below sizes a message history to a model window:
# once the history reaches a fraction of the window it summarises the
# middle of the conversation into a single ``[COMPRESSED HISTORY]`` system
# message, while always preserving the system prompt, the most recent turns, and
# the tool results of the stage currently in flight. A
# :class:`ContextCompressedEvent` is emitted so the UI can surface a banner.

# A compressed history is detected (and re-compression skipped) by this prefix,
# which also names the synthetic system message that replaces the middle.
COMPRESSED_HISTORY_PREFIX = "[COMPRESSED HISTORY]"

# The instruction handed to the summarising model. Kept verbatim so the model
# preserves the facts a developer needs to resume the run.
SUMMARY_INSTRUCTION = (
    "Summarise this coding conversation in \u2264200 words, preserving all "
    "file names, error messages, and decisions made."
)

# Compression triggers once the history reaches this fraction of the window;
# below it the history is returned unchanged.
COMPRESSION_TRIGGER_RATIO = 0.7

# Number of trailing user/assistant turns always kept verbatim.
PRESERVED_TAIL_TURNS = 4

# Event-bus topic the compression banner event is published on.
CONTEXT_COMPRESSED_TOPIC = "context://compressed"


class CompressionError(RuntimeError):
    """Raised when a history needs compressing but no summarizer is wired."""


class Role(str, Enum):
    """The role of a single conversation message.

    Values match the on-the-wire ``role`` discriminator used elsewhere in the
    gateway (``{"role": "system", ...}``), so a :class:`Message` round-trips to
    a provider message dict without translation.
    """

    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"
    TOOL_RESULT = "tool_result"


@dataclass(frozen=True, slots=True)
class Message:
    """One conversation message in the model's context window.

    :attr:`stage` is the Agent-Mode FSM stage the message belongs to (a
    :class:`~zocai_gateway.stages.Stage` value, which is a ``str`` enum, or any
    stage label). It lets the compressor keep the *current* stage's
    ``tool_result`` messages while summarising older ones.
    """

    role: Role
    content: str
    stage: str | None = None


@dataclass(frozen=True, slots=True)
class ContextCompressedEvent:
    """Banner event emitted after a history is compressed (§2.2 step d).

    Carries the before/after token counts and their ratio so the UI can show
    "Context compressed to fit model window." :attr:`compression_ratio` is the
    fraction of the original tokens retained (``compressed / original``), so a
    smaller value means a more aggressive compression.
    """

    original_tokens: int
    compressed_tokens: int
    compression_ratio: float


class TokenizerKind(str, Enum):
    """Which token-counting strategy a history is measured with.

    ``GPT`` uses ``tiktoken``'s ``cl100k_base`` encoding (the GPT-3.5/4 family);
    ``LOCAL`` uses the deterministic 4-chars-per-token estimate shared with the
    token gate, for local SLMs that ship no tokenizer.
    """

    GPT = "gpt"
    LOCAL = "local"


# A summarizer turns the rendered middle-of-conversation prompt into a short
# summary string. Injected so the compressor stays testable without a live LLM.
Summarizer = Callable[[str], str]

# Sink for the compression banner event (e.g. an event-bus publish adapter).
ContextEmitter = Callable[[ContextCompressedEvent], None]


class _Encoding(Protocol):
    """The slice of a ``tiktoken`` encoding the token counter relies on."""

    def encode(self, text: str) -> list[int]: ...


# tiktoken is an optional dependency: it is only needed for exact GPT token
# counts. Resolve and cache the encoding lazily; fall back to the deterministic
# estimate when the package is not installed so counting never hard-fails.
_GPT_ENCODING: _Encoding | None = None
_GPT_ENCODING_RESOLVED = False


def _gpt_encoding() -> _Encoding | None:
    """Return the cached ``cl100k_base`` encoding, or ``None`` if unavailable."""
    global _GPT_ENCODING, _GPT_ENCODING_RESOLVED
    if _GPT_ENCODING_RESOLVED:
        return _GPT_ENCODING
    _GPT_ENCODING_RESOLVED = True
    try:
        import tiktoken  # type: ignore[import-not-found]

        _GPT_ENCODING = tiktoken.get_encoding("cl100k_base")
    except Exception:  # any import/resolve failure falls back to the estimate
        _GPT_ENCODING = None
    return _GPT_ENCODING


def count_tokens(text: str, kind: TokenizerKind = TokenizerKind.GPT) -> int:
    """Count tokens in ``text`` using the ``kind`` strategy (§2.2 step 1).

    GPT-style models are counted with ``tiktoken`` (``cl100k_base``); local
    models use the fixed 4-chars/token estimate. When ``tiktoken`` is not
    installed the GPT path degrades to the same deterministic estimate so the
    count is always available.
    """
    if not text:
        return 0
    if kind is TokenizerKind.LOCAL:
        return estimate_tokens(text)
    encoding = _gpt_encoding()
    if encoding is None:
        return estimate_tokens(text)
    return len(encoding.encode(text))


def count_history_tokens(
    messages: Sequence[Message], kind: TokenizerKind = TokenizerKind.GPT
) -> int:
    """Total token count across every message's content in ``messages``."""
    return sum(count_tokens(message.content, kind) for message in messages)


def tokenizer_kind_for_tier(tier: ModelTier) -> TokenizerKind:
    """Map a model tier to its token-counting strategy.

    The Local SLM tier ships no tokenizer, so it is measured with the
    char-based estimate; Edge and Cloud tiers front GPT-style models and use
    the ``cl100k_base`` encoding.
    """
    return TokenizerKind.LOCAL if tier is ModelTier.LOCAL_SLM else TokenizerKind.GPT


def model_summarizer(
    model: ModelInterface,
    *,
    context_window: int | None = None,
    max_tokens: int = 400,
) -> Summarizer:
    """Adapt a :class:`ModelInterface` into a :data:`Summarizer`.

    The returned callable runs the summary prompt through ``model.generate`` at
    temperature 0 (deterministic), returning the response text. ``max_tokens``
    caps the summary length (the ≤200-word instruction is enforced by the
    prompt; this is a hard safety ceiling).
    """

    def _summarise(prompt: str) -> str:
        request = ModelRequest(
            prompt=prompt,
            context_window=context_window or model.context_window,
            max_tokens=max_tokens,
            temperature=0.0,
        )
        return model.generate(request).text

    return _summarise


def runtime_summarizer(request: AgentRunRequest) -> Summarizer:
    """Adapt the configured runtime provider into a compression summarizer."""

    def _summarise(prompt: str) -> str:
        # Local import avoids ``model_runtime -> mode_router -> matrix`` cycles.
        from zocai_gateway.model_runtime import generate_text

        text = generate_text(
            request.model_copy(update={"prompt": prompt}),
            timeout=60.0,
        )
        if not text or not text.strip():
            raise CompressionError("summarizer produced no text")
        return text

    return _summarise


def _is_compressed_marker(message: Message) -> bool:
    """Whether ``message`` is the synthetic compressed-history system message."""
    return message.role is Role.SYSTEM and message.content.startswith(
        COMPRESSED_HISTORY_PREFIX
    )


def _leading_system_count(messages: Sequence[Message]) -> int:
    """Length of the leading run of system messages (the system prompt block)."""
    count = 0
    for message in messages:
        if message.role is Role.SYSTEM:
            count += 1
        else:
            break
    return count


def _current_stage(messages: Sequence[Message]) -> str | None:
    """The stage of the most recent message that carries one, else ``None``."""
    for message in reversed(messages):
        if message.stage is not None:
            return message.stage
    return None


def _preserved_tail_indices(
    messages: Sequence[Message], prefix_end: int, current_stage: str | None
) -> set[int]:
    """Indices that must survive compression (§2.2 step a).

    Preserves the last :data:`PRESERVED_TAIL_TURNS` user/assistant turns and any
    ``tool_result`` message belonging to ``current_stage``. The leading system
    prompt (indices ``< prefix_end``) is handled separately by the caller.
    """
    preserved: set[int] = set()

    turn_indices = [
        index
        for index, message in enumerate(messages)
        if index >= prefix_end and message.role in (Role.USER, Role.ASSISTANT)
    ]
    preserved.update(turn_indices[-PRESERVED_TAIL_TURNS:])

    if current_stage is not None:
        for index, message in enumerate(messages):
            if (
                index >= prefix_end
                and message.role is Role.TOOL_RESULT
                and message.stage == current_stage
            ):
                preserved.add(index)

    return preserved


def _render_conversation(messages: Sequence[Message]) -> str:
    """Render messages as ``role: content`` lines for the summary prompt."""
    return "\n".join(f"{message.role.value}: {message.content}" for message in messages)


@dataclass(slots=True)
class ConversationMemory:
    """A mutable message history that compresses to fit a model window (§2.2).

    The history is the ordered list of :class:`Message` objects sent to the
    model each turn. :meth:`compress` shrinks it in place when it grows past a
    fraction of the window, summarising the middle while preserving the system
    prompt, recent turns, and the in-flight stage's tool results.
    """

    messages: list[Message] = field(default_factory=list)
    tokenizer_kind: TokenizerKind = TokenizerKind.GPT
    summarizer: Summarizer | None = None
    emit: ContextEmitter | None = None

    def compress(self, max_tokens: int) -> ContextCompressedEvent | None:
        """Compress the history to fit ``max_tokens``, returning the banner event.

        Algorithm (§2.2):

        1. Count tokens across the full history.
        2. If the total is below ``max_tokens * 0.7`` the history fits — return
           ``None`` and leave it untouched.
        3. Otherwise preserve the system prompt, the last
           :data:`PRESERVED_TAIL_TURNS` user/assistant turns, and the current
           stage's ``tool_result`` messages; summarise everything else into a
           single ``[COMPRESSED HISTORY]`` system message; and emit a
           :class:`ContextCompressedEvent`.
        4. Idempotent: calling it on an already-compressed history (one that
           already contains the ``[COMPRESSED HISTORY]`` marker) is a no-op that
           returns ``None`` without re-summarising or re-emitting.

        :raises CompressionError: when compression is required but no
            :attr:`summarizer` is configured.
        """
        messages = self.messages

        # Step 4 — already compressed: no-op (idempotent).
        if any(_is_compressed_marker(message) for message in messages):
            return None

        # Step 1 — measure the full history.
        original_tokens = count_history_tokens(messages, self.tokenizer_kind)

        # Step 2 — under the trigger threshold: return as-is.
        if original_tokens < max_tokens * COMPRESSION_TRIGGER_RATIO:
            return None

        # Step 3a — partition into preserved prefix/tail and the summarisable
        # middle.
        prefix_end = _leading_system_count(messages)
        current_stage = _current_stage(messages)
        preserved = _preserved_tail_indices(messages, prefix_end, current_stage)

        middle = [
            message
            for index, message in enumerate(messages)
            if index >= prefix_end and index not in preserved
        ]
        if not middle:
            # Everything is already preserved (prompt + recent turns); there is
            # nothing in the middle to summarise.
            return None

        # Step 3b — summarise the middle section.
        summary = self._summarise(middle)

        # Step 3c — replace the middle with a single system message, keeping the
        # system prompt ahead of it and the preserved tail after it in order.
        kept_tail = [
            message
            for index, message in enumerate(messages)
            if index >= prefix_end and index in preserved
        ]

        def candidate(summary_text: str) -> list[Message]:
            marker = COMPRESSED_HISTORY_PREFIX
            content = f"{marker} {summary_text}" if summary_text else marker
            return [
                *messages[:prefix_end],
                Message(role=Role.SYSTEM, content=content),
                *kept_tail,
            ]

        new_messages = candidate(summary)
        compressed_tokens = count_history_tokens(new_messages, self.tokenizer_kind)
        if compressed_tokens > original_tokens:
            # A provider may ignore the ≤200-word instruction and return an
            # expansion. Retain the longest summary prefix whose complete
            # compressed history is no larger than the original.
            best: tuple[list[Message], int] | None = None
            low, high = 0, len(summary)
            while low <= high:
                midpoint = (low + high) // 2
                trial_messages = candidate(summary[:midpoint].rstrip())
                trial_tokens = count_history_tokens(
                    trial_messages, self.tokenizer_kind
                )
                if trial_tokens <= original_tokens:
                    best = (trial_messages, trial_tokens)
                    low = midpoint + 1
                else:
                    high = midpoint - 1
            if best is None:
                return None
            new_messages, compressed_tokens = best

        self.messages = new_messages

        # Step 3d — emit the banner event.
        ratio = compressed_tokens / original_tokens
        event = ContextCompressedEvent(
            original_tokens=original_tokens,
            compressed_tokens=compressed_tokens,
            compression_ratio=ratio,
        )
        if self.emit is not None:
            self.emit(event)
        return event

    def _summarise(self, middle: Sequence[Message]) -> str:
        """Summarise the middle section via the configured summarizer."""
        if self.summarizer is None:
            raise CompressionError(
                "history exceeds the context budget but no summarizer is configured"
            )
        prompt = f"{SUMMARY_INSTRUCTION}\n\n{_render_conversation(middle)}"
        summary = self.summarizer(prompt).strip()
        if not summary:
            raise CompressionError("summarizer produced no text")
        return summary
