"""End-to-end run pipeline composition for the gateway (task 14.1).

This module is the *composition root* that wires every layer of the Ecosystem
into a single, runnable backend path for one agent run, so no component is left
orphaned and every event travels one ordered path to the SSE bus while being
mirrored to the Tier 1 Session_Diary (R9.3) in FSM production order (R6.5).

The path it assembles, top to bottom:

``Mode_Router`` routes the request → the ``Model_Allocator`` selects a tier and
sizes the context window, and the run's **first emitted event** carries that
tier/window (and any R1.6 fallback reason) as an ``IntentEvent`` via
:func:`~zocai_gateway.intent_event.allocation_stage_event_factory` (R1.9) → the
``Orchestrator`` drives the 9-stage ``FSM`` with the ``EditCoordinator`` → the
Context Bus (``RAG_Matcher`` + ``Steering_Compiler`` + ``MCP_Gateway`` + token
gate + ``shell_fs`` adapters) enriches the prompt → every produced event is
re-stamped onto a single monotonic sequence and pushed through the run's
``EmitGate`` (which validates, orders, and non-blockingly mirrors to the
``Diary_Worker``) → on the error-recovery / file-iteration ceiling the
``HotSwapCoordinator`` freezes the loop and serializes run state to the
``State_Wrapper`` (R11.1) → on a verified ``DONE`` the ``Evolution_Engine``
records the trajectory.

Ask runs are routed to the text-only channel (R6.6): the ``AskPath`` compiles
steering + RAG first (R2.5/R2.6) and the response streams as raw text chunks.

The model "brain" (tier signals, edit plan, RUN_CHECKS outcome, remediation,
Ask answer) is injected behind :class:`AgentBrain` so the whole graph is
runnable and testable without a real model runtime; :class:`DefaultAgentBrain`
is a deterministic stand-in that produces an empty plan and a passing check, so
a default agent run walks INTAKE→…→DONE cleanly.
"""

from __future__ import annotations

import asyncio
import contextlib
import functools
import itertools
import json
import logging
import os
import shutil
import tempfile
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from enum import Enum
from pathlib import Path
from typing import Protocol

from pydantic import ValidationError
from shared_schema.agent_events import (
    AgentEvent,
    ApprovalEvent,
    BudgetEvent,
    CommandEvent,
    PermissionEvent,
    PermissionKind,
    PlanEvent,
    PlanReadyEvent,
    PlanReadyStep,
    PlanUpdateEvent,
    ReadFileRef,
    ReadFilesEvent,
    RecoveryAttemptEvent,
    ReviewCheck,
    ReviewEvent,
    ReviewFile,
    ReviewValidation,
    SummaryEvent,
    TestResultsEvent,
    ThinkingEvent,
)
from shared_schema.agent_events import (
    ContextCompressedEvent as ContextCompressedContractEvent,
)
from shared_schema.agent_events import (
    MapFilesEvent as MapFilesContractEvent,
)
from zocai_evolution import (
    CheckOutcome as EvoCheckOutcome,
)
from zocai_evolution import (
    CompletedRun,
    EvolutionEngine,
)
from zocai_evolution import (
    Diff as EvoDiff,
)
from zocai_evolution import (
    Stage as EvoStage,
)

from zocai_gateway.atomic_fs import (
    AtomicFileTransaction,
    CheckpointError,
    git_checkpoint,
    sha256_file,
)
from zocai_gateway.channel import ModeChannel, TextSink, channel_for
from zocai_gateway.context.mcp_gateway import MCPGateway
from zocai_gateway.context.mcp_host.host import MCPHost
from zocai_gateway.context.mcp_host.models import McpToolRecord, ToolCallOutcome, ToolCallSuccess
from zocai_gateway.context.project_instructions import (
    prepend_project_instructions,
    read_project_instructions,
)
from zocai_gateway.context.rag_matcher import (
    NullRagMatcher,
    RagFragment,
    RagMatcher,
    WorkspaceRagMatcher,
)
from zocai_gateway.context.shell_fs import FSReadAdapter, ShellSpawner
from zocai_gateway.context.steering_compiler import (
    DEFAULT_STEERING_DIR,
    PER_FILE_TOKEN_CAP,
    FileSelector,
    MapFilesError,
    MapFilesEvent,
    SteeringPayload,
    build_read_files_payload,
    compile_steering,
    preapproved_writes,
    runtime_file_selector,
    select_map_files,
)
from zocai_gateway.context.token_gate import (
    CHARS_PER_TOKEN,
    TokenGateResult,
    estimate_tokens,
    fit_fragments,
    sanitize_file_content,
)
from zocai_gateway.context_mentions import expand_prompt_file_mentions
from zocai_gateway.edits import EditCoordinator, EditPlan, PlannedChange
from zocai_gateway.emit_gate import EmitGate
from zocai_gateway.errors import ErrorCode
from zocai_gateway.file_locks import (
    DEFAULT_LOCK_TIMEOUT_SECONDS,
    FileLockRegistry,
    LockAcquisition,
)
from zocai_gateway.fsm import FSM, EmitSink
from zocai_gateway.hardware_probe import HardwareProfile
from zocai_gateway.hot_swap import HotSwapCoordinator, HotSwapResult, ModelLoader
from zocai_gateway.intent_event import (
    DEFAULT_INTENT_TEXT,
    allocation_stage_event_factory,
)
from zocai_gateway.memory.hermes_evolution import HermesEvolution
from zocai_gateway.memory.matrix import (
    CompressionError,
    ConversationMemory,
    MemoryMatrix,
    Message,
    Role,
    runtime_summarizer,
    tokenizer_kind_for_tier,
)
from zocai_gateway.memory.project_memory import (
    FactExtractionPrompt,
    ProjectMemoryStore,
    parse_extracted_facts,
    render_memory_prompt,
    top_facts,
)
from zocai_gateway.memory.state_wrapper import (
    Diff,
    FailureRecord,
    StateWrapper,
    StateWrapperStore,
)
from zocai_gateway.mode_router import (
    AgentRunRequest,
    AskContext,
    AskError,
    AskPath,
    AskResponse,
    Capability,
    Decision,
    Mode,
    ModeRouter,
    SwitchToAgentMessage,
    check_capability,
)
from zocai_gateway.model_allocator import Allocation, AllocationAborted, ModelAllocator
from zocai_gateway.model_interface import Cloud, Edge, LocalSLM, ModelInterface, ModelTier
from zocai_gateway.model_runtime import (
    ModelContextWindowError,
    ModelRuntimeError,
    ProviderAuthError,
    generate_text,
    generate_text_stream,
    generate_with_tools,
)
from zocai_gateway.orchestrator import Orchestrator
from zocai_gateway.plan import AgentPlan
from zocai_gateway.project_tests import (
    ProjectTestCommand,
    ProjectTestResult,
    detect_project_test_command,
    run_project_tests,
)
from zocai_gateway.react import McpDispatch, PermissionGate, ReActExecutor, ToolModelFn
from zocai_gateway.reasoning import split_reasoning
from zocai_gateway.remediation import RemediationLoop
from zocai_gateway.security import log_security_event
from zocai_gateway.stage_view import StageState
from zocai_gateway.stages import Stage
from zocai_gateway.toolsets import FullToolset
from zocai_gateway.verification import parse_verify_result
from zocai_gateway.workspace_index import WorkspaceIndexer

__all__ = [
    "AgentBrain",
    "AllocationSignals",
    "ApplyExecutor",
    "ApplyResult",
    "ApplyStrategy",
    "DefaultAgentBrain",
    "ReActApplyExecutor",
    "RunContext",
    "RunPipeline",
    "RunResult",
    "RuntimeAgentBrain",
    "SinglePassApplyExecutor",
    "TextSink",
    "default_model_loader",
    "default_workspace_rag_matcher",
    "execute_run",
]


logger = logging.getLogger(__name__)

#: A sink for the Ask-Mode raw text token channel (R6.6). Re-exported from the
#: channel module so the app binds the run's SSE text frames to it.
#: (See :class:`zocai_gateway.channel.TextSink`.)

#: A Session_Diary append sink (R5.4). Matches ``DiaryWorker.append`` so the
#: remediation loop can persist captured failures; ``None`` disables it.
DiarySink = Callable[[Mapping[str, object]], object]

# A review decision waiter supplied by the FastAPI run registry. It returns the
# pydantic decision object without importing app.py into this composition root.
ReviewDecisionWaiter = Callable[[float | None], object | None]
ProjectTestRunner = Callable[[Path, ProjectTestCommand], ProjectTestResult]
PermissionAuthorizer = Callable[[PermissionKind, str, str], str | None]

_PERMISSION_DECISION_TIMEOUT_SECONDS = 300.0

_ISOLATED_IGNORE_NAMES = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        "node_modules",
        "target",
        "dist",
        "build",
        ".next",
        ".turbo",
        ".cache",
        "__pycache__",
        ".pytest_cache",
        ".venv",
        "venv",
    }
)

# Concrete tier stubs, one per Model_Tier, used by the default model loader so
# the hot-swap can load a replacement tier without a real runtime.
_TIER_MODELS: dict[ModelTier, Callable[[], ModelInterface]] = {
    ModelTier.LOCAL_SLM: LocalSLM,
    ModelTier.EDGE: Edge,
    ModelTier.CLOUD: Cloud,
}


def default_model_loader(tier: ModelTier) -> ModelInterface:
    """Default :data:`~zocai_gateway.hot_swap.ModelLoader`: build the tier stub."""
    return _TIER_MODELS[tier]()


def default_workspace_rag_matcher(
    workspace_root: Path | str, *, lazy: bool = False
) -> WorkspaceRagMatcher:
    """A workspace-scanning RAG_Matcher rooted at ``workspace_root`` (R8.1).

    Provided as the real-matcher factory the pipeline can be given; the default
    pipeline uses the no-op :class:`NullRagMatcher` so a synchronous run never
    blocks on scanning a large tree.

    With ``lazy=True`` (the ``--lazy-index`` posture, §9.1) the matcher skips
    the eager read pass entirely: workspace paths are enumerated into a
    64-shard index and file content is read only for the shards a query needs.
    """
    return WorkspaceRagMatcher(folders=(Path(workspace_root),), lazy=lazy)


@dataclass(frozen=True, slots=True)
class AllocationSignals:
    """The three signals the ``Model_Allocator`` scores a tier from (R1.2).

    ``hardware``/``latency_ms`` may be ``None`` to deterministically exercise
    the R1.6 Local SLM fallback; the defaults describe a reachable, modestly
    provisioned host so a low-complexity task lands on Local SLM without taking
    the fallback path.
    """

    complexity: float = 0.0
    latency_ms: float | None = 10.0
    hardware: HardwareProfile | None = field(
        default_factory=lambda: HardwareProfile(gpu_memory_gb=None, system_memory_gb=8.0)
    )


@dataclass(frozen=True, slots=True)
class RunContext:
    """The enriched context payload assembled by the Context Bus for a run.

    Carries the allocation it was sized against, project instructions, the
    token-gated RAG fragments that fit the window (R8.5), the compiled steering
    payload (R8.2), and MCP tool identifiers available to the run (R8.3).
    """

    allocation: Allocation
    fragments: tuple[RagFragment, ...]
    steering: SteeringPayload
    token_gate: TokenGateResult
    mcp_tools: tuple[str, ...]
    project_instructions: str = ""
    scratchpad: str = ""
    read_files_payload: str = ""
    conversation_history: str = ""


class AgentBrain(Protocol):
    """The injected model behavior the pipeline drives (test/runtime seam).

    Implementations decide the tier signals, the edit plan, the RUN_CHECKS
    outcome, any remediation plan, and the Ask answer. The pipeline owns all
    orchestration, emission, and persistence around these decisions.
    """

    def allocation_signals(self, request: AgentRunRequest) -> AllocationSignals: ...

    def think(self, request: AgentRunRequest, context: RunContext) -> str: ...

    def structured_plan(self, request: AgentRunRequest, context: RunContext) -> AgentPlan: ...

    def edit_plan(self, request: AgentRunRequest, context: RunContext) -> EditPlan: ...

    def run_checks(self, request: AgentRunRequest, plan: EditPlan) -> tuple[int, str, str]: ...

    def remediation_plan(self, prior: EditPlan, failure: object) -> EditPlan | None: ...

    def ask_response(self, prompt: str, context: AskContext) -> str: ...


class DefaultAgentBrain:
    """Deterministic stand-in brain so a run is fully exercisable (no model).

    Selects a low-complexity (Local SLM) tier, plans no edits — so PLAN_EDITS
    skips straight to RUN_CHECKS (R3.8) — reports a passing check so the FSM
    advances to SUMMARY then DONE, never proposes a remediation, and echoes the
    prompt back as the Ask answer when no runtime model is configured.
    """

    def allocation_signals(self, request: AgentRunRequest) -> AllocationSignals:
        return AllocationSignals()

    def think(self, request: AgentRunRequest, context: RunContext) -> str:
        return ""

    def structured_plan(self, request: AgentRunRequest, context: RunContext) -> AgentPlan:
        return AgentPlan(steps=[], verification_command=None, confidence=1.0)

    def edit_plan(self, request: AgentRunRequest, context: RunContext) -> EditPlan:
        return EditPlan(reasoning=f"no changes required for: {request.prompt}")

    def run_checks(self, request: AgentRunRequest, plan: EditPlan) -> tuple[int, str, str]:
        return (0, "noop-check", "")

    def remediation_plan(self, prior: EditPlan, failure: object) -> EditPlan | None:
        return None

    def ask_response(self, prompt: str, context: AskContext) -> str:
        return prompt


