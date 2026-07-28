"""The ``Mode_Router`` and the two mode-specific execution paths (R2, R3).

The Mode_Router inspects the request ``mode`` field and dispatches to one of
two execution paths (design "Mode_Router (R2, R3)"):

- ``mode = "ask"`` → :class:`AskPath` with ``skip_planner = True`` and a
  :class:`ReadOnlyToolset` that physically lacks mutating operations (R2.1).
- ``mode = "agent"`` → :class:`AgentPath` with the FSM initialized at
  :attr:`Stage.INTAKE` and a :class:`FullToolset` (R3.1, R3.5).

Task 4.2 adds the Ask-path *execution* on top of the routing fixed in task
4.1: :meth:`AskPath.execute` compiles steering and runs RAG extraction into a
context payload **before** generating the Ask response (R2.5, R2.6), returns a
switch-to-Agent message for edit/implementation requests without touching the
workspace (R2.4), and converts a :class:`ReadOnlyViolation` raised by a
mutating attempt into an error result naming the rejected operation type while
leaving the workspace untouched (R2.3). The full FSM transition table is task
5.1.
"""

from __future__ import annotations

import abc
import re
from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Final, Literal

from pydantic import BaseModel, ConfigDict, Field

from zocai_gateway.context.project_instructions import read_project_instructions
from zocai_gateway.context.rag_matcher import NullRagMatcher, RagFragment, RagMatcher
from zocai_gateway.context.steering_compiler import (
    DEFAULT_STEERING_DIR,
    SteeringPayload,
    compile_steering,
)
from zocai_gateway.errors import ErrorCode
from zocai_gateway.fsm import FSM
from zocai_gateway.security import log_security_event
from zocai_gateway.stages import Stage
from zocai_gateway.toolsets import (
    FullToolset,
    ReadOnlyToolset,
    ReadOnlyViolation,
    Toolset,
)

__all__ = [
    "ASK_ACTIVE_FILE_CHAR_LIMIT",
    "ASK_RAG_TOP_K",
    "PERMISSIONS",
    "SWITCH_TO_AGENT_MESSAGE",
    "AgentPath",
    "AgentRunRequest",
    "AskContext",
    "AskError",
    "AskGenerator",
    "AskPath",
    "AskResponse",
    "AskResult",
    "Capability",
    "ContextFileReference",
    "Decision",
    "ExecutionPath",
    "Mode",
    "ModeRouter",
    "RequestContext",
    "SwitchToAgentMessage",
    "build_ask_context",
    "check_capability",
    "is_edit_request",
]


class Mode(str, Enum):
    """The execution modes a request can select (R2.1, R3.1, §12.2).

    ``PLAN`` is Agent mode with the brakes on: it runs the same stages up to
    ``PLAN_EDITS`` and then stops for approval instead of applying anything.
    """

    ASK = "ask"
    AGENT = "agent"
    PLAN = "plan"


class ContextFileReference(BaseModel):
    """Exact file selected by the frontend for a visible `@filename` token."""

    model_config = ConfigDict(extra="ignore")

    token: str
    path: str


class RequestContext(BaseModel):
    """Editor context accompanying a run request (§12.1).

    Ask Mode answers questions *about the code in front of the user*, so it needs
    to know what that is. These fields are the editor's view at submit time:

    * ``active_file`` — workspace-relative (or absolute) path of the open editor.
    * ``selection`` — the highlighted text, when there is a selection.
    * ``cursor_line`` — 1-based caret line, used to locate the answer.

    All optional: a request without them behaves exactly as before.
    """

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    active_file: str | None = Field(default=None, alias="activeFile")
    selection: str | None = None
    cursor_line: int | None = Field(default=None, alias="cursorLine")
    language: str | None = None


