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

from pydantic import BaseModel, ConfigDict, Field

from zocai_gateway.context.project_instructions import read_project_instructions
from zocai_gateway.context.rag_matcher import NullRagMatcher, RagFragment, RagMatcher
from zocai_gateway.context.steering_compiler import (
    DEFAULT_STEERING_DIR,
    SteeringPayload,
    compile_steering,
)
from zocai_gateway.fsm import FSM
from zocai_gateway.stages import Stage
from zocai_gateway.toolsets import (
    FullToolset,
    ReadOnlyToolset,
    ReadOnlyViolation,
    Toolset,
)

__all__ = [
    "Mode",
    "ContextFileReference",
    "AgentRunRequest",
    "ExecutionPath",
    "AskPath",
    "AgentPath",
    "ModeRouter",
    "AskContext",
    "AskResponse",
    "SwitchToAgentMessage",
    "AskError",
    "AskResult",
    "AskGenerator",
    "SWITCH_TO_AGENT_MESSAGE",
    "is_edit_request",
    "build_ask_context",
]


class Mode(str, Enum):
    """The two execution modes a request can select (R2.1, R3.1)."""

    ASK = "ask"
    AGENT = "agent"


class ContextFileReference(BaseModel):
    """Exact file selected by the frontend for a visible `@filename` token."""

    model_config = ConfigDict(extra="ignore")

    token: str
    path: str


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
_EDIT_VERBS = frozenset({
    "implement", "create", "write", "edit", "modify", "change", "add",
    "delete", "remove", "refactor", "rename", "fix", "build", "generate",
    "update", "install", "append", "replace", "insert", "scaffold", "apply",
    "patch", "make", "rewrite", "drop", "move",
})

#: Leading words that merely frame a request ("please create …", "can you add
#: …", "I want you to write …") and are skipped before classifying the intent.
_REQUEST_FRAMING_FILLER = frozenset({
    "please", "could", "can", "would", "will", "you", "i", "we", "want",
    "need", "to", "kindly", "pls", "just", "now", "go", "ahead", "and",
    "let", "lets", "us", "me", "the", "a", "an",
})

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


@dataclass(frozen=True, slots=True)
class AskContext:
    """The context payload assembled before generating an Ask response.

    Built by :func:`build_ask_context` from workspace instructions, compiled
    steering guides (R2.5), and RAG-extracted code fragments (R2.6).
    """

    steering: SteeringPayload
    rag_fragments: tuple[RagFragment, ...] = ()
    project_instructions: str = ""


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
    workspace_root: Path | str = ".",
    steering_dir: Path | None = None,
    rag_matcher: RagMatcher | None = None,
) -> AskContext:
    """Compile steering and run RAG extraction into an :class:`AskContext`.

    Per R2.5 and R2.6 this runs *before* any Ask response is generated:
    steering guides under ``.zoc/steering`` are compiled in lexical order
    (skipping unreadable files), and the RAG_Matcher extracts code fragments
    relevant to ``prompt``. ``steering_dir`` defaults to
    ``<workspace_root>/.zoc/steering``; ``rag_matcher`` defaults to the no-op
    :class:`NullRagMatcher` until task 8.1 wires the real matcher.
    """
    resolved_steering_dir = (
        steering_dir
        if steering_dir is not None
        else Path(workspace_root) / DEFAULT_STEERING_DIR
    )
    steering = compile_steering(resolved_steering_dir)
    matcher: RagMatcher = rag_matcher if rag_matcher is not None else NullRagMatcher()
    fragments = tuple(matcher.extract(prompt))
    return AskContext(
        steering=steering,
        rag_fragments=fragments,
        project_instructions=read_project_instructions(workspace_root),
    )


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
        workspace_root: Path | str = ".",
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
    """

    mode = Mode.AGENT
    skip_planner = False

    def __init__(
        self,
        *,
        fsm: FSM | None = None,
        toolset: FullToolset | None = None,
    ) -> None:
        self.fsm = fsm if fsm is not None else FSM(initial=Stage.INTAKE)
        self.toolset = toolset if toolset is not None else FullToolset()

    @property
    def is_read_only(self) -> bool:
        return False


class ModeRouter:
    """Routes a request to the correct execution path (R2.1, R3.1)."""

    def route(self, req: AgentRunRequest) -> ExecutionPath:
        """Dispatch ``req`` to the Ask or Agent path by its ``mode``.

        ``mode = "ask"`` yields an :class:`AskPath` (``skip_planner = True``,
        :class:`ReadOnlyToolset`); any other mode yields an :class:`AgentPath`
        (FSM at :attr:`Stage.INTAKE`, :class:`FullToolset`).
        """
        if req.mode == Mode.ASK:
            return AskPath(skip_planner=True, toolset=ReadOnlyToolset())
        return AgentPath(fsm=FSM(initial=Stage.INTAKE), toolset=FullToolset())