class ModelUnavailableError(RuntimeError):
    """A model transport/provider failure that closes the run, naming the provider (R6.6).

    This is the *real* failure that the old fail-closed thinking path conflated
    with a merely-missing ``<think>`` block: the model endpoint could not be
    reached or returned a provider-level error. It carries the provider id so the
    run driver's ``fsm.fail(reason)`` → ``ERROR_CLOSED`` names it, and the error
    frame the frontend renders points at the right provider. Missing reasoning
    markup is *not* this — it degrades silently (see :func:`split_reasoning`).
    """

    def __init__(self, *, provider: str | None, cause: Exception | None = None) -> None:
        self.provider = provider
        self.cause = cause
        name = provider or "unknown"
        detail = f": {cause}" if cause is not None else ""
        super().__init__(f"model provider {name!r} is unavailable{detail}")


class RuntimeAgentBrain(DefaultAgentBrain):
    """Model-backed Agent brain used by the desktop runtime.

    The planner asks the selected provider for a JSON edit plan. It is
    deliberately conservative: malformed JSON or incomplete change objects do
    not produce file writes, but the model's text is still surfaced as the
    PLAN_EDITS reasoning event so the run completes visibly.
    """

    def __init__(self) -> None:
        self._request: AgentRunRequest | None = None
        self._context: RunContext | None = None
        self._structured_plan: AgentPlan | None = None
        #: The response body from the ANALYZE step when the model emitted no
        #: reasoning block — treated as the analysis result (R6.2) and folded
        #: into the planning prompt so a non-reasoning model's answer still
        #: informs the plan.
        self._last_analysis: str = ""

    def update_context(self, context: RunContext) -> None:
        self._context = context

    def think(self, request: AgentRunRequest, context: RunContext) -> str:
        thinking_request = request.model_copy(update={"max_tokens": 1024})
        try:
            text = generate_text(
                thinking_request,
                system_prompt=_thinking_system_prompt(
                    context, user_prompt=thinking_request.prompt
                ),
                timeout=60.0,
            )
        except ModelContextWindowError:
            raise
        except ModelRuntimeError as exc:
            # R6.6: a transport/provider failure is a real failure and closes
            # the run, naming the provider. Missing reasoning markup is not — it
            # degrades silently below.
            raise ModelUnavailableError(provider=request.provider, cause=exc) from exc
        split = split_reasoning(text or "")
        # R6.2: with no complete <think> block the whole response is the analysis
        # result; keep it so the planning prompt still benefits from a
        # non-reasoning model's answer. A missing block is logged at debug, not
        # warning — it is the normal case for most GGUF models.
        self._last_analysis = split.body
        if not split.had_block and split.body:
            logger.debug(
                "thinking response carried no <think> block; treating the body "
                "as the analysis result"
            )
        # R6.2/R6.3: "" reasoning is a valid answer — the caller advances the
        # Stage_Machine and emits no ThinkingEvent for it (R6.5).
        return split.reasoning

    def structured_plan(self, request: AgentRunRequest, context: RunContext) -> AgentPlan:
        self._request = request
        self._context = context
        # R6.2: when the ANALYZE step produced no reasoning block, the response
        # body was kept as the analysis result. Fold it into the planning
        # context (only when there is no reasoning scratchpad already) so a
        # non-reasoning model's answer still informs the plan.
        if not context.scratchpad and self._last_analysis:
            context = replace(context, scratchpad=self._last_analysis)
        response_format = _agent_plan_response_format()
        supports_response_format = (request.provider or "").lower() != "anthropic"
        system_prompt = _structured_plan_system_prompt(
            context,
            include_schema=not supports_response_format,
            user_prompt=request.prompt,
        )
        try:
            text = generate_text(
                request,
                system_prompt=system_prompt,
                response_format=response_format if supports_response_format else None,
                timeout=120.0,
            )
        except ModelContextWindowError:
            raise
        except ModelRuntimeError:
            if not supports_response_format:
                raise
            supports_response_format = False
            text = generate_text(
                request,
                system_prompt=_structured_plan_system_prompt(
                    context,
                    include_schema=True,
                    user_prompt=request.prompt,
                ),
                timeout=120.0,
            )
        if not text:
            plan = super().structured_plan(request, context)
            self._structured_plan = plan
            return plan
        try:
            plan = _agent_plan_from_model_text(text)
        except ValidationError as exc:
            retry_request = request.model_copy(
                update={
                    "prompt": (
                        f"{request.prompt}\n\nYour previous plan had this JSON error: "
                        f"{exc}. Correct it and try again."
                    )
                }
            )
            retry = generate_text(
                retry_request,
                system_prompt=_structured_plan_system_prompt(
                    context,
                    include_schema=not supports_response_format,
                    user_prompt=retry_request.prompt,
                ),
                response_format=response_format if supports_response_format else None,
                timeout=120.0,
            )
            if not retry:
                raise RuntimeError("model returned an empty corrected plan") from exc
            try:
                plan = _agent_plan_from_model_text(retry)
            except ValidationError as retry_exc:
                raise RuntimeError(
                    f"model returned an invalid structured plan after retry: {retry_exc}"
                ) from retry_exc
        self._structured_plan = plan
        return plan

    def edit_plan(self, request: AgentRunRequest, context: RunContext) -> EditPlan:
        self._request = request
        self._context = context
        try:
            text = generate_text(
                request,
                system_prompt=_agent_system_prompt(
                    context,
                    self._structured_plan,
                    user_prompt=request.prompt,
                ),
                timeout=120.0,
            )
        except ModelContextWindowError:
            raise
        except ModelRuntimeError as exc:
            raise RuntimeError(f"model planner failed: {exc}") from exc
        if not text:
            return super().edit_plan(request, context)
        return _edit_plan_from_model_text(text)

    def remediation_plan(self, prior: EditPlan, failure: object) -> EditPlan | None:
        """Feed failed test output into the next planner call."""
        request = self._request
        context = self._context
        if request is None or context is None or not isinstance(failure, FailureRecord):
            return None
        output = failure.log[-2_000:]
        verify_result = parse_verify_result(failure.command, failure.log, failure.exit_code)
        failed_tests = "\n".join(f"- {name}" for name in verify_result.failures)
        prior_steps = "\n".join(
            f"- {change.path}: {change.diff or 'full-file replacement'}" for change in prior.changes
        )
        retry_prompt = (
            f"{request.prompt}\n\n"
            "The previous code changes failed the project test command. "
            "Return the minimum corrected edit plan that addresses this failure.\n"
            f"Previously applied plan steps:\n{prior_steps or '- no file changes'}\n"
            f"Failed tests:\n{failed_tests}\n"
            f"Command: {failure.command}\n"
            f"Exit code: {failure.exit_code}\n"
            f"Test output:\n{output}"
        )
        try:
            remediation_request = request.model_copy(update={"prompt": retry_prompt})
            text = generate_text(
                remediation_request,
                system_prompt=_agent_system_prompt(
                    context,
                    self._structured_plan,
                    user_prompt=retry_prompt,
                ),
                timeout=120.0,
            )
        except ModelContextWindowError:
            raise
        except ModelRuntimeError as exc:
            raise RuntimeError(f"model remediation failed: {exc}") from exc
        if not text:
            return None
        plan = _edit_plan_from_model_text(text)
        return EditPlan(
            reasoning=f"{plan.reasoning}\nFailed command: {failure.command}",
            changes=plan.changes,
        )


THINKING_SYSTEM_PROMPT = (
    "You are thinking through a coding task privately.\n"
    "Wrap ALL your reasoning in <think>...</think>.\n"
    "After the closing tag, output nothing else.\n"
    "Consider: what files are relevant? what could go wrong? what is the "
    "minimum set of changes? are there edge cases?"
)

# The allocator's window covers the complete chat template, not only retrieved
# RAG fragments. Reserve 40% for provider chat-template overhead and generation;
# the remaining 60% is shared by the user prompt and system context. The
# tokenizer-free estimate intentionally stays conservative for source code.
_MODEL_INPUT_BUDGET_RATIO = 0.60
_PROJECT_INSTRUCTIONS_TOKEN_CAP = 512
_PROMPT_TRUNCATION_MARKER = "[Context trimmed to fit the model window.]"


def _truncate_prompt_section(text: str, token_budget: int) -> str:
    """Keep the start of one optional prompt section within ``token_budget``."""
    if not text.strip() or token_budget <= 0:
        return ""
    if estimate_tokens(text) <= token_budget:
        return text
    clean = text.strip()
    marker_cost = estimate_tokens(_PROMPT_TRUNCATION_MARKER) + 1
    if token_budget <= marker_cost:
        return ""
    max_chars = max(0, (token_budget - marker_cost) * CHARS_PER_TOKEN)
    return f"{clean[:max_chars].rstrip()}\n{_PROMPT_TRUNCATION_MARKER}"


def _bounded_system_prompt(
    context: RunContext,
    *,
    core_sections: Sequence[str],
    optional_sections: Sequence[str] = (),
    user_prompt: str = "",
) -> str:
    """Build a complete model system prompt within the allocator input budget.

    Core output/protocol instructions are never displaced by workspace data.
    Project instructions remain before the built-in prompt, but are capped;
    optional sections are admitted in priority order and the first oversized
    section is truncated. Conversation history is intentionally not a section:
    the user prompt, scratchpad, selected files, and structured plan already
    carry the same information and previously appeared twice in every planner
    request.
    """
    total_budget = max(512, int(context.allocation.context_window * _MODEL_INPUT_BUDGET_RATIO))
    core = "\n\n".join(section.strip() for section in core_sections if section.strip())
    user_cost = estimate_tokens(user_prompt)
    core_cost = estimate_tokens(core)
    required_cost = user_cost + core_cost + 1
    if required_cost > total_budget:
        raise ModelContextWindowError(required_cost, total_budget)
    system_budget = max(1, total_budget - user_cost)

    # Preserve the historical project-instructions-before-built-ins contract,
    # while preventing a large instructions file from consuming the protocol.
    project_budget = max(
        0,
        min(_PROJECT_INSTRUCTIONS_TOKEN_CAP, system_budget - core_cost - 1),
    )
    project = _truncate_prompt_section(context.project_instructions, project_budget)
    prompt = prepend_project_instructions(core, project)
    if estimate_tokens(prompt) > system_budget:
        # Estimator rounding around the separator can overshoot by a token.
        # Drop project text rather than truncating the non-negotiable protocol.
        prompt = core

    parts = [prompt]
    used = estimate_tokens(prompt)
    for section in optional_sections:
        if not section.strip():
            continue
        remaining = system_budget - used - 1
        if remaining <= 0:
            break
        fitted = _truncate_prompt_section(section, remaining)
        if not fitted:
            break
        parts.append(fitted)
        used += estimate_tokens(fitted) + 1
        if fitted.endswith(_PROMPT_TRUNCATION_MARKER):
            break
    return "\n\n".join(parts)


def _thinking_system_prompt(context: RunContext, *, user_prompt: str = "") -> str:
    return _bounded_system_prompt(
        context,
        core_sections=(THINKING_SYSTEM_PROMPT,),
        user_prompt=user_prompt,
    )


def _agent_plan_response_format() -> dict[str, object]:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "agent_plan",
            "strict": True,
            "schema": AgentPlan.model_json_schema(),
        },
    }


def _structured_plan_system_prompt(
    context: RunContext,
    *,
    include_schema: bool,
    user_prompt: str = "",
) -> str:
    core = [
        "Create a concise, ordered edit plan for the coding task. Return only "
        "JSON matching the AgentPlan schema. Paths must be workspace-relative, "
        "rationales must be one sentence, and search strings must be exact.",
    ]
    if include_schema:
        core.append(
            "AgentPlan schema (JSON, also valid YAML):\n"
            + json.dumps(AgentPlan.model_json_schema(), indent=2, sort_keys=True)
        )
    optional: list[str] = []
    if context.read_files_payload:
        optional.append(f"Selected workspace files:\n{context.read_files_payload}")
    if context.scratchpad:
        optional.append(f"Private planning scratchpad:\n{context.scratchpad}")
    return _bounded_system_prompt(
        context,
        core_sections=core,
        optional_sections=optional,
        user_prompt=user_prompt,
    )


def _agent_plan_from_model_text(text: str) -> AgentPlan:
    raw = text.strip()
    if raw.startswith("```"):
        raw = raw.strip("`").strip()
        if raw.lower().startswith("json"):
            raw = raw[4:].strip()
    return AgentPlan.model_validate_json(raw)


def _ask_system_prompt(context: AskContext) -> str:
    parts = [
        "You are Zoc Ask, a read-only coding assistant. Answer clearly and do "
        "not claim to edit, run commands, or modify files.",
    ]
    steering = context.steering.text.strip()
    if steering:
        parts.append(f"Project steering:\n{steering}")
    if context.rag_fragments:
        fragments = []
        for fragment in context.rag_fragments[:8]:
            fragments.append(f"{fragment.path}:\n{fragment.content}")
        parts.append("Relevant code context:\n\n" + "\n\n".join(fragments))
    return prepend_project_instructions("\n\n".join(parts), context.project_instructions)


