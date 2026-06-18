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

import itertools
import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from shared_schema.agent_events import AgentEvent

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
from zocai_gateway.context.rag_matcher import (
    NullRagMatcher,
    RagFragment,
    RagMatcher,
    WorkspaceRagMatcher,
)
from zocai_gateway.context.shell_fs import FSReadAdapter, ShellSpawner
from zocai_gateway.context.steering_compiler import (
    DEFAULT_STEERING_DIR,
    SteeringPayload,
    compile_steering,
)
from zocai_gateway.context.token_gate import TokenGateResult, fit_fragments
from zocai_gateway.edits import EditCoordinator, EditPlan
from zocai_gateway.emit_gate import EmitGate
from zocai_gateway.fsm import FSM
from zocai_gateway.hardware_probe import HardwareProfile
from zocai_gateway.hot_swap import HotSwapCoordinator, HotSwapResult, ModelLoader
from zocai_gateway.intent_event import (
    DEFAULT_INTENT_TEXT,
    allocation_stage_event_factory,
)
from zocai_gateway.memory.matrix import MemoryMatrix
from zocai_gateway.memory.state_wrapper import Diff, StateWrapper, StateWrapperStore
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
from zocai_gateway.orchestrator import Orchestrator
from zocai_gateway.remediation import RemediationLoop
from zocai_gateway.stages import Stage
from zocai_gateway.toolsets import FullToolset

__all__ = [
    "AgentBrain",
    "AllocationSignals",
    "DefaultAgentBrain",
    "RunContext",
    "RunPipeline",
    "RunResult",
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

    Carries the allocation it was sized against, the token-gated RAG fragments
    that fit the window (R8.5), the compiled steering payload (R8.2), and the
    MCP tool identifiers available to the run (R8.3). It is handed to the brain
    so the edit plan can be produced against real context.
    """

    allocation: Allocation
    fragments: tuple[RagFragment, ...]
    steering: SteeringPayload
    token_gate: TokenGateResult
    mcp_tools: tuple[str, ...]


class AgentBrain(Protocol):
    """The injected model behavior the pipeline drives (test/runtime seam).

    Implementations decide the tier signals, the edit plan, the RUN_CHECKS
    outcome, any remediation plan, and the Ask answer. The pipeline owns all
    orchestration, emission, and persistence around these decisions.
    """

    def allocation_signals(self, request: AgentRunRequest) -> AllocationSignals: ...

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
    prompt back as the Ask answer.
    """

    def allocation_signals(self, request: AgentRunRequest) -> AllocationSignals:
        return AllocationSignals()

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
    ) -> None:
        self.request = request
        self.run_id = run_id
        self.workspace_root = Path(workspace_root)
        self._close = close
        self._text_sink = text_sink

        self.brain: AgentBrain = brain if brain is not None else DefaultAgentBrain()
        self.allocator = allocator if allocator is not None else ModelAllocator()
        self.rag_matcher: RagMatcher = (
            rag_matcher if rag_matcher is not None else NullRagMatcher()
        )
        self.mcp_gateway = mcp_gateway if mcp_gateway is not None else MCPGateway()
        self.model_loader = model_loader
        self.evolution = evolution
        self._diary_sink = diary_sink

        matrix = MemoryMatrix(self.workspace_root)
        self.state_store = (
            state_store
            if state_store is not None
            else StateWrapperStore(matrix.state_wrapper_path)
        )

        # Mode routing (R2.1/R3.1) selects the path; the channel enforces the
        # mode-scoped discipline: Agent = structured-only through the gate,
        # Ask = text-only (R6.6/R6.7).
        self.path = ModeRouter().route(request)
        self.toolset = FullToolset(self.workspace_root)
        self.fs_read = FSReadAdapter(self.workspace_root)
        self.shell_spawner = ShellSpawner(self.path.mode, self.workspace_root)
        self._channel: ModeChannel = channel_for(
            self.path, gate=gate, text_sink=text_sink
        )
        self._next_seq: Callable[[], int] = itertools.count().__next__

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
            self.request,
            generate=self.brain.ask_response,
            workspace_root=self.workspace_root,
            rag_matcher=self.rag_matcher,
        )
        if isinstance(result, AskResponse):
            text = result.text
        elif isinstance(result, SwitchToAgentMessage):
            text = result.message
        elif isinstance(result, AskError):
            text = result.message
        else:  # pragma: no cover - exhaustive over AskResult
            text = ""
        self._channel.emit_text(text)
        self._close()
        return RunResult(
            mode=Mode.ASK,
            run_id=self.run_id,
            stage=Stage.DONE,
            stages=(),
            ask_text=text,
        )

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
        edits = EditCoordinator(toolset=self.toolset, run_id=self.run_id, emit=self._emit)
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

        # INTAKE → ANALYZE → MAP_FILES → READ_FILES → PLAN_EDITS (R3.2).
        for _ in range(4):
            stages.append(fsm.advance())

        return self._plan_check_loop(
            fsm, edits, orchestrator, remediation, context, allocation, stages
        )

    def _plan_check_loop(
        self,
        fsm: FSM,
        edits: EditCoordinator,
        orchestrator: Orchestrator,
        remediation: RemediationLoop,
        context: RunContext,
        allocation: Allocation,
        stages: list[Stage],
    ) -> RunResult:
        """Run PLAN_EDITS→APPLY_EDITS→RUN_CHECKS with the remediation loop (R3/R5).

        Bounded by the error-recovery budget: a remediation that would exceed
        the recovery ceiling (R4.4) freezes the loop and serializes state to
        the State_Wrapper for a hot-swap instead of looping forever (R11.1).
        """
        try:
            plan = self.brain.edit_plan(self.request, context)
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
        applied: list[Diff] = []
        checks: list[tuple[str, int]] = []

        # The loop can only re-enter PLAN_EDITS as many times as the recovery
        # budget allows; the guard is a hard backstop against a runaway planner.
        for _ in range(orchestrator.budget.ERROR_CEILING + 1):
            edits.plan_edits(plan)  # collapsible thinking event (R3.6)

            if plan.has_changes:
                stages.append(fsm.plan_complete(has_changes=True))  # APPLY_EDITS
                outcome = edits.apply_edits(plan)  # edit-file events (R3.7)
                applied.extend(
                    Diff(path=c.path, diff=c.diff) for c in outcome.applied
                )
                for change in outcome.applied:
                    orchestrator.active_file_markers.append(change.path)
                    orchestrator.budget.count_file_op()  # R4.1
                if not outcome.ok:
                    # R3.9: apply failed → unrecoverable terminal error close.
                    fsm.fail(outcome.error or "apply failed")
                    stages.append(Stage.ERROR_CLOSED)
                    self._close()
                    return RunResult(
                        mode=Mode.AGENT,
                        run_id=self.run_id,
                        stage=Stage.ERROR_CLOSED,
                        stages=tuple(stages),
                        allocation=allocation,
                    )
                stages.append(fsm.advance())  # APPLY_EDITS → RUN_CHECKS
            else:
                stages.append(fsm.plan_complete(has_changes=False))  # R3.8

            try:
                exit_code, command, log = self.brain.run_checks(self.request, plan)
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
            rem = remediation.on_checks_complete(
                exit_code, command=command, log=log, prior_plan=plan
            )

            if rem.stage is Stage.SUMMARY:  # R5.8
                stages.append(Stage.SUMMARY)
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
) -> RunResult:
    """Build a :class:`RunPipeline` for ``request`` and drive it to completion.

    This is the single call the gateway endpoint makes to wire and run the
    full backend path for a run.
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
        )
        return pipeline.run()
    finally:
        close()