class AgentRunRequest(BaseModel):
    """An incoming agent run request.

    ``prompt`` and ``mode`` drive routing. The optional model/provider fields
    carry the frontend's selected local/cloud model into the Gateway runtime;
    routing ignores them, but the injected brain can use them to call the
    chosen model without inventing a second transport shape.
    """

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    prompt: str
    mode: Mode
    run_id: str | None = Field(
        default=None,
        alias="runId",
        min_length=1,
        max_length=80,
        pattern=r"^[A-Za-z0-9_.:-]+$",
    )
    context_files: list[ContextFileReference] = Field(
        default_factory=list,
        alias="contextFiles",
    )
    #: Editor context (active file / selection / caret) used by Ask Mode (§12.1).
    context: RequestContext | None = None
    model: str | None = None
    provider: str | None = None
    api_key: str | None = Field(default=None, alias="apiKey")
    base_url: str | None = Field(default=None, alias="baseUrl")
    workspace_root: str | None = Field(default=None, alias="workspaceRoot")
    review_changes: bool = Field(default=False, alias="reviewChanges")
    temperature: float | None = None
    top_p: float | None = Field(default=None, alias="topP")
    top_k: int | None = Field(default=None, alias="topK")
    repeat_penalty: float | None = Field(default=None, alias="repeatPenalty")
    max_tokens: int | None = Field(default=None, alias="maxTokens")
    #: The Reasoning_Effort level for this run (R17.2). ``None`` means the
    #: frontend sent no preference; ``model_runtime`` maps it per provider
    #: capability and omits it entirely for models with no such parameter (R17.4).
    reasoning_effort: Literal["low", "medium", "high"] | None = Field(
        default=None, alias="reasoningEffort"
    )
    #: Frontend PermissionConfig (camelCase) used to gate agent tools (Part 7.1).
    permission: dict[str, object] | None = None


# ── Ask-path execution (R2.3–R2.6) ──────────────────────────────────────────

#: The message returned to the Developer when an edit/implementation request is
#: submitted in Ask Mode (R2.4). It instructs switching to Agent Mode and is
#: returned *without* modifying any file, directory, or workspace state.
SWITCH_TO_AGENT_MESSAGE = (
    "Ask Mode is read-only and cannot edit files, run commands, or modify the "
    "workspace. Switch to Agent Mode to implement this change."
)

#: Verbs that, when they lead the request, signal an edit/implementation
#: *intent* (R2.4) rather than a question. Matched as whole words after any
#: leading courtesy/framing filler is stripped.
_EDIT_VERBS = frozenset(
    {
        "implement",
        "create",
        "write",
        "edit",
        "modify",
        "change",
        "add",
        "delete",
        "remove",
        "refactor",
        "rename",
        "fix",
        "build",
        "generate",
        "update",
        "install",
        "append",
        "replace",
        "insert",
        "scaffold",
        "apply",
        "patch",
        "make",
        "rewrite",
        "drop",
        "move",
    }
)

#: Leading words that merely frame a request ("please create …", "can you add
#: …", "I want you to write …") and are skipped before classifying the intent.
_REQUEST_FRAMING_FILLER = frozenset(
    {
        "please",
        "could",
        "can",
        "would",
        "will",
        "you",
        "i",
        "we",
        "want",
        "need",
        "to",
        "kindly",
        "pls",
        "just",
        "now",
        "go",
        "ahead",
        "and",
        "let",
        "lets",
        "us",
        "me",
        "the",
        "a",
        "an",
    }
)

#: Tokenizer for the intent classifier: lowercase alphabetic words (with
#: intra-word apostrophes), so punctuation never hides a leading verb.
_WORD_RE = re.compile(r"[a-z]+(?:'[a-z]+)?")


def is_edit_request(prompt: str) -> bool:
    """Whether ``prompt`` is an edit/implementation request in Ask Mode (R2.4).

    The classifier strips leading courtesy/framing words ("please", "can you",
    "I want you to", …) and then treats the request as an edit/implementation
    intent if the first remaining word is an imperative edit verb (see
    :data:`_EDIT_VERBS`). Interrogative phrasing ("how do I implement …?",
    "what does this do?") is therefore *not* classified as an edit request and
    is answered normally.
    """
    tokens = _WORD_RE.findall(prompt.lower())
    index = 0
    while index < len(tokens) and tokens[index] in _REQUEST_FRAMING_FILLER:
        index += 1
    return index < len(tokens) and tokens[index] in _EDIT_VERBS