def _agent_system_prompt(
    context: RunContext,
    structured_plan: AgentPlan | None = None,
    *,
    user_prompt: str = "",
) -> str:
    core = [
        "You are Zoc Agent, a coding agent planner. Return only JSON with this "
        'shape: {"reasoning":"short explanation","changes":[{"path":"relative/path","content":"full replacement file content","diff":"short summary"}]}.',
        "Only include a change when you know the exact full replacement file "
        "content. If the request is only chat or you are unsure, return an "
        "empty changes array with useful reasoning.",
    ]
    optional: list[str] = []
    if structured_plan is not None:
        optional.append(
            "Approved structured plan:\n" + structured_plan.model_dump_json(exclude_none=True)
        )
    if context.read_files_payload:
        optional.append(f"Selected workspace files:\n{context.read_files_payload}")
    if context.scratchpad:
        optional.append(f"Private planning scratchpad:\n{context.scratchpad}")
    steering = context.steering.text.strip()
    if steering:
        optional.append(f"Project steering:\n{steering}")
    if context.fragments:
        fragments = [
            f"{fragment.path}:\n{fragment.content}" for fragment in context.fragments[:8]
        ]
        optional.append("Relevant code context:\n\n" + "\n\n".join(fragments))
    if context.mcp_tools:
        optional.append("Available MCP tools: " + ", ".join(context.mcp_tools))
    return _bounded_system_prompt(
        context,
        core_sections=core,
        optional_sections=optional,
        user_prompt=user_prompt,
    )


def _edit_plan_from_model_text(text: str) -> EditPlan:
    raw = text.strip()
    if raw.startswith("```"):
        raw = raw.strip("`").strip()
        if raw.lower().startswith("json"):
            raw = raw[4:].strip()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return EditPlan(reasoning=text.strip(), changes=())
    if not isinstance(payload, dict):
        return EditPlan(reasoning=text.strip(), changes=())
    reasoning = payload.get("reasoning")
    if not isinstance(reasoning, str) or not reasoning.strip():
        reasoning = text.strip()
    changes_raw = payload.get("changes")
    changes: list[PlannedChange] = []
    if isinstance(changes_raw, list):
        for item in changes_raw:
            if not isinstance(item, dict):
                continue
            path = item.get("path")
            content = item.get("content")
            diff = item.get("diff", "")
            if not isinstance(path, str) or not path.strip():
                continue
            if not isinstance(content, str):
                continue
            changes.append(
                PlannedChange(
                    path=path.strip().lstrip("/"),
                    content=content,
                    diff=diff if isinstance(diff, str) else "",
                )
            )
    return EditPlan(reasoning=reasoning.strip(), changes=tuple(changes))


def _estimate_edit_plan_tokens(plan: EditPlan) -> int:
    """Estimate model-output tokens represented by a normalized edit plan."""
    parts = [plan.reasoning]
    for change in plan.changes:
        parts.extend((change.path, change.content, change.diff))
    return sum(estimate_tokens(part) for part in parts)


class RunCancelled(Exception):
    """Raised at a safe pipeline boundary after a client stops one run."""


@dataclass(frozen=True, slots=True)
class RunResult:
    """The terminal outcome of driving a run through the pipeline.

    ``stage`` is the FSM stage the run ended on (``DONE`` on the happy path,
    ``ERROR_CLOSED`` on an unrecoverable apply failure, ``PAUSED`` on a budget
    ceiling or a developer defer). ``stages`` is the ordered stage trail used
    for the evolution trajectory. ``hot_swap`` is set when a budget ceiling
    triggered a hot-swap (R11.1).
    """

    mode: Mode
    run_id: str
    stage: Stage
    stages: tuple[Stage, ...]
    allocation: Allocation | None = None
    paused: bool = False
    deferred: bool = False
    hot_swap: HotSwapResult | None = None
    ask_text: str | None = None


# Maps each gateway FSM stage onto the evolution engine's mirror enum by value.
def _to_evo_stage(stage: Stage) -> EvoStage:
    return EvoStage(stage.value)


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _diff_stats(diff: str) -> tuple[int, int]:
    adds = 0
    dels = 0
    for line in diff.splitlines():
        if line.startswith("+++") or line.startswith("---"):
            continue
        if line.startswith("+"):
            adds += 1
        elif line.startswith("-"):
            dels += 1
    return adds, dels


def _diff_summary(diff: str) -> str | None:
    for line in diff.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith(("+++", "---", "@@")):
            return stripped[:160]
    return None


def _tail(text: str, limit: int = 8000) -> str:
    if not text:
        return ""
    return text[-limit:]


def _is_noop_check(command: str) -> bool:
    return not command.strip() or command.strip() == "noop-check"


def _validation_from_checks(checks: list[tuple[str, int]]) -> ReviewValidation:
    if not checks:
        return ReviewValidation()
    command, exit_code = checks[-1]
    if _is_noop_check(command):
        return ReviewValidation()
    return ReviewValidation(
        typecheck=ReviewCheck(status="skipped"),
        build=ReviewCheck(status="skipped"),
        tests=ReviewCheck(status="pass" if exit_code == 0 else "fail"),
    )


def _safe_relative_path(raw_path: str) -> Path:
    rel = Path(raw_path)
    if rel.is_absolute() or ".." in rel.parts:
        log_security_event(
            "path_traversal",
            "blocked unsafe review path",
            path=raw_path,
            operation="review_apply",
        )
        raise ValueError(f"unsafe review path: {raw_path!r}")
    return rel


def _edit_step_label(action: str, file: str, rationale: str) -> str:
    """Build the per-EditStep plan-item label (R5.4, R5.5).

    The label always names the Action and the file; the Rationale is appended
    only when it is non-blank (R5.4). When the Rationale is empty or contains
    only whitespace the label is ``"{Action} {file}"`` (R5.5).
    """
    prefix = f"{action.capitalize()} {file}"
    trimmed = rationale.strip()
    return f"{prefix}: {trimmed}" if trimmed else prefix


# ── Plan mode approval gate (§12.2) ──────────────────────────────────────────

#: How long a Plan-mode run waits for the user's approve/reject. Generous
#: because a human is reading a diff; bounded so an abandoned run cannot pin a
#: worker thread forever.
_PLAN_APPROVAL_TIMEOUT_SECONDS = 1800.0


@dataclass(frozen=True, slots=True)
class _PlanGate:
    """Outcome of the Plan-mode approval gate.

    ``accepted_paths`` is ``None`` when the user approved the plan as-is and a
    tuple of workspace-relative paths when they deselected individual steps.
    """

    approved: bool
    accepted_paths: tuple[str, ...] | None


def _restrict_plan_to_paths(
    structured_plan: AgentPlan,
    plan: EditPlan,
    accepted: tuple[str, ...],
) -> tuple[AgentPlan, EditPlan]:
    """Drop every plan step and change whose file was not accepted (§12.2).

    Unchecking a step in the review UI must *remove* it, not merely hide it, so
    the filtering happens on the plan the executor receives. Path comparison is
    normalised on separators because the plan is workspace-relative POSIX while a
    client may echo back either form.
    """
    wanted = {path.replace("\\", "/") for path in accepted}
    steps = [step for step in structured_plan.steps if step.file.replace("\\", "/") in wanted]
    changes = [change for change in plan.changes if change.path.replace("\\", "/") in wanted]
    return (
        structured_plan.model_copy(update={"steps": steps}),
        replace(plan, changes=tuple(changes)),
    )


# ── APPLY_EDITS strategy seam (Req 8, R3.7-R3.9) ─────────────────────────────


@dataclass(frozen=True, slots=True)
class _RunMcpSeam:
    """Run-bound bridge: exposes aggregated MCP tools to the toolset and proxies
    calls through the host with the run's emit/approval channel (Part 4, R5.5)."""

    host: MCPHost
    run_id: str
    emit: EmitSink
    await_decision: Callable[[], Awaitable[str]]

    def list_tools(self) -> list[McpToolRecord]:
        return self.host.registry.list()

    async def proxy(self, namespaced_name: str, arguments: Mapping[str, object]) -> ToolCallOutcome:
        return await self.host.proxy_tool_call(
            namespaced_name,
            arguments,
            run_id=self.run_id,
            emit=self.emit,
            await_decision=self.await_decision,
        )


class ApplyStrategy(str, Enum):
    """Which APPLY_EDITS executor a run drives (design "strategy seam").

    Defaults to :attr:`SINGLE_PASS` so the net-new ReAct loop is additive and
    instantly reversible: leaving the default in place restores the legacy
    single-shot apply exactly.
    """

    SINGLE_PASS = "single_pass"
    REACT = "react"


@dataclass(frozen=True, slots=True)
class ApplyResult:
    """The uniform result of an APPLY_EDITS pass, whichever strategy produced it.

    ``applied`` are the diffs written (retained even on failure, R3.9),
    ``satisfied_step_ids`` the ``edit-{index}`` ids marked done, ``wrote_code``
    whether any file changed (drives post-write verification), ``failed`` /
    ``error`` an unrecoverable apply failure (→ ERROR_CLOSED, R3.9), and
    ``paused`` a file-iteration-ceiling pause (→ PAUSED, R10.2/10.7).
    """

    applied: tuple[Diff, ...] = ()
    satisfied_step_ids: tuple[str, ...] = ()
    wrote_code: bool = False
    failed: bool = False
    error: str | None = None
    paused: bool = False


class ApplyExecutor(Protocol):
    """Applies an approved plan and returns a uniform :class:`ApplyResult`."""

    def apply(self) -> ApplyResult: ...


@dataclass(slots=True)
class SinglePassApplyExecutor:
    """Legacy single-shot apply: ``EditCoordinator.apply_edits`` in one pass.

    Behavior-preserving wrapper of the pre-seam APPLY_EDITS body: writes the
    pre-computed ``EditPlan`` through the confined toolset (R3.7), counts each
    applied change against the file budget (R10.1), emits ``plan-update`` done
    for each structured step whose file was applied (R5.6), and reports an
    apply failure for the ERROR_CLOSED path (R3.9).
    """

    edits: EditCoordinator
    orchestrator: Orchestrator
    plan: EditPlan
    structured_plan: AgentPlan
    emit_plan_update: Callable[[str, str], None]
    emit_budget: Callable[[], None]
    authorize_tool: PermissionAuthorizer

    def apply(self) -> ApplyResult:
        # Preflight the whole plan before the first mutation. Besides ensuring
        # every legacy/single-pass tool invocation is permission-checked, this
        # prevents a denial on a later file from leaving earlier files changed.
        for change in self.plan.changes:
            blocked_reason = self.authorize_tool("fs", "write_file", change.path)
            if blocked_reason is not None:
                return ApplyResult(failed=True, error=blocked_reason)

        outcome = self.edits.apply_edits(self.plan)
        applied = tuple(Diff(path=c.path, diff=c.diff) for c in outcome.applied)
        for change in outcome.applied:
            self.orchestrator.active_file_markers.append(change.path)
            self.orchestrator.budget.count_file_op()  # R10.1 / R4.1
        applied_paths = {change.path for change in outcome.applied}
        satisfied: list[str] = []
        for index, step in enumerate(self.structured_plan.steps, start=1):
            if step.file in applied_paths:
                self.emit_plan_update(f"edit-{index}", "done")  # R5.6
                satisfied.append(f"edit-{index}")
        self.emit_budget()  # R10.4
        return ApplyResult(
            applied=applied,
            satisfied_step_ids=tuple(satisfied),
            wrote_code=bool(outcome.applied),
            failed=outcome.failed is not None,
            error=outcome.error,
            paused=outcome.paused,
        )


@dataclass(slots=True)
class ReActApplyExecutor:
    """ReAct multi-step apply: drives a :class:`ReActExecutor` over the toolset.

    Constructs the ReAct loop over the run's toolset/orchestrator/AgentPlan and
    the single ordered emit boundary, then maps its ``ReActOutcome`` onto the
    uniform :class:`ApplyResult` (R8/R9/R10.1).
    """

    toolset: FullToolset
    orchestrator: Orchestrator
    structured_plan: AgentPlan
    request: AgentRunRequest
    context: RunContext
    emit: EmitSink
    run_id: str
    tokens_used: int
    authorize_write: Callable[[str], bool] | None = None
    run_with_tools: ToolModelFn = generate_with_tools
    mcp_call: McpDispatch | None = None
    check_permission: PermissionGate | None = None
    wait_for_approval: ReviewDecisionWaiter | None = None
    capability_gate: Callable[[Capability], Decision] | None = None

    def apply(self) -> ApplyResult:
        outcome = ReActExecutor(
            toolset=self.toolset,
            orchestrator=self.orchestrator,
            plan=self.structured_plan,
            request=self.request,
            context=self.context,
            emit=self.emit,
            run_id=self.run_id,
            tokens_used=self.tokens_used,
            run_with_tools=self.run_with_tools,
            authorize_write=self.authorize_write,
            mcp_call=self.mcp_call,
            check_permission=self.check_permission,
            wait_for_permission=self.wait_for_approval,
            capability_gate=self.capability_gate,
        ).run()
        return ApplyResult(
            applied=outcome.applied_diffs,
            satisfied_step_ids=outcome.satisfied_step_ids,
            wrote_code=bool(outcome.applied_diffs),
            paused=outcome.paused,
        )


