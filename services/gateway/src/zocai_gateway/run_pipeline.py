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

import contextlib
import functools
import itertools
import json
import logging
import os
import re
import shutil
import tempfile
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from enum import Enum
from pathlib import Path
from typing import Protocol

from pydantic import ValidationError
from shared_schema.agent_events import (
    AgentEvent,
    BudgetEvent,
    CommandEvent,
    PlanEvent,
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

from zocai_gateway.channel import ModeChannel, TextSink, channel_for
from zocai_gateway.context.mcp_gateway import MCPGateway
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
from zocai_gateway.context.token_gate import TokenGateResult, estimate_tokens, fit_fragments
from zocai_gateway.context_mentions import expand_prompt_file_mentions
from zocai_gateway.edits import EditCoordinator, EditPlan, PlannedChange
from zocai_gateway.emit_gate import EmitGate
from zocai_gateway.fsm import FSM, EmitSink
from zocai_gateway.hardware_probe import HardwareProfile
from zocai_gateway.hot_swap import HotSwapCoordinator, HotSwapResult, ModelLoader
from zocai_gateway.intent_event import (
    DEFAULT_INTENT_TEXT,
    allocation_stage_event_factory,
)
from zocai_gateway.memory.matrix import (
    CompressionError,
    ConversationMemory,
    MemoryMatrix,
    Message,
    Role,
    runtime_summarizer,
    tokenizer_kind_for_tier,
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
    Mode,
    ModeRouter,
    SwitchToAgentMessage,
)
from zocai_gateway.model_allocator import Allocation, AllocationAborted, ModelAllocator
from zocai_gateway.model_interface import Cloud, Edge, LocalSLM, ModelInterface, ModelTier
from zocai_gateway.model_runtime import (
    ModelRuntimeError,
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
from zocai_gateway.react import ReActExecutor, ToolModelFn
from zocai_gateway.remediation import RemediationLoop
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


def default_workspace_rag_matcher(workspace_root: Path | str) -> WorkspaceRagMatcher:
    """A workspace-scanning RAG_Matcher rooted at ``workspace_root`` (R8.1).

    Provided as the real-matcher factory the pipeline can be given; the default
    pipeline uses the no-op :class:`NullRagMatcher` so a synchronous run never
    blocks on scanning a large tree.
    """
    return WorkspaceRagMatcher(folders=(Path(workspace_root),))


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

    def structured_plan(
        self, request: AgentRunRequest, context: RunContext
    ) -> AgentPlan: ...

    def edit_plan(self, request: AgentRunRequest, context: RunContext) -> EditPlan: ...

    def run_checks(
        self, request: AgentRunRequest, plan: EditPlan
    ) -> tuple[int, str, str]: ...

    def remediation_plan(
        self, prior: EditPlan, failure: object
    ) -> EditPlan | None: ...

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

    def structured_plan(
        self, request: AgentRunRequest, context: RunContext
    ) -> AgentPlan:
        return AgentPlan(steps=[], verification_command=None, confidence=1.0)

    def edit_plan(self, request: AgentRunRequest, context: RunContext) -> EditPlan:
        return EditPlan(reasoning=f"no changes required for: {request.prompt}")

    def run_checks(
        self, request: AgentRunRequest, plan: EditPlan
    ) -> tuple[int, str, str]:
        return (0, "noop-check", "")

    def remediation_plan(
        self, prior: EditPlan, failure: object
    ) -> EditPlan | None:
        return None

    def ask_response(self, prompt: str, context: AskContext) -> str:
        return prompt


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

    def update_context(self, context: RunContext) -> None:
        self._context = context

    def think(self, request: AgentRunRequest, context: RunContext) -> str:
        thinking_request = request.model_copy(update={"max_tokens": 1024})
        try:
            text = generate_text(
                thinking_request,
                system_prompt=_thinking_system_prompt(context),
                timeout=60.0,
            )
        except ModelRuntimeError as exc:
            raise RuntimeError(f"model thinking failed: {exc}") from exc
        if not text:
            # No provider configured (empty response): produce no scratchpad
            # and proceed to ANALYZE like the DefaultAgentBrain path (R1.7/1.8).
            return ""
        if not _has_think_block(text):
            # R2.4: a non-empty response that carries no complete
            # <think>...</think> block (including an opening <think> with no
            # matching close) fails closed.
            raise RuntimeError(
                "model thinking response did not contain a complete "
                "<think>...</think> block"
            )
        # A complete-but-empty/whitespace block is a valid extraction that
        # yields no scratchpad: proceed to ANALYZE with no ThinkingEvent, just
        # like the no-provider path (the R1.3 vs R2.4 boundary).
        return _extract_thinking(text)

    def structured_plan(
        self, request: AgentRunRequest, context: RunContext
    ) -> AgentPlan:
        self._request = request
        self._context = context
        response_format = _agent_plan_response_format()
        supports_response_format = (request.provider or "").lower() != "anthropic"
        system_prompt = _structured_plan_system_prompt(
            context, include_schema=not supports_response_format
        )
        try:
            text = generate_text(
                request,
                system_prompt=system_prompt,
                response_format=response_format if supports_response_format else None,
                timeout=120.0,
            )
        except ModelRuntimeError:
            if not supports_response_format:
                raise
            supports_response_format = False
            text = generate_text(
                request,
                system_prompt=_structured_plan_system_prompt(context, include_schema=True),
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
                    context, include_schema=not supports_response_format
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
                system_prompt=_agent_system_prompt(context, self._structured_plan),
                timeout=120.0,
            )
        except ModelRuntimeError as exc:
            raise RuntimeError(f"model planner failed: {exc}") from exc
        if not text:
            return super().edit_plan(request, context)
        return _edit_plan_from_model_text(text)

    def remediation_plan(
        self, prior: EditPlan, failure: object
    ) -> EditPlan | None:
        """Feed failed test output into the next planner call."""
        request = self._request
        context = self._context
        if request is None or context is None or not isinstance(failure, FailureRecord):
            return None
        output = failure.log[-2_000:]
        verify_result = parse_verify_result(
            failure.command, failure.log, failure.exit_code
        )
        failed_tests = "\n".join(f"- {name}" for name in verify_result.failures)
        prior_steps = "\n".join(
            f"- {change.path}: {change.diff or 'full-file replacement'}"
            for change in prior.changes
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
            text = generate_text(
                request.model_copy(update={"prompt": retry_prompt}),
                system_prompt=_agent_system_prompt(context, self._structured_plan),
                timeout=120.0,
            )
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

_THINK_BLOCK_RE = re.compile(r"<think>(.*?)</think>", re.IGNORECASE | re.DOTALL)


def _extract_thinking(text: str) -> str:
    """Extract only the private scratchpad block from a thinking response.

    Returns the stripped content between the first ``<think>`` and the first
    ``</think>`` that follows it (R1.3, R2.3). Returns ``""`` when no complete
    block is present *or* when the block is present but empty/whitespace; use
    :func:`_has_think_block` to distinguish those two cases (the R1.3 vs R2.4
    boundary).
    """
    match = _THINK_BLOCK_RE.search(text)
    return match.group(1).strip() if match is not None else ""


def _has_think_block(text: str) -> bool:
    """Whether a *complete* ``<think>...</think>`` block is present (R2.4).

    A complete block requires both the opening ``<think>`` and a following
    ``</think>``; a response with an opening tag but no matching close has no
    complete block and so returns ``False``. This is the signal that separates
    "no complete block" (fail closed, R2.4) from "a complete but empty block"
    (a valid extraction yielding no scratchpad, R1.3).
    """
    return _THINK_BLOCK_RE.search(text) is not None


def _thinking_system_prompt(context: RunContext) -> str:
    return prepend_project_instructions(
        THINKING_SYSTEM_PROMPT, context.project_instructions
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
    context: RunContext, *, include_schema: bool
) -> str:
    parts = [
        "Create a concise, ordered edit plan for the coding task. Return only "
        "JSON matching the AgentPlan schema. Paths must be workspace-relative, "
        "rationales must be one sentence, and search strings must be exact.",
    ]
    if context.scratchpad:
        parts.append(f"Private planning scratchpad:\n{context.scratchpad}")
    if context.read_files_payload:
        parts.append(f"Selected workspace files:\n{context.read_files_payload}")
    if context.conversation_history:
        parts.append(f"Conversation history:\n{context.conversation_history}")
    if include_schema:
        parts.append(
            "AgentPlan schema (JSON, also valid YAML):\n"
            + json.dumps(AgentPlan.model_json_schema(), indent=2, sort_keys=True)
        )
    return prepend_project_instructions(
        "\n\n".join(parts), context.project_instructions
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
    context: RunContext, structured_plan: AgentPlan | None = None
) -> str:
    parts = [
        "You are Zoc Agent, a coding agent planner. Return only JSON with this "
        'shape: {"reasoning":"short explanation","changes":[{"path":"relative/path","content":"full replacement file content","diff":"short summary"}]}.',
        "Only include a change when you know the exact full replacement file "
        "content. If the request is only chat or you are unsure, return an "
        'empty changes array with useful reasoning.',
    ]
    if context.scratchpad:
        parts.append(f"Private planning scratchpad:\n{context.scratchpad}")
    if context.read_files_payload:
        parts.append(f"Selected workspace files:\n{context.read_files_payload}")
    if context.conversation_history:
        parts.append(f"Conversation history:\n{context.conversation_history}")
    if structured_plan is not None:
        parts.append(
            "Approved structured plan:\n"
            + structured_plan.model_dump_json(exclude_none=True)
        )
    steering = context.steering.text.strip()
    if steering:
        parts.append(f"Project steering:\n{steering}")
    if context.fragments:
        fragments = []
        for fragment in context.fragments[:8]:
            fragments.append(f"{fragment.path}:\n{fragment.content}")
        parts.append("Relevant code context:\n\n" + "\n\n".join(fragments))
    if context.mcp_tools:
        parts.append("Available MCP tools: " + ", ".join(context.mcp_tools))
    return prepend_project_instructions("\n\n".join(parts), context.project_instructions)


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


# ── APPLY_EDITS strategy seam (Req 8, R3.7-R3.9) ─────────────────────────────


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

    def apply(self) -> ApplyResult:
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
        workspace_root: Path | str = ".",
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
    ) -> None:
        self.run_id = run_id
        self.source_workspace_root = Path(workspace_root).resolve()
        self.original_request = request
        self.request = request.model_copy(
            update={
                "prompt": expand_prompt_file_mentions(
                    request.prompt,
                    self.source_workspace_root,
                    request.context_files,
                )
            }
        )
        self._close = close
        self._text_sink = text_sink
        self._ask_streamed = False
        self._wait_for_review_decision = wait_for_review_decision
        self._wait_for_approval_decision = wait_for_approval_decision
        self._project_test_runner = project_test_runner
        self.apply_strategy = apply_strategy
        self._run_with_tools = run_with_tools
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
        self.rag_matcher: RagMatcher = (
            rag_matcher if rag_matcher is not None else NullRagMatcher()
        )
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
        if self.path.mode is Mode.AGENT and self.request.review_changes:
            self._isolated_workspace_root = self._create_isolated_workspace(
                self.source_workspace_root
            )
            self.workspace_root = self._isolated_workspace_root
            self._checkpoint_id = f"isolated-{run_id}"
        else:
            self.workspace_root = self.source_workspace_root

        matrix = MemoryMatrix(self.source_workspace_root)
        self.state_store = (
            state_store
            if state_store is not None
            else StateWrapperStore(matrix.state_wrapper_path)
        )

        self.toolset = FullToolset(self.workspace_root)
        self.fs_read = FSReadAdapter(self.workspace_root)
        self.shell_spawner = ShellSpawner(self.path.mode, self.workspace_root)
        self._channel: ModeChannel = channel_for(
            self.path, gate=gate, text_sink=text_sink
        )
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
            ignore=lambda _dir, names: [
                name for name in names if name in _ISOLATED_IGNORE_NAMES
            ],
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
        root = self._isolated_workspace_root
        if root is None:
            return
        try:
            shutil.rmtree(root, ignore_errors=True)
        finally:
            self._isolated_workspace_root = None

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

    def _emit_plan(
        self, plan: EditPlan, structured_plan: AgentPlan | None = None
    ) -> None:
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
                    if structured_plan is not None
                    and structured_plan.verification_command
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
                    )
                    for diff in applied
                ],
                validation=_validation_from_checks(checks),
                checkpoint_id=self._checkpoint_id,
            )
        )

    def _emit_human_summary(self, text: str) -> None:
        self._emit(
            SummaryEvent(seq=0, run_id=self.run_id, ts=_now(), text=text)
        )

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

    def _run_post_write_tests(self) -> ProjectTestResult | None:
        detected = detect_project_test_command(self.workspace_root)
        if detected is None:
            return None
        return self._project_test_runner(self.workspace_root, detected)

    def _provider_configured(self) -> bool:
        """Whether a model provider and model are configured for this run.

        The ReAct strategy only engages with a real tool-calling model behind
        it (design selection rule); with no provider the run falls back to the
        single-pass path or the empty-plan skip.
        """
        return bool(
            (self.request.provider or "").strip() and (self.request.model or "").strip()
        )

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

    def _copy_review_paths(self, paths: list[str]) -> None:
        isolated = self._isolated_workspace_root
        if isolated is None:
            return
        for raw_path in paths:
            rel = _safe_relative_path(raw_path)
            source = isolated / rel
            target = self.source_workspace_root / rel
            if not source.exists():
                raise FileNotFoundError(f"review file disappeared: {raw_path}")
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)

    def _review_and_maybe_apply(self, applied: list[Diff]) -> str:
        if not applied:
            self._emit_plan_update("review", "done")
            self._emit_plan_update("summary", "active")
            return "No file changes were needed."
        self._emit_plan_update("review", "active")
        waiter = self._wait_for_review_decision
        if waiter is None:
            self._emit_plan_update("review", "done")
            self._emit_plan_update("summary", "active")
            return "Review is unavailable, so no isolated changes were applied."
        decision = waiter(None)
        if decision is None:
            self._emit_plan_update("review", "done")
            self._emit_plan_update("summary", "active")
            return "Review was closed before a decision, so no changes were applied."
        verdict = getattr(decision, "decision", None)
        if verdict == "discard":
            self._emit_plan_update("review", "done")
            self._emit_plan_update("summary", "active")
            return "Discarded the isolated changes. Your workspace was left unchanged."
        accepted_paths = list(getattr(decision, "accepted_paths", []) or [])
        self._copy_review_paths(accepted_paths)
        self._emit_plan_update("review", "done")
        self._emit_plan_update("summary", "active")
        count = len(accepted_paths)
        noun = "file" if count == 1 else "files"
        return f"Applied {count} reviewed {noun} to your workspace."

    # -- entrypoint ---------------------------------------------------------

    def run(self) -> RunResult:
        """Drive the routed run to a terminal outcome and close the stream."""
        if isinstance(self.path, AskPath):
            return self._run_ask(self.path)
        return self._run_agent()

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
            generate=lambda _prompt, context: self._ask_response(
                self.request.prompt, context
            ),
            workspace_root=self.workspace_root,
            rag_matcher=self.rag_matcher,
        )
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
            workspace_root=self.workspace_root,
        )

    def _read_selected_files(
        self, event: MapFilesEvent
    ) -> tuple[str, tuple[str, ...]]:
        read_paths: list[str] = []

        def read_file(path: str) -> str:
            content = self.toolset.read_file(path)
            read_paths.append(path)
            return content

        payload = build_read_files_payload(
            event.read_list,
            read_file,
            token_cap=PER_FILE_TOKEN_CAP,
        )
        return payload, tuple(read_paths)

    def _new_conversation_memory(self, context: RunContext) -> ConversationMemory:
        return ConversationMemory(
            messages=[
                Message(
                    Role.SYSTEM,
                    "You are Zoc Agent, a workspace-confined coding assistant.",
                    Stage.INTAKE.value,
                ),
                Message(Role.USER, self.request.prompt, Stage.INTAKE.value),
            ],
            tokenizer_kind=tokenizer_kind_for_tier(context.allocation.tier),
        )

    @staticmethod
    def _context_with_memory(
        context: RunContext, memory: ConversationMemory
    ) -> RunContext:
        rendered = "\n".join(
            f"{message.role.value}: {message.content}" for message in memory.messages
        )
        return replace(context, conversation_history=rendered)

    def _maybe_compress(
        self, memory: ConversationMemory, max_tokens: int
    ) -> None:
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
            fsm = FSM(initial=Stage.INTAKE, run_id=self.run_id, emit=self._emit)
            fsm.fail(f"{type(exc).__name__}: {exc}")
            stages.append(Stage.ERROR_CLOSED)
            self._close()
            return RunResult(
                mode=Mode.AGENT,
                run_id=self.run_id,
                stage=Stage.ERROR_CLOSED,
                stages=tuple(stages),
                allocation=None,
            )

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
        )
        memory = self._new_conversation_memory(context)
        self._maybe_compress(memory, allocation.context_window)
        context = self._context_with_memory(context, memory)
        thinking_started = time.monotonic()
        try:
            scratchpad = self.brain.think(self.request, context)
        except Exception as exc:
            reason = f"thinking failed: {type(exc).__name__}: {exc}"
            logger.exception("run %s failed during private thinking", self.run_id)
            fsm.fail(reason)
            stages.append(Stage.ERROR_CLOSED)
            self._close()
            return RunResult(
                mode=Mode.AGENT,
                run_id=self.run_id,
                stage=Stage.ERROR_CLOSED,
                stages=tuple(stages),
                allocation=allocation,
            )
        if scratchpad:
            memory.messages.append(
                Message(Role.ASSISTANT, scratchpad, Stage.ANALYZE.value)
            )
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
            self._close()
            return RunResult(
                mode=Mode.AGENT,
                run_id=self.run_id,
                stage=Stage.ERROR_CLOSED,
                stages=tuple(stages),
                allocation=allocation,
            )
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
        if read_payload:
            memory.messages.append(
                Message(Role.TOOL_RESULT, read_payload, Stage.READ_FILES.value)
            )
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
                preapproved_writes(map_event)
                if self._enforce_write_allowlist
                else None
            ),
            wait_for_approval=self._wait_for_approval_decision,
        )
        orchestrator = Orchestrator(
            fsm=fsm, edits=edits, run_id=self.run_id, emit=self._emit
        )
        remediation = RemediationLoop(
            fsm=fsm,
            planner=self.brain.remediation_plan,
            diary=self._diary_sink,
            on_recovery=orchestrator.budget.count_recovery,
            run_id=self.run_id,
            emit=self._emit,
        )
        tokens_used = estimate_tokens(self.request.prompt) + estimate_tokens(
            _agent_system_prompt(context)
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
            reason = f"edit_plan failed: {type(exc).__name__}: {exc}"
            logger.exception("run %s failed while planning edits", self.run_id)
            fsm.fail(reason)
            stages.append(Stage.ERROR_CLOSED)
            self._close()
            return RunResult(
                mode=Mode.AGENT,
                run_id=self.run_id,
                stage=Stage.ERROR_CLOSED,
                stages=tuple(stages),
                allocation=allocation,
            )
        tokens_used += _estimate_edit_plan_tokens(plan)
        self._emit_budget(context, orchestrator, tokens_used)
        applied: list[Diff] = []
        checks: list[tuple[str, int]] = []
        remediating = False

        # The loop can only re-enter PLAN_EDITS as many times as the recovery
        # budget allows; the guard is a hard backstop against a runaway planner.
        for _ in range(orchestrator.budget.ERROR_CEILING + 1):
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
                    )
                result = executor.apply()
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
                    fsm.fail(result.error or "apply failed")
                    stages.append(Stage.ERROR_CLOSED)
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
                self._close()
                return RunResult(
                    mode=Mode.AGENT,
                    run_id=self.run_id,
                    stage=Stage.ERROR_CLOSED,
                    stages=tuple(stages),
                        allocation=allocation,
                    )
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
                self._emit_recovery_attempt(
                    remediation.recoveries + 1, verify_result.failures
                )
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
                    summary = (
                        self._review_and_maybe_apply(applied)
                        if self.request.review_changes
                        else "Completed the requested agent run."
                    )
                except Exception as exc:
                    reason = f"review apply failed: {type(exc).__name__}: {exc}"
                    logger.exception("run %s failed while applying review", self.run_id)
                    fsm.fail(reason)
                    stages.append(Stage.ERROR_CLOSED)
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
                stages.append(fsm.advance())  # SUMMARY → DONE (R3.4)
                self._close()
                self._record_evolution(stages, applied, checks, reached_done=True)
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
        hot_swap = self._preserve_and_swap(
            resume_stage, orchestrator, applied, allocation
        )
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
            store=self.state_store,
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
    workspace_root: Path | str = ".",
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
        )
        try:
            return pipeline.run()
        finally:
            pipeline.cleanup()
    finally:
        close()