#: How many RAG fragments Ask Mode injects into the system prompt (§12.1).
ASK_RAG_TOP_K = 5

#: Cap on how much of the active file is inlined, so a large file cannot crowd
#: out the rest of the prompt. The selection is always included in full.
ASK_ACTIVE_FILE_CHAR_LIMIT = 8_000


@dataclass(frozen=True, slots=True)
class AskContext:
    """The context payload assembled before generating an Ask response.

    Built by :func:`build_ask_context` from workspace instructions, compiled
    steering guides (R2.5), RAG-extracted code fragments (R2.6), and — for
    context-aware Ask Mode (§12.1) — the file the user is looking at plus any
    selection.
    """

    steering: SteeringPayload
    rag_fragments: tuple[RagFragment, ...] = ()
    project_instructions: str = ""
    #: Path of the file open in the editor when the question was asked.
    active_file: str | None = None
    #: Content of :attr:`active_file` (truncated to the char limit).
    active_file_content: str | None = None
    #: The user's editor selection, verbatim.
    selection: str | None = None
    #: 1-based caret line, when the editor reported one.
    cursor_line: int | None = None

    def system_prompt_sections(self) -> tuple[str, ...]:
        """The ordered prompt sections describing this context (§12.1).

        Ordered most-specific first — selection, then active file, then retrieved
        fragments — because a model that truncates should lose the *least*
        specific context, not the user's own selection.
        """
        sections: list[str] = []
        if self.selection:
            where = f" (around line {self.cursor_line})" if self.cursor_line else ""
            sections.append(
                f"The user has selected this text{where}"
                + (f" in {self.active_file}" if self.active_file else "")
                + ":\n"
                + self.selection
            )
        if self.active_file:
            header = f"The user is currently viewing {self.active_file}"
            if self.active_file_content:
                sections.append(f"{header}:\n{self.active_file_content}")
            else:
                sections.append(f"{header}.")
        top = self.rag_fragments[:ASK_RAG_TOP_K]
        if top:
            rendered = "\n\n".join(
                f"--- {fragment.path} (relevance {fragment.score:.2f}) ---\n{fragment.content}"
                for fragment in top
            )
            sections.append(f"Possibly relevant code from the workspace:\n{rendered}")
        return tuple(sections)


@dataclass(frozen=True, slots=True)
class AskResponse:
    """A generated Ask Mode answer (the normal, read-only outcome)."""

    text: str
    context: AskContext


@dataclass(frozen=True, slots=True)
class SwitchToAgentMessage:
    """Outcome for an edit/implementation request in Ask Mode (R2.4).

    Carries the instruction to switch to Agent Mode. Producing this outcome
    never modifies any file, directory, or workspace state.
    """

    context: AskContext
    message: str = SWITCH_TO_AGENT_MESSAGE


@dataclass(frozen=True, slots=True)
class AskError:
    """Error outcome naming a rejected mutating operation in Ask Mode (R2.3).

    Produced when a :class:`ReadOnlyViolation` is raised while generating the
    response. :attr:`operation` names the rejected operation type; the
    workspace is left untouched because the read-only toolset never performs
    the mutation.
    """

    operation: str
    context: AskContext
    message: str = ""

    def __post_init__(self) -> None:
        if not self.message:
            object.__setattr__(
                self,
                "message",
                f"Ask Mode rejected a read-only violation: {self.operation!r} "
                "is not permitted. Switch to Agent Mode to perform it.",
            )


#: The three Ask-path outcomes: a generated answer, a switch-to-Agent message
#: for edit requests, or an error naming a rejected mutating operation.
AskResult = AskResponse | SwitchToAgentMessage | AskError