class RunPipeline:
    """Composes and drives the full backend path for a single run (task 14.1).

    Construction wires every layer (Mode_Router, Model_Allocator, FSM,
    EditCoordinator, Orchestrator, RemediationLoop, the Context Bus, the
    State_Wrapper store, the HotSwapCoordinator, the channel discipline, and
    the Evolution_Engine) for the run; :meth:`run` executes it. Every component
    is referenced here so none is orphaned.
    """

    def __init__(
        self,
        request: AgentRunRequest,
        run_id: str,
        *,
        gate: EmitGate,
        text_sink: TextSink,
        close: Callable[[], None],
        workspace_root: Path | str | None = ".",
        state_store: StateWrapperStore | None = None,
        evolution: EvolutionEngine | None = None,
        diary_sink: DiarySink | None = None,
        brain: AgentBrain | None = None,
        allocator: ModelAllocator | None = None,
        rag_matcher: RagMatcher | None = None,
        mcp_gateway: MCPGateway | None = None,
        model_loader: ModelLoader = default_model_loader,
        wait_for_review_decision: ReviewDecisionWaiter | None = None,
        wait_for_approval_decision: ReviewDecisionWaiter | None = None,
        file_selector: FileSelector | None = None,
        workspace_indexer: WorkspaceIndexer | None = None,
        index_session_id: str | None = None,
        hybrid_candidate_source: bool = False,
        project_test_runner: ProjectTestRunner = run_project_tests,
        apply_strategy: ApplyStrategy = ApplyStrategy.SINGLE_PASS,
        run_with_tools: ToolModelFn = generate_with_tools,
        mcp_host: MCPHost | None = None,
        mcp_loop: asyncio.AbstractEventLoop | None = None,
        check_permission: PermissionGate | None = None,
        network_allowlist: Sequence[str] | None = None,
        is_cancelled: Callable[[], bool] | None = None,
        plan_only: bool = False,
        file_locks: FileLockRegistry | None = None,
        project_memory: ProjectMemoryStore | None = None,
        hermes: HermesEvolution | None = None,
        failure_sink: Callable[[str, str], None] | None = None,
    ) -> None:
        self.run_id = run_id
        # R1.7: a root-less Ask run carries no workspace. Everything
        # workspace-dependent below is guarded so Ask answers with empty context
        # and creates nothing; Plan/Agent always resolve a real root upstream.
        self.source_workspace_root: Path | None = (
            Path(workspace_root).resolve() if workspace_root is not None else None
        )
        self.original_request = request
        self.request = request.model_copy(
            update={
                "prompt": (
                    expand_prompt_file_mentions(
                        request.prompt,
                        self.source_workspace_root,
                        request.context_files,
                    )
                    if self.source_workspace_root is not None
                    else request.prompt
                )
            }
        )
        self._close = close
        self._text_sink = text_sink
        self._failure_sink = failure_sink
        self._ask_streamed = False
        self._wait_for_review_decision = wait_for_review_decision
        self._wait_for_approval_decision = wait_for_approval_decision
        self._project_test_runner = project_test_runner
        self.apply_strategy = apply_strategy
        self._run_with_tools = run_with_tools
        self._mcp_host = mcp_host
        self._mcp_loop = mcp_loop
        self._check_permission = check_permission
        self._network_allowlist = (
            tuple(network_allowlist) if network_allowlist is not None else None
        )
        self._is_cancelled = is_cancelled or (lambda: False)
        # §12.2: Plan mode stops for approval after PLAN_EDITS. Also true when
        # the request itself selected `mode="plan"`, so the flag survives a
        # caller that forgot to pass it explicitly.
        self.plan_only = plan_only or request.mode is Mode.PLAN
        # §12.3: with several runs in flight, writes are serialised per file.
        self._file_locks = file_locks
        self._held_locks: tuple[str, ...] = ()
        # §14.1 persistent project memory; §14.2 long-term approach learning.
        self._project_memory = project_memory
        self._hermes = hermes
        self._workspace_indexer = workspace_indexer
        self._index_session_id = index_session_id or request.run_id or run_id
        self._hybrid_candidate_source = hybrid_candidate_source
        self._enforce_write_allowlist = file_selector is not None or brain is None
        self._file_selector = file_selector
        if self._file_selector is None and brain is not None:
            # Injected brains are deterministic test/runtime substitutes; keep
            # their existing runs isolated from the live provider boundary.
            self._file_selector = lambda _prompt: (
                '{"read":[],"write":[],"rationale":"injected brain"}'
            )

        self.brain: AgentBrain = brain if brain is not None else RuntimeAgentBrain()
        self.allocator = allocator if allocator is not None else ModelAllocator()
        self.rag_matcher: RagMatcher = rag_matcher if rag_matcher is not None else NullRagMatcher()
        self.mcp_gateway = mcp_gateway if mcp_gateway is not None else MCPGateway()
        self.model_loader = model_loader
        self.evolution = evolution
        self._diary_sink = diary_sink

        # Mode routing (R2.1/R3.1) selects the path; the channel enforces the
        # mode-scoped discipline: Agent = structured-only through the gate,
        # Ask = text-only (R6.6/R6.7).
        self.path = ModeRouter().route(self.request)
        self._isolated_workspace_root: Path | None = None
        self._checkpoint_id: str | None = None
        if (
            self.path.mode is Mode.AGENT
            and self.request.review_changes
            and self.source_workspace_root is not None
        ):
            self._isolated_workspace_root = self._create_isolated_workspace(
                self.source_workspace_root
            )
            self.workspace_root: Path | None = self._isolated_workspace_root
            self._checkpoint_id = f"isolated-{run_id}"
        else:
            self.workspace_root = self.source_workspace_root

        # A root-less Ask run has no matrix; state persistence is skipped and
        # the read-only adapters below are never constructed (Ask uses none).
        self.state_store: StateWrapperStore | None
        if self.source_workspace_root is not None:
            matrix = MemoryMatrix(self.source_workspace_root)
            self.state_store = (
                state_store
                if state_store is not None
                else StateWrapperStore(matrix.state_wrapper_path)
            )
        else:
            self.state_store = state_store

        mcp_seam = (
            _RunMcpSeam(
                host=self._mcp_host,
                run_id=self.run_id,
                emit=self._emit,
                await_decision=self._await_mcp_decision,
            )
            if self._mcp_host is not None
            else None
        )
        # Write/shell/read adapters only exist for a rooted run. A root-less Ask
        # run never touches them (it is read-only Q&A over empty context).
        if self.workspace_root is not None:
            self.toolset = FullToolset(
                self.workspace_root,
                mcp=mcp_seam,
                network_allowlist=self._network_allowlist,
                run_id=self.run_id,
            )
            self._mcp_dispatch = self._make_mcp_dispatch()
            self.fs_read = FSReadAdapter(self.workspace_root)
            self.shell_spawner = ShellSpawner(self.path.mode, self.workspace_root)
        else:
            # Root-less Ask never touches these; kept typed non-Optional because
            # every *use* is on the Agent/Plan path, which always has a root.
            self.toolset = None  # type: ignore[assignment]
            self._mcp_dispatch = None
            self.fs_read = None  # type: ignore[assignment]
            self.shell_spawner = None  # type: ignore[assignment]
        self._channel: ModeChannel = channel_for(self.path, gate=gate, text_sink=text_sink)
        self._next_seq: Callable[[], int] = itertools.count().__next__

    @staticmethod
    def _create_isolated_workspace(source: Path) -> Path:
        """Copy the workspace to a temp directory for review-before-apply runs."""
        target = Path(tempfile.mkdtemp(prefix="zoc-agent-review-"))
        if not source.exists():
            target.mkdir(parents=True, exist_ok=True)
            return target
        shutil.copytree(
            source,
            target,
            dirs_exist_ok=True,
            ignore=lambda _dir, names: [name for name in names if name in _ISOLATED_IGNORE_NAMES],
        )
        RunPipeline._link_isolated_dependencies(source, target)
        return target

    @staticmethod
    def _link_isolated_dependencies(source: Path, target: Path) -> None:
        """Expose installed dependencies without copying them into review workspaces."""
        dependency_names = {"node_modules", ".venv", "venv"}
        prune_names = {".git", ".hg", ".svn", "target", "dist", "build", ".cache"}
        for current, dirnames, _files in os.walk(source, followlinks=False):
            current_path = Path(current)
            for name in list(dirnames):
                if name in dependency_names:
                    source_dir = current_path / name
                    relative = source_dir.relative_to(source)
                    link = target / relative
                    link.parent.mkdir(parents=True, exist_ok=True)
                    with contextlib.suppress(OSError):
                        link.symlink_to(source_dir, target_is_directory=True)
                    dirnames.remove(name)
                elif name in prune_names:
                    dirnames.remove(name)

    def cleanup(self) -> None:
        """Remove the isolated workspace after the run has reached a terminal state."""
        # §12.3: drop any per-file write locks first, so a waiting run is
        # unblocked even if the workspace teardown below fails.
        self._release_write_locks()
        root = self._isolated_workspace_root
        if root is None:
            return
        try:
            shutil.rmtree(root, ignore_errors=True)
        finally:
            self._isolated_workspace_root = None

    def _make_mcp_dispatch(self) -> McpDispatch | None:
        """A synchronous bridge from the in-thread ReAct loop to the async MCP
        host: schedule ``proxy_tool_call`` on the host's loop and block for the
        typed outcome, normalized to ``(ok, text)`` (Part 4, §4.1)."""
        host = self._mcp_host
        loop = self._mcp_loop
        if host is None or loop is None:
            return None

        def dispatch(namespaced_name: str, arguments: Mapping[str, object]) -> tuple[bool, str]:
            future = asyncio.run_coroutine_threadsafe(
                host.proxy_tool_call(
                    namespaced_name,
                    arguments,
                    run_id=self.run_id,
                    emit=self._emit,
                    await_decision=self._await_mcp_decision,
                ),
                loop,
            )
            outcome = future.result()
            if isinstance(outcome, ToolCallSuccess):
                return True, str(outcome.result)
            return False, f"{outcome.kind.value}: {outcome.reason}"

        return dispatch

    async def _await_mcp_decision(self) -> str:
        """Await a user approval decision for a gated MCP tool without blocking
        the event loop (auto-approved tools never reach here). Fails closed
        (``reject``) after a bounded wait so a run cannot hang forever."""
        waiter = self._wait_for_approval_decision
        if waiter is None:
            return "reject"
        for _ in range(3000):  # ~5 minutes at 0.1s polls
            decision = waiter(0)
            if decision is not None:
                return "approve" if getattr(decision, "decision", None) == "approve" else "reject"
            await asyncio.sleep(0.1)
        return "reject"

    # -- single ordered emit boundary (R6.5) --------------------------------

    def _emit(self, event: AgentEvent) -> None:
        """Re-stamp ``event`` onto the single run sequence and gate it (R6.5).

        Every producer (FSM, edits, orchestrator, remediation, hot-swap) emits
        through here, so the bus carries one monotonically increasing ``seq``
        across all of them and the gate's diary mirror sees the same order
        (R9.3). Ask text chunks bypass this boundary via :attr:`_text_sink`.
        """
        payload = dict(event.model_dump(by_alias=True))
        payload["seq"] = self._next_seq()
        if not self._channel.emit_event(payload):
            logger.warning(
                "run %s dropped event type %r at seq %s",
                self.run_id,
                payload.get("type"),
                payload.get("seq"),
            )

    def _emit_scratchpad(self, scratchpad: str, elapsed_ms: int) -> None:
        self._emit(
            ThinkingEvent(
                seq=0,
                run_id=self.run_id,
                ts=_now(),
                text=scratchpad,
                collapsible=True,
                gist="Private task analysis",
                elapsed_ms=elapsed_ms,
                truncated=False,
            )
        )

    # -- per-file write locks (§12.3) ---------------------------------------

    @staticmethod
    def _planned_write_paths(structured_plan: AgentPlan, plan: EditPlan) -> tuple[str, ...]:
        """Every workspace path this run intends to write.

        Drawn from both the structured plan (what the model said it would do)
        and the concrete change list (what will actually be written), because a
        remediation pass can add a change the structured plan never mentioned.
        """
        paths = {step.file for step in structured_plan.steps}
        paths.update(change.path for change in plan.changes)
        return tuple(sorted(p for p in paths if p))

    def _acquire_write_locks(self, paths: tuple[str, ...]) -> LockAcquisition:
        """Take the per-file write locks, or explain why we cannot (§12.3).

        With no registry configured (single-run deployments and most tests) this
        is a no-op success, so behaviour is unchanged unless concurrency is
        actually enabled.
        """
        if self._file_locks is None or not paths:
            return LockAcquisition(acquired=True)

        result = self._file_locks.acquire(self.run_id, paths, timeout=DEFAULT_LOCK_TIMEOUT_SECONDS)
        if result.acquired:
            self._held_locks = result.paths
            return result

        blocked = ", ".join(result.blocked_paths)
        logger.info(
            "run %s blocked on files held by %s: %s",
            self.run_id,
            ", ".join(result.blocked_by) or "another run",
            blocked,
        )
        self._emit(
            ApprovalEvent(
                seq=0,
                run_id=self.run_id,
                ts=_now(),
                prompt=(
                    "Another run is still writing "
                    f"{blocked}. Waited "
                    f"{DEFAULT_LOCK_TIMEOUT_SECONDS:g}s without getting access, so "
                    "this run paused instead of overwriting it. Retry once the "
                    "other run finishes."
                ),
            )
        )
        return result

    def _release_write_locks(self) -> None:
        """Release anything this run still holds (idempotent)."""
        if self._file_locks is None:
            return
        self._file_locks.release_run(self.run_id)
        self._held_locks = ()

    def _await_plan_approval(self, structured_plan: AgentPlan, plan: EditPlan) -> _PlanGate:
        """Emit the plan and block until the user approves or rejects (§12.2).

        Emits a ``plan-ready`` event carrying every step (with a diff preview
        where one exists) followed by an ``approval`` event that names the
        decision being asked for. Then waits for a control-channel ``approval``
        decision.

        Fails **closed**: no waiter configured, or no answer within the timeout,
        means "not approved", so a Plan-mode run can never silently apply.
        """
        diffs = {change.path: change.diff for change in plan.changes if change.diff}
        steps = [
            PlanReadyStep(
                file=step.file,
                action=step.action,
                rationale=step.rationale,
                diff=diffs.get(step.file),
            )
            for step in structured_plan.steps
        ]
        files = {step.file for step in structured_plan.steps}
        self._emit(
            PlanReadyEvent(
                seq=0,
                run_id=self.run_id,
                ts=_now(),
                steps=steps,
                verification_command=structured_plan.verification_command,
                confidence=structured_plan.confidence,
                file_count=len(files),
            )
        )
        self._emit(
            ApprovalEvent(
                seq=0,
                run_id=self.run_id,
                ts=_now(),
                operation="apply_plan",
                prompt=(
                    f"Ready to apply {len(steps)} change"
                    f"{'' if len(steps) == 1 else 's'} to {len(files)} file"
                    f"{'' if len(files) == 1 else 's'}. "
                    "Approve to execute, reject to cancel."
                ),
            )
        )

        waiter = self._wait_for_approval_decision
        if waiter is None:
            logger.info("run %s plan not approved: no decision channel", self.run_id)
            return _PlanGate(approved=False, accepted_paths=None)
        decision = waiter(_PLAN_APPROVAL_TIMEOUT_SECONDS)
        if decision is None or getattr(decision, "decision", None) != "approve":
            return _PlanGate(approved=False, accepted_paths=None)
        # `acceptedPaths` carries the user's per-step selection; an empty list
        # means "everything", matching the decision endpoint's contract.
        raw_paths = list(getattr(decision, "accepted_paths", ()) or ())
        return _PlanGate(
            approved=True,
            accepted_paths=tuple(raw_paths) if raw_paths else None,
        )

    # -- persistent project memory (§14.1) + evolution (§14.2) --------------

    def memory_prompt_section(self) -> str:
        """The "Known facts about this project" block for INTAKE (§14.1).

        Returns ``""`` when memory is disabled or empty, so the prompt gains
        nothing on a project the agent has never seen.
        """
        store = self._project_memory
        if store is None:
            return ""
        try:
            memory = store.load()
        except Exception:  # pragma: no cover - defensive store boundary
            logger.debug("project memory unreadable", exc_info=True)
            return ""
        return render_memory_prompt(top_facts(memory, query=self.request.prompt))

    def approach_prompt_section(self) -> str:
        """The "Based on past experience…" block for INTAKE (§14.2).

        Sourced from :class:`HermesEvolution`'s learned task/approach history.
        Absent history yields ``""`` rather than a hedged sentence.
        """
        hermes = self._hermes
        if hermes is None:
            return ""
        try:
            suggestion = hermes.suggest_approach(self.request.prompt)
        except Exception:  # pragma: no cover - defensive learning boundary
            logger.debug("approach suggestion failed", exc_info=True)
            return ""
        if not suggestion:
            return ""
        approach = str(suggestion.get("approach", "")).strip()
        if not approach:
            return ""
        return f"Based on past experience, this type of task works best when: {approach}"

    def _learning_transcript(
        self,
        detail: str,
        *,
        succeeded: bool,
        applied: Sequence[Diff] = (),
        checks: Sequence[tuple[str, int]] = (),
    ) -> str:
        """Build the compact task/approach/outcome record Hermes consumes."""
        lines = [f"Task: {self.request.prompt}"]
        if applied or checks:
            lines.append(
                "The approach was to apply the generated workspace plan and "
                "verify it with the configured checks."
            )
        else:
            lines.append(
                "The approach was to analyze the request through the staged agent pipeline."
            )
        if applied:
            lines.append(
                "Changed files: " + ", ".join(str(diff.path) for diff in applied if diff.path)
            )
        if checks:
            lines.append(
                "Checks: " + ", ".join(f"{command} (exit {code})" for command, code in checks)
            )
        lines.append(f"Outcome: {'success' if succeeded else 'fail'}. {detail}")
        return "\n".join(lines)

    def _report_provider_auth(self, exc: ProviderAuthError) -> str:
        """Record a provider-auth failure with its typed code; return a safe reason.

        The returned reason names the provider and HTTP status only — never the
        response body or the API key (``ProviderAuthError`` redacts both) — and
        the failure sink stamps the typed ``provider_auth_invalid`` code so the
        streamed terminal error frame carries it instead of a generic
        ``run_failed`` (R6).
        """
        reason = str(exc)
        logger.warning(
            "run %s: provider auth rejected (HTTP %s)", self.run_id, exc.status_code
        )
        if self._failure_sink is not None:
            self._failure_sink(reason, exc.code)
        return reason

    def _remember_failure(
        self,
        reason: str,
        *,
        applied: Sequence[Diff] = (),
        checks: Sequence[tuple[str, int]] = (),
        tokens_used: int = 0,
        code: str = ErrorCode.RUN_FAILED,
    ) -> None:
        """Teach Hermes about every ERROR_CLOSED outcome (§14.2)."""
        if self._failure_sink is not None:
            self._failure_sink(reason, code)
        transcript = self._learning_transcript(
            reason,
            succeeded=False,
            applied=applied,
            checks=checks,
        )
        self._remember_run(
            applied,
            transcript,
            succeeded=False,
            tokens_used=tokens_used,
        )

    def _remember_run(
        self,
        applied: Sequence[Diff],
        summary: str,
        *,
        succeeded: bool,
        tokens_used: int = 0,
    ) -> None:
        """Persist what this run taught us (§14.1, §14.2).

        Best-effort throughout: memory is an optimisation, so a failure here is
        logged and swallowed rather than turning a successful run into an error.
        """
        transcript = summary or ""
        store = self._project_memory
        # Part 14.1 updates project facts only after a successful run. Hermes,
        # below, learns from both success and ERROR_CLOSED outcomes.
        if store is not None and succeeded:
            try:
                memory = store.load()
                store.record_run(memory, tokens_used=tokens_used)
                if succeeded and transcript:
                    facts = self._extract_facts(transcript)
                    store.merge_facts(memory, facts, run_id=self.run_id)
                for diff in applied:
                    path = getattr(diff, "path", None)
                    if path:
                        store.record_file_summary(
                            memory,
                            str(path),
                            self._summarize_file(str(path), transcript),
                            run_id=self.run_id,
                        )
                store.save(memory)
            except Exception:  # pragma: no cover - defensive store boundary
                logger.debug("project memory update failed", exc_info=True)

        hermes = self._hermes
        if hermes is not None:
            try:
                hermes.post_run(transcript, "success" if succeeded else "fail")
            except Exception:  # pragma: no cover - defensive learning boundary
                logger.debug("evolution post_run failed", exc_info=True)

    def _extract_facts(self, transcript: str) -> list[str]:
        """Ask the model for up to five facts about the codebase (§14.1).

        Falls back to no facts when no provider is configured: inventing facts
        from a heuristic would poison memory with statements no model ever made.
        """
        if not self._provider_configured():
            return []
        try:
            raw = self._run_short_completion(
                f"{FactExtractionPrompt}\n\nTranscript:\n{transcript[:6000]}"
            )
        except Exception:  # pragma: no cover - defensive model boundary
            logger.debug("fact extraction failed", exc_info=True)
            return []
        return parse_extracted_facts(raw)

    def _summarize_file(self, path: str, transcript: str) -> str:
        """One-sentence description of a written file (§14.1).

        Derived from the run summary rather than a second model call: the summary
        already describes what changed, and a per-file model call would multiply
        the cost of every run by the number of files touched.
        """
        for line in transcript.splitlines():
            if path in line and len(line.strip()) > len(path) + 4:
                return line.strip()
        return f"Modified during run {self.run_id}."

    def _run_short_completion(self, prompt: str) -> str:
        """Run a small, non-streaming completion for internal bookkeeping."""
        return self.brain.ask_response(prompt, None)  # type: ignore[arg-type]

    def _emit_plan(self, plan: EditPlan, structured_plan: AgentPlan | None = None) -> None:
        has_changes = plan.has_changes
        items = [
            {"id": "analyze", "label": "Analyze request", "status": "done"},
            {"id": "plan", "label": "Create edit plan", "status": "done"},
        ]
        if structured_plan is not None:
            items.extend(
                {
                    "id": f"edit-{index}",
                    "label": _edit_step_label(step.action, step.file, step.rationale),
                    "status": "pending",
                }
                for index, step in enumerate(structured_plan.steps, start=1)
            )
        items.extend(
            [
                {
                    "id": "apply",
                    "label": "Apply changes in isolated workspace",
                    "status": "active" if has_changes else "done",
                },
                {
                    "id": "validate",
                    "label": (
                        f"Run {structured_plan.verification_command}"
                        if structured_plan is not None and structured_plan.verification_command
                        else "Run validation"
                    ),
                    "status": "pending" if has_changes else "active",
                },
                {
                    "id": "review",
                    "label": "Review changes before applying",
                    "status": "pending" if has_changes else "done",
                },
                {"id": "summary", "label": "Summarize result", "status": "pending"},
            ]
        )
        self._emit(
            PlanEvent(
                seq=0,
                run_id=self.run_id,
                ts=_now(),
                items=items,
                checkpoint_id=self._checkpoint_id,
            )
        )

    def _emit_plan_update(self, item_id: str, status: str) -> None:
        self._emit(
            PlanUpdateEvent(
                seq=0,
                run_id=self.run_id,
                ts=_now(),
                id=item_id,
                status=status,
            )
        )

    def _emit_check_command(self, command: str, exit_code: int, log: str) -> None:
        status = "skipped" if _is_noop_check(command) else ("pass" if exit_code == 0 else "fail")
        self._emit(
            CommandEvent(
                seq=0,
                run_id=self.run_id,
                ts=_now(),
                command=command or "validation",
                command_id="validation",
                status=status,
                exit_code=exit_code,
                output_tail=_tail(log),
            )
        )

    def _emit_review(self, applied: list[Diff], checks: list[tuple[str, int]]) -> None:
        # R12.7: stamp each reviewed file with the SHA-256 of the *real* target's
        # current bytes (the file in the user's workspace, not the isolated
        # copy), so the renderer can detect a target that changed since the
        # proposal. ``None`` when the target does not exist yet (a create).
        root = self.source_workspace_root
        self._emit(
            ReviewEvent(
                seq=0,
                run_id=self.run_id,
                ts=_now(),
                files=[
                    ReviewFile(
                        path=diff.path,
                        diff=diff.diff,
                        adds=_diff_stats(diff.diff)[0],
                        dels=_diff_stats(diff.diff)[1],
                        summary=_diff_summary(diff.diff),
                        base_hash=(sha256_file(root / diff.path) if root is not None else None),
                    )
                    for diff in applied
                ],
                validation=_validation_from_checks(checks),
                checkpoint_id=self._checkpoint_id,
            )
        )

    def _emit_human_summary(self, text: str) -> None:
        self._emit(SummaryEvent(seq=0, run_id=self.run_id, ts=_now(), text=text))

    def _emit_test_results(self, result: ProjectTestResult) -> None:
        self._emit(
            TestResultsEvent(
                seq=0,
                run_id=self.run_id,
                ts=_now(),
                status="pass" if result.exit_code == 0 else "fail",
                command=result.command,
                source=result.source,
                passed=result.passed,
                failed=result.failed,
                exit_code=result.exit_code,
                output_tail=_tail(result.output),
                duration_ms=result.duration_ms,
                timed_out=result.timed_out,
            )
        )

    def _emit_recovery_attempt(self, attempt: int, failures: list[str]) -> None:
        self._emit(
            RecoveryAttemptEvent(
                seq=0,
                run_id=self.run_id,
                ts=_now(),
                attempt=attempt,
                failures=failures,
            )
        )

    def _authorize_tool(
        self,
        kind: PermissionKind,
        name: str,
        target: str,
    ) -> str | None:
        """Audit one non-ReAct tool action and return why it was refused."""
        checker = self._check_permission
        if checker is None:
            return None
        decision = checker(kind, name, target)
        self._emit(
            PermissionEvent(
                seq=0,
                run_id=self.run_id,
                ts=_now(),
                kind=kind,
                name=name,
                target=target or None,
                effect=decision.effect,
                reason=decision.reason,
            )
        )
        if decision.effect == "allow":
            return None
        if decision.effect == "prompt" and self._wait_for_approval_decision is not None:
            self._emit(
                ApprovalEvent(
                    seq=0,
                    run_id=self.run_id,
                    ts=_now(),
                    prompt=(
                        f"{decision.reason} Permission required for {name!r} "
                        f"({target!r}); approve to proceed or reject to skip."
                    ),
                )
            )
            verdict = self._wait_for_approval_decision(_PERMISSION_DECISION_TIMEOUT_SECONDS)
            if verdict is not None and getattr(verdict, "decision", None) == "approve":
                return None
        detail = f"permission {decision.effect}: {kind} {name!r} for {target!r} — {decision.reason}"
        log_security_event(
            "permission_denied",
            detail,
            run_id=self.run_id,
            action_kind=kind,
            tool=name,
            target=target or None,
        )
        return detail

    def _run_post_write_tests(self) -> ProjectTestResult | None:
        assert self.workspace_root is not None  # Agent/Plan path always has a root.
        detected = detect_project_test_command(self.workspace_root)
        if detected is None:
            return None
        blocked_reason = self._authorize_tool("terminal", "run_project_tests", detected.command)
        if blocked_reason is not None:
            raise PermissionError(blocked_reason)
        return self._project_test_runner(self.workspace_root, detected)

    def _provider_configured(self) -> bool:
        """Whether a model provider and model are configured for this run.

        The ReAct strategy only engages with a real tool-calling model behind
        it (design selection rule); with no provider the run falls back to the
        single-pass path or the empty-plan skip.
        """
        return bool((self.request.provider or "").strip() and (self.request.model or "").strip())

    def _emit_budget(
        self,
        context: RunContext,
        orchestrator: Orchestrator,
        tokens_used: int,
    ) -> None:
        """Publish the latest run budget without adding a visible trace row."""
        self._emit(
            BudgetEvent(
                seq=0,
                run_id=self.run_id,
                ts=_now(),
                tokens_used=max(tokens_used, 0),
                token_limit=context.allocation.context_window,
                iterations=orchestrator.budget.file_iterations,
                recoveries=orchestrator.budget.error_recoveries,
            )
        )

    def _copy_review_paths(self, paths: list[str]) -> str | None:
        isolated = self._isolated_workspace_root
        if isolated is None:
            return None
        # An isolated workspace is only created for an Agent review run, which
        # always has a real source root.
        assert self.source_workspace_root is not None
        root = self.source_workspace_root.resolve()
        transaction = AtomicFileTransaction()
        seen: set[str] = set()
        for raw_path in paths:
            rel = _safe_relative_path(raw_path)
            normalized = rel.as_posix()
            if normalized in seen:
                continue
            seen.add(normalized)

            source = isolated / rel
            target = root / rel
            try:
                target.resolve(strict=False).relative_to(root)
            except ValueError as exc:
                raise ValueError(f"review path escapes workspace: {raw_path}") from exc

            cursor = root
            for component in rel.parts:
                cursor /= component
                if cursor.is_symlink():
                    raise ValueError(f"review path traverses a symlink: {raw_path}")
                if not cursor.exists():
                    break

            if source.is_symlink():
                raise ValueError(f"review source is a symlink: {raw_path}")
            if source.is_file():
                transaction.add_write(
                    target,
                    source.read_bytes(),
                    mode=source.stat().st_mode,
                )
            elif source.exists():
                raise IsADirectoryError(f"review path is not a file: {raw_path}")
            else:
                # A selected file absent from the isolated copy represents an
                # agent deletion; missing real targets remain a no-op.
                transaction.add_delete(target)

        result = transaction.commit()
        if result.written + result.deleted == 0:
            return None
        try:
            git_checkpoint(root, "zoc: pre-run checkpoint")
        except CheckpointError as exc:
            logger.warning(
                "run %s applied reviewed changes but checkpoint creation failed: %s",
                self.run_id,
                exc,
            )
            return str(exc)
        return None

    def _review_and_maybe_apply(self, applied: list[Diff]) -> tuple[str, int]:
        """Apply the reviewed changes and report ``(human summary, files changed)``.

        The count is the number of distinct files actually changed; it is zero
        for every branch that applies nothing (no edits, review unavailable,
        review closed, or an explicit discard) and the summary then doubles as
        the human reason the ``done`` event carries (R8.7/R8.8).
        """
        if not applied:
            self._emit_plan_update("review", "done")
            self._emit_plan_update("summary", "active")
            return "No file changes were needed.", 0
        self._emit_plan_update("review", "active")
        waiter = self._wait_for_review_decision
        if waiter is None:
            self._emit_plan_update("review", "done")
            self._emit_plan_update("summary", "active")
            return "Review is unavailable, so no isolated changes were applied.", 0
        decision = waiter(None)
        if decision is None:
            self._emit_plan_update("review", "done")
            self._emit_plan_update("summary", "active")
            return "Review was closed before a decision, so no changes were applied.", 0
        verdict = getattr(decision, "decision", None)
        if verdict == "discard":
            self._emit_plan_update("review", "done")
            self._emit_plan_update("summary", "active")
            return "Discarded the isolated changes. Your workspace was left unchanged.", 0
        accepted_paths = list(getattr(decision, "accepted_paths", []) or [])
        reviewed_paths = {diff.path for diff in applied}
        unknown_paths = [path for path in accepted_paths if path not in reviewed_paths]
        if unknown_paths:
            raise ValueError(
                "review decision included paths outside the emitted diff: "
                + ", ".join(unknown_paths[:5])
            )
        checkpoint_error = self._copy_review_paths(accepted_paths)
        self._emit_plan_update("review", "done")
        self._emit_plan_update("summary", "active")
        files_changed = len(set(accepted_paths))
        noun = "file" if files_changed == 1 else "files"
        summary = f"Applied {files_changed} reviewed {noun} to your workspace."
        if checkpoint_error is not None:
            summary += f" Checkpoint creation failed: {checkpoint_error}"
        return summary, files_changed

    # -- entrypoint ---------------------------------------------------------

    def run(self) -> RunResult:
        """Drive the routed run to a terminal outcome and close the stream."""
        try:
            self._check_cancelled()
            if isinstance(self.path, AskPath):
                return self._run_ask(self.path)
            return self._run_agent()
        except RunCancelled:
            self._close()
            return RunResult(
                mode=self.path.mode,
                run_id=self.run_id,
                stage=Stage.ERROR_CLOSED,
                stages=(Stage.ERROR_CLOSED,),
            )

    def _check_cancelled(self) -> None:
        """Stop at a side-effect boundary when this run alone was cancelled."""
        if self._is_cancelled():
            raise RunCancelled(f"run {self.run_id} cancelled")

    # -- Ask Mode (text-only channel, R6.6) ---------------------------------

    def _run_ask(self, path: AskPath) -> RunResult:
        """Run the read-only Ask path, streaming the answer as text (R2.x/R6.6).

        ``AskPath.execute`` compiles steering and runs RAG extraction before
        generating the answer (R2.5/R2.6) and yields one of three outcomes; all
        three are emitted as raw text chunks on the Ask channel and then the
        stream is closed.
        """
        result = path.execute(
            self.original_request,
            generate=lambda _prompt, context: self._ask_response(self.request.prompt, context),
            workspace_root=self.workspace_root,
            rag_matcher=self.rag_matcher,
        )
        self._check_cancelled()
        if isinstance(result, AskResponse):
            text = result.text
        elif isinstance(result, (SwitchToAgentMessage, AskError)):
            text = result.message
        else:  # pragma: no cover - exhaustive over AskResult
            text = ""
        if not self._ask_streamed:
            self._channel.emit_text(text)
        self._close()
        return RunResult(
            mode=Mode.ASK,
            run_id=self.run_id,
            stage=Stage.DONE,
            stages=(),
            ask_text=text,
        )

    def _ask_response(self, prompt: str, context: AskContext) -> str:
        try:
            configured = generate_text_stream(
                self.request,
                system_prompt=_ask_system_prompt(context),
                timeout=60.0,
                on_token=self._emit_ask_token,
            )
        except ModelRuntimeError as exc:
            message = f"Model request failed: {exc}"
            if self._ask_streamed:
                self._channel.emit_text(f"\n\n{message}")
            return message
        if configured:
            return configured
        try:
            configured = generate_text(
                self.request,
                system_prompt=_ask_system_prompt(context),
                timeout=60.0,
            )
        except ModelRuntimeError as exc:
            return f"Model request failed: {exc}"
        if configured:
            return configured
        return self.brain.ask_response(prompt, context)

    def _emit_ask_token(self, chunk: str) -> None:
        self._check_cancelled()
        if not chunk:
            return
        self._ask_streamed = True
        self._channel.emit_text(chunk)

    # -- Context Bus --------------------------------------------------------

    def _build_context(self, allocation: Allocation) -> RunContext:
        """Enrich the prompt via RAG + steering, sized to the window (R8.1/2/5).

        Runs RAG extraction, compiles ``.zoc/steering/*.md`` in lexical order,
        and runs the scale-adaptive token gate so the payload fits the
        allocated context window, truncating the lowest-relevance fragments
        first (R8.5). The available MCP tool ids are recorded for the run.
        """
        fragments = self.rag_matcher.extract(self.request.prompt)
        # Reached only on the Agent/Plan path, which always resolves a real root
        # upstream (a root-less run is Ask, handled by _run_ask). The asserts
        # narrow the Optional for the type checker and document that invariant.
        assert self.workspace_root is not None
        assert self.source_workspace_root is not None
        steering = compile_steering(self.workspace_root / DEFAULT_STEERING_DIR)
        gated = fit_fragments(fragments, allocation.context_window)
        return RunContext(
            allocation=allocation,
            fragments=gated.fragments,
            steering=steering,
            token_gate=gated,
            mcp_tools=self.mcp_gateway.available_tools(),
            project_instructions=read_project_instructions(self.source_workspace_root),
        )

    def _map_candidates(self) -> tuple[object, ...]:
        indexer = self._workspace_indexer
        if (
            self._hybrid_candidate_source
            and indexer is not None
            and indexer.is_ready(self._index_session_id)
        ):
            return tuple(
                indexer.query(
                    self._index_session_id,
                    self.request.prompt,
                    top_k=20,
                )
            )
        return tuple(self.rag_matcher.extract(self.request.prompt))

    def _select_files(self) -> MapFilesEvent:
        selector = self._file_selector
        if selector is None:
            if not self._provider_configured():
                raise MapFilesError("file-selection requires a configured provider")
            selector = runtime_file_selector(self.request)
        return select_map_files(
            self.request.prompt,
            self._map_candidates(),
            select=selector,
            workspace_root=self.workspace_root,  # type: ignore[arg-type]
        )

    def _read_selected_files(self, event: MapFilesEvent) -> tuple[str, tuple[str, ...]]:
        read_paths: list[str] = []

        def read_file(path: str) -> str:
            content = self.toolset.read_file(path)
            read_paths.append(path)
            # §15.1: workspace files are untrusted input. Fence anything that
            # tries to impersonate a system instruction before it reaches the
            # model, and audit the detection.
            return sanitize_file_content(content, path)

        payload = build_read_files_payload(
            event.read_list,
            read_file,
            token_cap=PER_FILE_TOKEN_CAP,
        )
        return payload, tuple(read_paths)

    def _new_conversation_memory(self, context: RunContext) -> ConversationMemory:
        # §14.1/§14.2: prepend what we already know about this project and which
        # approach has worked before, so the agent carries continuity across
        # sessions instead of starting cold every run.
        system_parts = ["You are Zoc Agent, a workspace-confined coding assistant."]
        for section in (self.memory_prompt_section(), self.approach_prompt_section()):
            if section:
                system_parts.append(section)
        return ConversationMemory(
            messages=[
                Message(
                    Role.SYSTEM,
                    "\n\n".join(system_parts),
                    Stage.INTAKE.value,
                ),
                Message(Role.USER, self.request.prompt, Stage.INTAKE.value),
            ],
            tokenizer_kind=tokenizer_kind_for_tier(context.allocation.tier),
        )

    @staticmethod
    def _context_with_memory(context: RunContext, memory: ConversationMemory) -> RunContext:
        rendered = "\n".join(
            f"{message.role.value}: {message.content}" for message in memory.messages
        )
        return replace(context, conversation_history=rendered)

    def _maybe_compress(self, memory: ConversationMemory, max_tokens: int) -> None:
        memory.summarizer = (
            runtime_summarizer(self.request) if self._provider_configured() else None
        )
        try:
            event = memory.compress(max_tokens)
        except (CompressionError, ModelRuntimeError):
            return
        except Exception:
            logger.exception("run %s context compression failed", self.run_id)
            return
        if event is not None:
            self._emit(
                ContextCompressedContractEvent(
                    seq=0,
                    run_id=self.run_id,
                    ts=_now(),
                    original_tokens=event.original_tokens,
                    compressed_tokens=event.compressed_tokens,
                    compression_ratio=event.compression_ratio,
                )
            )

    # -- Agent Mode (FSM-driven structured channel) -------------------------

    def _run_agent(self) -> RunResult:
        """Drive the 9-stage FSM run end to end through the structured channel.

        The first emitted event is the allocator-aware ``IntentEvent`` (R1.9);
        the FSM then advances INTAKE→…→PLAN_EDITS, the edit plan is applied (or
        skipped when empty, R3.8), RUN_CHECKS is resolved through the
        remediation loop (R5), and a passing check carries the run to SUMMARY
        then DONE — closing the stream (R3.4) and recording the trajectory.
        """
        stages: list[Stage] = [Stage.INTAKE]
        try:
            signals = self.brain.allocation_signals(self.request)
            allocation = self.allocator.select(
                signals.complexity, signals.latency_ms, signals.hardware
            )
            context = self._build_context(allocation)
        except AllocationAborted as exc:
            reason = f"{type(exc).__name__}: {exc}"
            fsm = FSM(
                initial=Stage.INTAKE,
                run_id=self.run_id,
                emit=self._emit,
                emit_stage_reports=True,
            )
            fsm.fail(reason)
            stages.append(Stage.ERROR_CLOSED)
            self._remember_failure(reason)
            self._close()
            return RunResult(
                mode=Mode.AGENT,
                run_id=self.run_id,
                stage=Stage.ERROR_CLOSED,
                stages=tuple(stages),
                allocation=None,
            )

        self._check_cancelled()

        # R1.9: the INTAKE stage entry emits the IntentEvent carrying the tier,
        # window, and any fallback reason as the run's first event.
        factory = allocation_stage_event_factory(
            allocation, intent_text=self.request.prompt or DEFAULT_INTENT_TEXT
        )
        fsm = FSM(
            initial=Stage.INTAKE,
            run_id=self.run_id,
            emit=self._emit,
            stage_event_factory=factory,
            emit_stage_reports=True,
        )
        memory = self._new_conversation_memory(context)
        self._maybe_compress(memory, allocation.context_window)
        context = self._context_with_memory(context, memory)
        thinking_started = time.monotonic()
        try:
            scratchpad = self.brain.think(self.request, context)
        except ProviderAuthError as exc:
            # R6: a provider auth rejection is surfaced with its typed code and a
            # provider-named, body-free message so the renderer can prompt the
            # user to fix the key rather than showing a generic run failure.
            reason = self._report_provider_auth(exc)
            fsm.fail(reason)
            stages.append(Stage.ERROR_CLOSED)
            self._remember_failure(reason)
            self._close()
            return RunResult(
                mode=Mode.AGENT,
                run_id=self.run_id,
                stage=Stage.ERROR_CLOSED,
                stages=tuple(stages),
                allocation=allocation,
            )
        except ModelContextWindowError as exc:
            reason = str(exc)
            logger.warning("run %s analysis exceeded model context: %s", self.run_id, exc)
            fsm.fail(reason)
            stages.append(Stage.ERROR_CLOSED)
            self._remember_failure(reason, code=exc.code)
            self._close()
            return RunResult(
                mode=Mode.AGENT,
                run_id=self.run_id,
                stage=Stage.ERROR_CLOSED,
                stages=tuple(stages),
                allocation=allocation,
            )
        except Exception as exc:
            reason = f"thinking failed: {type(exc).__name__}: {exc}"
            logger.exception("run %s failed during private thinking", self.run_id)
            fsm.fail(reason)
            stages.append(Stage.ERROR_CLOSED)
            self._remember_failure(reason)
            self._close()
            return RunResult(
                mode=Mode.AGENT,
                run_id=self.run_id,
                stage=Stage.ERROR_CLOSED,
                stages=tuple(stages),
                allocation=allocation,
            )
        self._check_cancelled()
        if scratchpad:
            memory.messages.append(Message(Role.ASSISTANT, scratchpad, Stage.ANALYZE.value))
            context = replace(context, scratchpad=scratchpad)
            context = self._context_with_memory(context, memory)
            self._emit_scratchpad(
                scratchpad,
                max(0, int((time.monotonic() - thinking_started) * 1000)),
            )

        stages.append(fsm.advance())  # INTAKE → ANALYZE
        stages.append(fsm.advance())  # ANALYZE → MAP_FILES
        try:
            map_event = self._select_files()
        except Exception as exc:
            reason = f"map_files failed: {type(exc).__name__}: {exc}"
            logger.exception("run %s failed during MAP_FILES", self.run_id)
            fsm.fail(reason)
            stages.append(Stage.ERROR_CLOSED)
            self._remember_failure(reason)
            self._close()
            return RunResult(
                mode=Mode.AGENT,
                run_id=self.run_id,
                stage=Stage.ERROR_CLOSED,
                stages=tuple(stages),
                allocation=allocation,
            )
        self._check_cancelled()
        self._emit(
            MapFilesContractEvent(
                seq=0,
                run_id=self.run_id,
                ts=_now(),
                read_list=list(map_event.read_list),
                write_list=list(map_event.write_list),
                rationale=map_event.rationale,
            )
        )
        memory.messages.append(
            Message(
                Role.ASSISTANT,
                json.dumps(
                    {
                        "read": map_event.read_list,
                        "write": map_event.write_list,
                        "rationale": map_event.rationale,
                    }
                ),
                Stage.MAP_FILES.value,
            )
        )

        stages.append(fsm.advance())  # MAP_FILES → READ_FILES
        read_payload, read_paths = self._read_selected_files(map_event)
        context = replace(context, read_files_payload=read_payload)
        self._check_cancelled()
        if read_payload:
            memory.messages.append(Message(Role.TOOL_RESULT, read_payload, Stage.READ_FILES.value))
        context = self._context_with_memory(context, memory)
        try:
            self._emit(
                ReadFilesEvent(
                    seq=0,
                    run_id=self.run_id,
                    ts=_now(),
                    files=[ReadFileRef(path=path) for path in read_paths],
                )
            )
        except Exception:
            logger.exception("run %s failed to emit READ_FILES", self.run_id)
        stages.append(fsm.advance())  # READ_FILES → PLAN_EDITS

        edits = EditCoordinator(
            toolset=self.toolset,
            run_id=self.run_id,
            emit=self._emit,
            write_allowlist=(
                preapproved_writes(map_event) if self._enforce_write_allowlist else None
            ),
            wait_for_approval=self._wait_for_approval_decision,
        )
        orchestrator = Orchestrator(fsm=fsm, edits=edits, run_id=self.run_id, emit=self._emit)
        remediation = RemediationLoop(
            fsm=fsm,
            planner=self.brain.remediation_plan,
            diary=self._diary_sink,
            on_recovery=orchestrator.budget.count_recovery,
            run_id=self.run_id,
            emit=self._emit,
        )
        tokens_used = estimate_tokens(self.request.prompt) + estimate_tokens(
            _agent_system_prompt(context, user_prompt=self.request.prompt)
        )
        self._emit_budget(context, orchestrator, tokens_used)

        return self._plan_check_loop(
            fsm,
            edits,
            orchestrator,
            remediation,
            context,
            memory,
            allocation,
            stages,
            tokens_used,
        )

    def _plan_check_loop(
        self,
        fsm: FSM,
        edits: EditCoordinator,
        orchestrator: Orchestrator,
        remediation: RemediationLoop,
        context: RunContext,
        memory: ConversationMemory,
        allocation: Allocation,
        stages: list[Stage],
        tokens_used: int,
    ) -> RunResult:
        """Run PLAN_EDITS→APPLY_EDITS→RUN_CHECKS with the remediation loop (R3/R5).

        Bounded by the error-recovery budget: a remediation that would exceed
        the recovery ceiling (R4.4) freezes the loop and serializes state to
        the State_Wrapper for a hot-swap instead of looping forever (R11.1).
        """
        self._check_cancelled()
        try:
            self._maybe_compress(memory, allocation.context_window)
            context = self._context_with_memory(context, memory)
            structured_plan = self.brain.structured_plan(self.request, context)
            memory.messages.append(
                Message(
                    Role.ASSISTANT,
                    structured_plan.model_dump_json(exclude_none=True),
                    Stage.PLAN_EDITS.value,
                )
            )
            self._maybe_compress(memory, allocation.context_window)
            context = self._context_with_memory(context, memory)
            plan = self.brain.edit_plan(self.request, context)
            memory.messages.append(
                Message(
                    Role.ASSISTANT,
                    json.dumps(
                        {
                            "reasoning": plan.reasoning,
                            "changes": [
                                {
                                    "path": change.path,
                                    "content": change.content,
                                    "diff": change.diff,
                                }
                                for change in plan.changes
                            ],
                        }
                    ),
                    Stage.PLAN_EDITS.value,
                )
            )
            context = self._context_with_memory(context, memory)
        except Exception as exc:
            if isinstance(exc, ModelContextWindowError):
                reason = str(exc)
                failure_code = exc.code
            else:
                reason = f"edit_plan failed: {type(exc).__name__}: {exc}"
                failure_code = ErrorCode.RUN_FAILED
            logger.exception("run %s failed while planning edits", self.run_id)
            fsm.fail(reason)
            stages.append(Stage.ERROR_CLOSED)
            self._remember_failure(
                reason,
                tokens_used=tokens_used,
                code=failure_code,
            )
            self._close()
            return RunResult(
                mode=Mode.AGENT,
                run_id=self.run_id,
                stage=Stage.ERROR_CLOSED,
                stages=tuple(stages),
                allocation=allocation,
            )
        self._check_cancelled()
        tokens_used += _estimate_edit_plan_tokens(plan)
        self._emit_budget(context, orchestrator, tokens_used)

        # §12.2 Plan mode: the plan is complete, so stop here. Emit the whole
        # plan for review and wait for an explicit approval before *anything*
        # touches the workspace. A rejection ends the run without applying.
        # Agent mode never enters this gate, so its approval state stays False —
        # the capability table permits Agent writes regardless (R16.4), while
        # Plan writes are permitted only once this flips True (R7.6/R7.7).
        plan_approved = False
        if self.plan_only:
            # R7.5: entering the approval gate is the Review stage going active.
            fsm.report_review(StageState.ACTIVE)
            gate = self._await_plan_approval(structured_plan, plan)
            self._check_cancelled()
            if not gate.approved:
                # R7.8: a rejected plan applies no staged change and ends the run.
                self._emit_plan(plan, structured_plan)
                fsm.plan_complete(has_changes=False)  # PLAN_EDITS → SUMMARY-ish
                self._close()
                return RunResult(
                    mode=Mode.PLAN,
                    run_id=self.run_id,
                    stage=Stage.PLAN_EDITS,
                    stages=tuple(stages),
                    allocation=allocation,
                )
            # R7.7: approval resumes the run with Edit-stage capabilities enabled.
            plan_approved = gate.approved
            fsm.report_review(StageState.SUCCEEDED)
            # Approved: honour any per-step deselection before applying.
            if gate.accepted_paths is not None:
                structured_plan, plan = _restrict_plan_to_paths(
                    structured_plan, plan, gate.accepted_paths
                )

        # Mode capability gate (R7.6/R7.7/R16.2-16.4): file writes are permitted
        # in agent mode and in plan mode only after approval. The verdict is
        # driven by the *actual* approval state (``plan_approved``), not a
        # hardcoded ``True`` — so a future path that reaches here in Plan mode
        # without approval is rejected rather than silently writing. This is the
        # one chokepoint every single-pass write passes through.
        write_decision = check_capability(
            self.request.mode, approved=plan_approved, capability=Capability.WRITE
        )
        if write_decision.rejected:
            reason = write_decision.message or "file writes are not permitted in this mode"
            fsm.fail(reason)
            stages.append(Stage.ERROR_CLOSED)
            self._remember_failure(reason)
            self._close()
            return RunResult(
                mode=Mode.AGENT,
                run_id=self.run_id,
                stage=Stage.ERROR_CLOSED,
                stages=tuple(stages),
                allocation=allocation,
            )

        # §12.3: claim the files this run intends to write before applying, so a
        # concurrent run cannot interleave writes into the same file. Contention
        # surfaces as an approval prompt rather than a silent wait.
        lock_paths = self._planned_write_paths(structured_plan, plan)
        lock_result = self._acquire_write_locks(lock_paths)
        self._check_cancelled()
        if not lock_result.acquired:
            self._close()
            return RunResult(
                mode=Mode.AGENT,
                run_id=self.run_id,
                stage=Stage.PAUSED,
                stages=tuple((*stages, Stage.PAUSED)),
                allocation=allocation,
                paused=True,
                deferred=True,
            )

        applied: list[Diff] = []
        checks: list[tuple[str, int]] = []
        remediating = False

        # The loop can only re-enter PLAN_EDITS as many times as the recovery
        # budget allows; the guard is a hard backstop against a runaway planner.
        for _ in range(orchestrator.budget.ERROR_CEILING + 1):
            self._check_cancelled()
            wrote_code = False
            self._emit_plan(plan, structured_plan)
            edits.plan_edits(plan)  # collapsible thinking event (R3.6)
            # Strategy selection (design "APPLY_EDITS strategy seam"): drive
            # ReAct only when explicitly enabled, a provider/model is
            # configured, this is the initial (non-remediation) apply, and the
            # structured plan has steps; otherwise single-pass or the empty-plan
            # skip (R3.8). Defaulting to SINGLE_PASS keeps legacy behavior.
            use_react = (
                self.apply_strategy is ApplyStrategy.REACT
                and not remediating
                and self._provider_configured()
                and bool(structured_plan.steps)
            )
            if use_react or plan.has_changes:
                stages.append(fsm.plan_complete(has_changes=True))  # APPLY_EDITS
                if use_react:
                    executor: ApplyExecutor = ReActApplyExecutor(
                        toolset=self.toolset,
                        orchestrator=orchestrator,
                        structured_plan=structured_plan,
                        request=self.request,
                        context=context,
                        emit=self._emit,
                        run_id=self.run_id,
                        tokens_used=tokens_used,
                        authorize_write=edits.authorize_write,
                        run_with_tools=self._run_with_tools,
                        mcp_call=self._mcp_dispatch,
                        check_permission=self._check_permission,
                        wait_for_approval=self._wait_for_approval_decision,
                        capability_gate=lambda capability: check_capability(
                            self.request.mode, approved=plan_approved, capability=capability
                        ),
                    )
                else:
                    executor = SinglePassApplyExecutor(
                        edits=edits,
                        orchestrator=orchestrator,
                        plan=plan,
                        structured_plan=structured_plan,
                        emit_plan_update=self._emit_plan_update,
                        emit_budget=functools.partial(
                            self._emit_budget, context, orchestrator, tokens_used
                        ),
                        authorize_tool=self._authorize_tool,
                    )
                self._check_cancelled()
                result = executor.apply()
                self._check_cancelled()
                applied.extend(result.applied)  # edit-file events already emitted (R3.7)
                wrote_code = result.wrote_code
                if result.paused:
                    if fsm.current is not Stage.PAUSED:
                        fsm.pause(result.error or "write approval rejected")
                    stages.append(Stage.PAUSED)
                    self._close()
                    return RunResult(
                        mode=Mode.AGENT,
                        run_id=self.run_id,
                        stage=Stage.PAUSED,
                        stages=tuple(stages),
                        allocation=allocation,
                        paused=True,
                    )
                if result.failed:
                    # R3.9: apply failed → unrecoverable terminal error close.
                    reason = result.error or "apply failed"
                    fsm.fail(reason)
                    stages.append(Stage.ERROR_CLOSED)
                    self._remember_failure(
                        reason,
                        applied=applied,
                        checks=checks,
                        tokens_used=tokens_used,
                    )
                    self._close()
                    return RunResult(
                        mode=Mode.AGENT,
                        run_id=self.run_id,
                        stage=Stage.ERROR_CLOSED,
                        stages=tuple(stages),
                        allocation=allocation,
                    )
                self._emit_plan_update("apply", "done")
                stages.append(fsm.advance())  # APPLY_EDITS → RUN_CHECKS
            else:
                stages.append(fsm.plan_complete(has_changes=False))  # R3.8

            self._check_cancelled()
            self._emit_plan_update("validate", "active")
            try:
                test_result = self._run_post_write_tests() if wrote_code else None
                exit_code, command, log = (
                    (test_result.exit_code, test_result.command, test_result.output)
                    if test_result is not None
                    else self.brain.run_checks(self.request, plan)
                )
            except Exception as exc:
                reason = f"run_checks failed: {type(exc).__name__}: {exc}"
                logger.exception("run %s failed while running checks", self.run_id)
                fsm.fail(reason)
                stages.append(Stage.ERROR_CLOSED)
                self._remember_failure(
                    reason,
                    applied=applied,
                    checks=checks,
                    tokens_used=tokens_used,
                )
                self._close()
                return RunResult(
                    mode=Mode.AGENT,
                    run_id=self.run_id,
                    stage=Stage.ERROR_CLOSED,
                    stages=tuple(stages),
                    allocation=allocation,
                )
            self._check_cancelled()
            checks.append((command, exit_code))
            memory.messages.append(
                Message(
                    Role.TOOL_RESULT,
                    f"Command: {command}\nExit code: {exit_code}\n{log}",
                    Stage.RUN_CHECKS.value,
                )
            )
            self._maybe_compress(memory, allocation.context_window)
            context = self._context_with_memory(context, memory)
            if isinstance(self.brain, RuntimeAgentBrain):
                self.brain.update_context(context)
            verify_result = parse_verify_result(command, log, exit_code)
            self._emit_check_command(command, exit_code, log)
            if test_result is not None:
                self._emit_test_results(test_result)
            if not verify_result.passed:
                self._emit_recovery_attempt(remediation.recoveries + 1, verify_result.failures)
            rem = remediation.on_checks_complete(
                exit_code, command=command, log=log, prior_plan=plan
            )
            self._emit_budget(context, orchestrator, tokens_used)

            if rem.stage is Stage.SUMMARY:  # R5.8
                self._emit_plan_update("validate", "done")
                stages.append(Stage.SUMMARY)
                if self.request.review_changes and applied:
                    self._emit_review(applied, checks)
                try:
                    self._check_cancelled()
                    if self.request.review_changes:
                        summary, files_changed = self._review_and_maybe_apply(applied)
                    else:
                        # Auto-apply path: the edits were written during
                        # APPLY_EDITS, so the distinct changed files are the
                        # distinct diff paths.
                        files_changed = len({diff.path for diff in applied})
                        summary = (
                            "Completed the requested agent run."
                            if files_changed
                            else "No file changes were needed."
                        )
                    self._check_cancelled()
                except Exception as exc:
                    reason = f"review apply failed: {type(exc).__name__}: {exc}"
                    logger.exception("run %s failed while applying review", self.run_id)
                    fsm.fail(reason)
                    stages.append(Stage.ERROR_CLOSED)
                    self._remember_failure(
                        reason,
                        applied=applied,
                        checks=checks,
                        tokens_used=tokens_used,
                    )
                    self._close()
                    return RunResult(
                        mode=Mode.AGENT,
                        run_id=self.run_id,
                        stage=Stage.ERROR_CLOSED,
                        stages=tuple(stages),
                        allocation=allocation,
                    )
                self._emit_human_summary(summary)
                self._emit_plan_update("summary", "done")
                # R8.7/R8.8: the terminal `done` event carries the real count of
                # distinct files changed and, when none changed, a human reason.
                fsm.done_files_changed = files_changed
                fsm.done_reason = summary if files_changed == 0 else None
                stages.append(fsm.advance())  # SUMMARY → DONE (R3.4)
                self._close()
                self._record_evolution(stages, applied, checks, reached_done=True)
                # §14.1/§14.2: learn from the finished run before returning.
                transcript = self._learning_transcript(
                    summary,
                    succeeded=True,
                    applied=applied,
                    checks=checks,
                )
                self._remember_run(
                    applied,
                    transcript,
                    succeeded=True,
                    tokens_used=tokens_used,
                )
                return RunResult(
                    mode=Mode.AGENT,
                    run_id=self.run_id,
                    stage=Stage.DONE,
                    stages=tuple(stages),
                    allocation=allocation,
                )

            if rem.remediated and rem.plan is not None:  # R5.5/5.6
                stages.append(Stage.HANDLE_ERROR)
                stages.append(Stage.PLAN_EDITS)
                if not orchestrator.budget.before_recovery():
                    # R11.1: recovery ceiling reached → freeze + hot-swap.
                    resume_stage = fsm.current
                    hot_swap = self._preserve_and_swap(
                        resume_stage, orchestrator, applied, allocation
                    )
                    fsm.pause("recovery budget exhausted; hot-swap required")
                    stages.append(Stage.PAUSED)
                    self._close()
                    return RunResult(
                        mode=Mode.AGENT,
                        run_id=self.run_id,
                        stage=Stage.PAUSED,
                        stages=tuple(stages),
                        allocation=allocation,
                        paused=True,
                        hot_swap=hot_swap,
                    )
                plan = rem.plan
                memory.messages.append(
                    Message(
                        Role.ASSISTANT,
                        json.dumps(
                            {
                                "reasoning": plan.reasoning,
                                "changes": [change.path for change in plan.changes],
                            }
                        ),
                        Stage.PLAN_EDITS.value,
                    )
                )
                context = self._context_with_memory(context, memory)
                tokens_used += _estimate_edit_plan_tokens(plan)
                self._emit_budget(context, orchestrator, tokens_used)
                remediating = True
                continue

            # R5.7: no differing remediation → paused, deferred to developer.
            stages.append(Stage.HANDLE_ERROR)
            stages.append(Stage.PAUSED)
            self._close()
            return RunResult(
                mode=Mode.AGENT,
                run_id=self.run_id,
                stage=Stage.PAUSED,
                stages=tuple(stages),
                allocation=allocation,
                paused=True,
                deferred=True,
            )

        # Recovery budget exhausted without resolution → freeze + hot-swap.
        resume_stage = fsm.current
        hot_swap = self._preserve_and_swap(resume_stage, orchestrator, applied, allocation)
        if fsm.current is not Stage.PAUSED:
            fsm.pause("recovery budget exhausted; hot-swap required")
            stages.append(Stage.PAUSED)
        self._close()
        return RunResult(
            mode=Mode.AGENT,
            run_id=self.run_id,
            stage=Stage.PAUSED,
            stages=tuple(stages),
            allocation=allocation,
            paused=True,
            hot_swap=hot_swap,
        )

    # -- hot-swap state preservation (R11.1) --------------------------------

    def _preserve_and_swap(
        self,
        stage: Stage,
        orchestrator: Orchestrator,
        applied: list[Diff],
        allocation: Allocation,
    ) -> HotSwapResult:
        """Freeze the loop, serialize run state, and drive the hot-swap (R11.1).

        The run-resumable slice (stage, active file markers, patch diffs) is
        written to the model-agnostic State_Wrapper and the
        :class:`HotSwapCoordinator` upshifts to the next tier (or continues on
        Cloud, R11.6), so a budget ceiling preserves state across the swap
        rather than losing the run.
        """
        state = StateWrapper(
            stage=stage,
            active_file_markers=list(orchestrator.active_file_markers),
            patch_diffs=list(applied),
            compilation_logs=[],
        )
        coordinator = HotSwapCoordinator(
            store=self.state_store,  # type: ignore[arg-type]
            allocator=self.allocator,
            loader=self.model_loader,
            run_id=self.run_id,
            emit=self._emit,
        )
        return coordinator.trigger(state, active_tier=allocation.tier)

    # -- evolution (R12.1 trajectory recording on a verified DONE) ----------

    def _record_evolution(
        self,
        stages: list[Stage],
        applied: list[Diff],
        checks: list[tuple[str, int]],
        *,
        reached_done: bool,
    ) -> None:
        """Record the completed run's trajectory to the Evolution_Engine (R12.1)."""
        if self.evolution is None:
            return
        run = CompletedRun(
            run_id=self.run_id,
            stages=tuple(_to_evo_stage(s) for s in stages),
            applied_edits=tuple(EvoDiff(path=d.path, diff=d.diff) for d in applied),
            checks=tuple(EvoCheckOutcome(command=c, exit_code=e) for c, e in checks),
            reached_done=reached_done,
        )
        self.evolution.on_run_complete(run)