#: A response generator: given the prompt and the assembled context payload,
#: produce the Ask answer text. Injected so task 4.2 stays decoupled from the
#: model interface; a mutating attempt surfaces as :class:`ReadOnlyViolation`.
AskGenerator = Callable[[str, AskContext], str]


def build_ask_context(
    prompt: str,
    *,
    workspace_root: Path | str | None = ".",
    steering_dir: Path | None = None,
    rag_matcher: RagMatcher | None = None,
    context: RequestContext | None = None,
) -> AskContext:
    """Compile steering and run RAG extraction into an :class:`AskContext`.

    Per R2.5 and R2.6 this runs *before* any Ask response is generated:
    steering guides under ``.zoc/steering`` are compiled in lexical order
    (skipping unreadable files), and the RAG_Matcher extracts code fragments
    relevant to ``prompt``. ``steering_dir`` defaults to
    ``<workspace_root>/.zoc/steering``; ``rag_matcher`` defaults to the no-op
    :class:`NullRagMatcher` until task 8.1 wires the real matcher.

    ``workspace_root`` may be ``None`` for a root-less Ask run (R1.7): steering,
    project instructions, and the active-file inline are then simply empty —
    Ask answers general questions with no project context and reads nothing.

    When ``context`` carries an ``active_file``, its content is read from the
    workspace and inlined (truncated to
    :data:`ASK_ACTIVE_FILE_CHAR_LIMIT`) so Ask Mode can answer about the code the
    user is actually looking at (§12.1). A missing or unreadable file degrades to
    "path only" rather than failing the request.
    """
    matcher: RagMatcher = rag_matcher if rag_matcher is not None else NullRagMatcher()
    fragments = tuple(matcher.extract(prompt))
    active_file = context.active_file if context is not None else None
    if workspace_root is None:
        # Root-less Ask: no workspace to compile steering from or read files in.
        return AskContext(
            steering=SteeringPayload(),
            rag_fragments=fragments,
            project_instructions="",
            active_file=active_file,
            active_file_content=None,
            selection=context.selection if context is not None else None,
            cursor_line=context.cursor_line if context is not None else None,
        )
    resolved_steering_dir = (
        steering_dir if steering_dir is not None else Path(workspace_root) / DEFAULT_STEERING_DIR
    )
    steering = compile_steering(resolved_steering_dir)
    return AskContext(
        steering=steering,
        rag_fragments=fragments,
        project_instructions=read_project_instructions(workspace_root),
        active_file=active_file,
        active_file_content=(
            _read_active_file(workspace_root, active_file) if active_file is not None else None
        ),
        selection=context.selection if context is not None else None,
        cursor_line=context.cursor_line if context is not None else None,
    )


def _read_active_file(workspace_root: Path | str, active_file: str) -> str | None:
    """Read the editor's active file, confined to the workspace (§12.1).

    Returns ``None`` when the path escapes the workspace, does not exist, or is
    not decodable text. The confinement matters: ``active_file`` arrives from the
    renderer, so it is untrusted input and must not be able to read
    ``../../.ssh/id_rsa`` into a prompt.
    """
    root = Path(workspace_root).resolve()
    candidate = Path(active_file)
    target = candidate if candidate.is_absolute() else root / candidate
    try:
        resolved = target.resolve()
    except OSError:
        return None
    if resolved != root and root not in resolved.parents:
        log_security_event(
            "path_traversal",
            "blocked active editor file outside the workspace",
            path=active_file,
            operation="ask_context",
            workspace=str(root),
        )
        return None
    try:
        text = resolved.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError, ValueError):
        return None
    if len(text) <= ASK_ACTIVE_FILE_CHAR_LIMIT:
        return text
    return text[:ASK_ACTIVE_FILE_CHAR_LIMIT] + "\n… (truncated)"