def execute_run(
    request: AgentRunRequest,
    run_id: str,
    *,
    gate: EmitGate,
    text_sink: TextSink,
    close: Callable[[], None],
    workspace_root: Path | str | None = ".",
    state_store: StateWrapperStore | None = None,
    evolution: EvolutionEngine | None = None,
    diary_sink: DiarySink | None = None,
    brain: AgentBrain | None = None,
    rag_matcher: RagMatcher | None = None,
    wait_for_review_decision: ReviewDecisionWaiter | None = None,
    wait_for_approval_decision: ReviewDecisionWaiter | None = None,
    file_selector: FileSelector | None = None,
    workspace_indexer: WorkspaceIndexer | None = None,
    index_session_id: str | None = None,
    hybrid_candidate_source: bool = False,
    apply_strategy: ApplyStrategy = ApplyStrategy.SINGLE_PASS,
    run_with_tools: ToolModelFn = generate_with_tools,
    mcp_host: MCPHost | None = None,
    mcp_loop: asyncio.AbstractEventLoop | None = None,
    check_permission: PermissionGate | None = None,
    network_allowlist: Sequence[str] | None = None,
    is_cancelled: Callable[[], bool] | None = None,
    plan_only: bool = False,
    file_locks: FileLockRegistry | None = None,
    project_memory: ProjectMemoryStore | None = None,
    hermes: HermesEvolution | None = None,
    failure_sink: Callable[[str, str], None] | None = None,
) -> RunResult:
    """Build a :class:`RunPipeline` for ``request`` and drive it to completion.

    This is the single call the gateway endpoint makes to wire and run the
    full backend path for a run.

    ``apply_strategy`` selects the APPLY_EDITS executor (defaults to
    :attr:`ApplyStrategy.SINGLE_PASS` so existing callers are unchanged); the
    desktop endpoint opts into :attr:`ApplyStrategy.REACT` for the iterative
    read/act/observe agent loop. ``rag_matcher`` injects the run's Context Bus
    matcher (defaults to the no-op :class:`NullRagMatcher` inside the pipeline);
    the desktop endpoint injects a workspace-scanning matcher so the planner
    sees real code context. ``run_with_tools`` is the ReAct model boundary
    (defaults to the real :func:`generate_with_tools`); tests inject a scripted
    tool model.
    """
    try:
        pipeline = RunPipeline(
            request,
            run_id,
            gate=gate,
            text_sink=text_sink,
            close=close,
            workspace_root=workspace_root,
            state_store=state_store,
            evolution=evolution,
            diary_sink=diary_sink,
            brain=brain,
            rag_matcher=rag_matcher,
            wait_for_review_decision=wait_for_review_decision,
            wait_for_approval_decision=wait_for_approval_decision,
            file_selector=file_selector,
            workspace_indexer=workspace_indexer,
            index_session_id=index_session_id,
            hybrid_candidate_source=hybrid_candidate_source,
            apply_strategy=apply_strategy,
            run_with_tools=run_with_tools,
            mcp_host=mcp_host,
            mcp_loop=mcp_loop,
            check_permission=check_permission,
            network_allowlist=network_allowlist,
            is_cancelled=is_cancelled,
            plan_only=plan_only,
            file_locks=file_locks,
            project_memory=project_memory,
            hermes=hermes,
            failure_sink=failure_sink,
        )
        try:
            return pipeline.run()
        finally:
            pipeline.cleanup()
    finally:
        close()