class ExecutionPath(abc.ABC):
    """Base class for the two mode-specific execution paths.

    Every path exposes the mode it serves, whether the planner is skipped,
    and the capability toolset it runs with. Subclasses narrow the toolset
    to the capability set appropriate for their mode.
    """

    mode: Mode
    skip_planner: bool
    toolset: Toolset

    @property
    @abc.abstractmethod
    def is_read_only(self) -> bool:
        """Whether the path forbids workspace mutation."""
        raise NotImplementedError


class AskPath(ExecutionPath):
    """Read-only conversational path (Ask Mode, R2.1).

    Constructed with ``skip_planner = True`` and a :class:`ReadOnlyToolset`
    so mutating operations are unconstructable rather than merely rejected.
    """

    mode = Mode.ASK

    def __init__(
        self,
        *,
        skip_planner: bool = True,
        toolset: ReadOnlyToolset | None = None,
    ) -> None:
        self.skip_planner = skip_planner
        self.toolset = toolset if toolset is not None else ReadOnlyToolset()

    @property
    def is_read_only(self) -> bool:
        return True

    def execute(
        self,
        request: AgentRunRequest,
        *,
        generate: AskGenerator,
        workspace_root: Path | str | None = ".",
        steering_dir: Path | None = None,
        rag_matcher: RagMatcher | None = None,
    ) -> AskResult:
        """Execute an Ask Mode request, returning one of three outcomes.

        The flow is (design "Mode_Router", R2.3–R2.6):

        1. **Compile steering + run RAG extraction first (R2.5, R2.6).** The
           context payload is always assembled before anything else, so every
           outcome is produced against steering + RAG context.
        2. **Edit/implementation request → switch to Agent (R2.4).** If the
           request asks for an edit/implementation (see :func:`is_edit_request`),
           return a :class:`SwitchToAgentMessage` *without* generating a
           response and without modifying any file, directory, or workspace
           state.
        3. **Otherwise generate the answer, guarding mutations (R2.3).** Call
           ``generate``; if it raises :class:`ReadOnlyViolation` (a mutating
           operation reaching the read-only boundary), convert it into an
           :class:`AskError` naming the rejected operation type. The read-only
           toolset never performs the mutation, so the workspace is untouched.
        """
        context = build_ask_context(
            request.prompt,
            workspace_root=workspace_root,
            steering_dir=steering_dir,
            rag_matcher=rag_matcher,
            context=request.context,
        )

        # R2.4: an edit/implementation request never generates or mutates.
        if is_edit_request(request.prompt):
            return SwitchToAgentMessage(context=context)

        # R2.3: a mutating attempt surfaces as ReadOnlyViolation; convert it
        # into an error naming the operation, workspace left untouched.
        try:
            text = generate(request.prompt, context)
        except ReadOnlyViolation as exc:
            return AskError(operation=exc.operation, context=context)
        return AskResponse(text=text, context=context)


class AgentPath(ExecutionPath):
    """Execution-capable path (Agent Mode, R3.1, R3.5).

    Constructed with the FSM initialized at :attr:`Stage.INTAKE` and a
    :class:`FullToolset` that permits write / shell / mkdir in the workspace.
    The planner runs, so ``skip_planner`` is ``False``.

    ``plan_only`` selects Plan mode (§12.2): the same path and toolset, but the
    pipeline stops for approval after ``PLAN_EDITS`` instead of applying. The
    toolset is *not* narrowed, because approval resumes the very same run — the
    guarantee comes from the pipeline gate, not from removing capabilities.
    """

    mode = Mode.AGENT
    skip_planner = False

    def __init__(
        self,
        *,
        fsm: FSM | None = None,
        toolset: FullToolset | None = None,
        plan_only: bool = False,
    ) -> None:
        self.fsm = fsm if fsm is not None else FSM(initial=Stage.INTAKE)
        self.toolset = toolset if toolset is not None else FullToolset()
        self.plan_only = plan_only
        if plan_only:
            self.mode = Mode.PLAN

    @property
    def is_read_only(self) -> bool:
        return False


class ModeRouter:
    """Routes a request to the correct execution path (R2.1, R3.1, §12.2)."""

    def route(self, req: AgentRunRequest) -> ExecutionPath:
        """Dispatch ``req`` to the Ask, Plan, or Agent path by its ``mode``.

        ``mode = "ask"`` yields an :class:`AskPath` (``skip_planner = True``,
        :class:`ReadOnlyToolset`); ``mode = "plan"`` yields an
        :class:`AgentPath` with ``plan_only = True``; any other mode yields a
        plain :class:`AgentPath` (FSM at :attr:`Stage.INTAKE`,
        :class:`FullToolset`).
        """
        if req.mode == Mode.ASK:
            return AskPath(skip_planner=True, toolset=ReadOnlyToolset())
        return AgentPath(
            fsm=FSM(initial=Stage.INTAKE),
            toolset=FullToolset(),
            plan_only=req.mode == Mode.PLAN,
        )


# ── Mode capability table (R7.6, R7.7, R16.2-16.4) ───────────────────────────


class Capability(str, Enum):
    """A class of tool capability the Mode_Router permits or rejects per mode."""

    READ = "read"  # read-only tools (list, read_file, search…) — always safe
    WRITE = "write"  # file mutation (write_file, delete_file, move_file)
    EXECUTE = "execute"  # command execution (terminal, checks, MCP side effects)


@dataclass(frozen=True, slots=True)
class Decision:
    """The outcome of a capability check.

    ``permitted`` is the table verdict; a rejection carries the typed
    ``MODE_NOT_PERMITTED`` code and a user-readable ``message`` (no ids/paths).
    """

    permitted: bool
    code: str | None = None
    message: str | None = None

    @property
    def rejected(self) -> bool:
        return not self.permitted


def _capability_table() -> dict[tuple[Mode, bool, Capability], bool]:
    """Build the exhaustive (mode, approved, capability) → permitted table.

    The rules (design "Mode_Router", R7.6/R7.7/R16.2-16.4):

    * Ask (R16.2): read-only permitted; write/execute rejected, regardless of
      any approval state (Ask never reaches an approval gate).
    * Plan before approval (R7.6/R16.3): read-only permitted; write/execute
      rejected — the plan is staged, nothing is written.
    * Plan after approval (R7.7): read/write/execute permitted — approval
      resumes the same run with the Edit-stage capabilities enabled.
    * Agent (R16.4): read/write/execute permitted, subject to the configured
      approval policy (enforced separately by the permission engine).
    """
    table: dict[tuple[Mode, bool, Capability], bool] = {}
    for mode in Mode:
        for approved in (False, True):
            for capability in Capability:
                if capability is Capability.READ or mode is Mode.AGENT:
                    permitted = True
                elif mode is Mode.PLAN:
                    permitted = approved  # write/execute only after approval
                else:  # Mode.ASK
                    permitted = False
                table[(mode, approved, capability)] = permitted
    return table


#: Mode × approved × capability → permitted. Declared (built from the rules
#: above) so :func:`check_capability` is a pure table lookup and the decision is
#: exhaustively testable (Property 16).
PERMISSIONS: Final[dict[tuple[Mode, bool, Capability], bool]] = _capability_table()


def check_capability(mode: Mode, approved: bool, capability: Capability) -> Decision:
    """Permit or reject a capability for ``(mode, approved)`` (R7.6, R7.7, R16.2-16.4).

    A rejection carries the typed ``MODE_NOT_PERMITTED`` code so the caller can
    surface it as a mode-permission error rather than a raw failure.
    """
    if PERMISSIONS[(mode, approved, capability)]:
        return Decision(permitted=True)
    return Decision(
        permitted=False,
        code=ErrorCode.MODE_NOT_PERMITTED,
        message=(
            f"{capability.value} tools are not available in {mode.value} mode"
            + (" before you approve the plan." if mode is Mode.PLAN else ".")
        ),
    )
