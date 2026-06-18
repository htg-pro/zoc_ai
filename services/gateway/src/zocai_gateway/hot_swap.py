"""The model hot-swap freeze / upshift / resume sequence (Requirement 11).

When the active model reaches the ``Execution_Budget`` ceiling — 20 file
iterations or 3 error-recovery attempts (R11.1) — the Orchestrator stops
feeding the active model and runs the sequence implemented here:

1. **Freeze + serialize (R11.1).** The active execution loop is frozen and the
   *run-resumable* slice of state — the FSM stage, active file markers, patch
   diffs, and captured compilation logs — is written to the model-agnostic
   :class:`~zocai_gateway.memory.state_wrapper.StateWrapper` on the Tier 2
   cross-model bus. The caller hands this slice in as a ``StateWrapper``; this
   module owns persisting it and driving the swap.

2. **Upshift within 30 s (R11.2).** The active model is unloaded and the *next
   higher* :class:`~zocai_gateway.model_interface.ModelTier` is loaded. The
   load is bounded to :data:`HOT_SWAP_DEADLINE_SECONDS`; a load that errors or
   overruns the deadline is a failure (R11.7).

3. **Rebuild + resume (R11.3–R11.5).** On a successful load the wrapper is read
   back from disk, the replacement model's prompt window is rebuilt sized to the
   :class:`~zocai_gateway.model_allocator.ModelAllocator` context window for the
   replacement tier (R11.3), and a fresh FSM is seeded at the recorded stage so
   the run resumes from exactly where it froze (R11.4). Because the window is
   rebuilt from the wrapper that was read back, the resumed stage, file markers,
   and patch diffs equal the stored values (R11.5).

Two branches override the default upshift:

* **Already at Cloud (R11.6).** Cloud is the highest tier, so there is no higher
  tier to upshift to. Instead of upshifting, pausing, or deferring to the
  Developer, the run *continues running* on Cloud — this specifically overrides
  the upshift-and-defer budget-pause behavior of Requirement 4 for the highest
  tier.

* **Load fails or overruns (R11.7).** The wrapper is **retained** (never
  deleted), the run stays **paused**, and an error event naming the failed load
  is emitted over the SSE bus so the Developer sees which load failed.

The store, allocator, loader, clock, sequence source, and emit sink are all
injectable so the whole sequence is exercisable without a real model runtime.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum

from shared_schema.agent_events import AgentEvent, CommandEvent

from zocai_gateway.fsm import FSM, EmitSink
from zocai_gateway.memory.state_wrapper import (
    Diff,
    FailureRecord,
    StateWrapper,
    StateWrapperStore,
)
from zocai_gateway.model_allocator import ModelAllocator
from zocai_gateway.model_interface import ModelInterface, ModelTier
from zocai_gateway.stages import Stage

__all__ = [
    "HOT_SWAP_DEADLINE_SECONDS",
    "NEXT_TIER",
    "Clock",
    "ModelLoader",
    "ModelUnloader",
    "FSMFactory",
    "HotSwapOutcomeKind",
    "PromptWindow",
    "HotSwapResult",
    "HotSwapCoordinator",
    "next_higher_tier",
]

#: Upper bound on the unload+load step (R11.2). A load that errors or runs
#: longer than this many seconds is treated as a failed load (R11.7).
HOT_SWAP_DEADLINE_SECONDS = 30.0

#: The strict upshift order: each tier maps to the next higher one. Cloud is
#: the highest tier and is intentionally absent — there is nothing above it
#: (R11.6).
NEXT_TIER: dict[ModelTier, ModelTier] = {
    ModelTier.LOCAL_SLM: ModelTier.EDGE,
    ModelTier.EDGE: ModelTier.CLOUD,
}


def next_higher_tier(tier: ModelTier) -> ModelTier | None:
    """The tier one step above ``tier``, or ``None`` when ``tier`` is Cloud (R11.2/11.6)."""
    return NEXT_TIER.get(tier)


#: A monotonic wall-clock source (seconds), injected so the 30 s deadline can be
#: driven deterministically in tests.
Clock = Callable[[], float]

#: Loads (and implicitly initializes) a replacement tier, returning the live
#: model. Raising any exception signals a failed load (R11.7).
ModelLoader = Callable[[ModelTier], ModelInterface]

#: Unloads the active model before the replacement is loaded (R11.2).
ModelUnloader = Callable[[ModelInterface], None]

#: Builds the resumed FSM seeded at the recorded stage (R11.4).
FSMFactory = Callable[[Stage], FSM]


class HotSwapOutcomeKind(str, Enum):
    """How a hot-swap trigger resolved."""

    #: A lower tier was upshifted to the next higher tier and the run resumed
    #: from the recorded stage (R11.2–R11.5).
    UPSHIFTED = "upshifted"
    #: The active tier was already Cloud, so the run continued running on Cloud
    #: rather than upshifting/pausing/deferring (R11.6).
    CONTINUED_ON_CLOUD = "continued-on-cloud"
    #: Loading the replacement tier failed or overran the deadline; the wrapper
    #: was retained and the run kept paused (R11.7).
    LOAD_FAILED = "load-failed"


@dataclass(frozen=True, slots=True)
class PromptWindow:
    """A replacement model's prompt window rebuilt from the State_Wrapper (R11.3).

    :attr:`size` is the allocator's context window for :attr:`tier` (R11.3); the
    remaining fields are the run-resumable state read back from the wrapper, so
    they equal the stored values (R11.5).
    """

    tier: ModelTier
    size: int
    stage: Stage
    active_file_markers: list[str]
    patch_diffs: list[Diff]
    compilation_logs: list[FailureRecord]


@dataclass(frozen=True, slots=True)
class HotSwapResult:
    """The outcome of a single hot-swap trigger.

    ``state`` is the wrapper that was serialized at freeze time (and, on the
    upshift path, read back from disk). ``new_tier`` / ``prompt_window`` /
    ``fsm`` are populated only on a successful upshift; ``error_event`` /
    ``failed_tier`` only on a failed load.
    """

    kind: HotSwapOutcomeKind
    active_tier: ModelTier
    paused: bool
    state: StateWrapper
    new_tier: ModelTier | None = None
    prompt_window: PromptWindow | None = None
    fsm: FSM | None = None
    error_event: AgentEvent | None = None
    failed_tier: ModelTier | None = None


def _default_fsm_factory(run_id: str, emit: EmitSink | None) -> FSMFactory:
    """Build an :class:`FSMFactory` that seeds a fresh FSM at the recorded stage."""

    def factory(stage: Stage) -> FSM:
        return FSM(initial=stage, run_id=run_id, emit=emit)

    return factory


@dataclass(slots=True)
class HotSwapCoordinator:
    """Drives the freeze / upshift / resume sequence on a budget ceiling (R11).

    Args:
        store: The Tier 2 State_Wrapper store the run state is serialized to and
            read back from.
        allocator: Sizes the replacement tier's rebuilt prompt window (R11.3).
        loader: Loads the replacement tier; raising signals a failed load.
        run_id: Run identifier stamped on the resumed FSM and the error event.
        emit: Optional SSE sink. The failed-load error event (R11.7) and the
            resumed FSM's stage events are sent here.
        next_seq: Monotonic sequence source for the error event so it interleaves
            correctly with the rest of the stream. Defaults to an internal
            counter starting at zero.
        unloader: Optional hook to release the active model before loading the
            replacement (R11.2).
        fsm_factory: Builds the resumed FSM from the recorded stage. Defaults to
            a fresh :class:`FSM` bound to ``run_id`` and ``emit``.
        clock: Monotonic clock used to measure the load against the deadline.
        deadline_seconds: Maximum allowed unload+load duration (R11.2).
    """

    store: StateWrapperStore
    allocator: ModelAllocator
    loader: ModelLoader
    run_id: str = "run"
    emit: EmitSink | None = None
    next_seq: Callable[[], int] | None = None
    unloader: ModelUnloader | None = None
    fsm_factory: FSMFactory | None = None
    clock: Clock = time.monotonic
    deadline_seconds: float = HOT_SWAP_DEADLINE_SECONDS
    _seq_counter: int = field(init=False, default=0)

    def __post_init__(self) -> None:
        if self.fsm_factory is None:
            self.fsm_factory = _default_fsm_factory(self.run_id, self.emit)

    def trigger(
        self,
        state: StateWrapper,
        active_tier: ModelTier,
        *,
        active_model: ModelInterface | None = None,
    ) -> HotSwapResult:
        """Run the hot-swap sequence for a frozen run on ``active_tier`` (R11.1–R11.7).

        The caller has already detected the budget ceiling and frozen the loop;
        ``state`` is the run-resumable slice to preserve. The wrapper is written
        first (R11.1) and then the swap branches on the active tier.
        """
        # R11.1: persist the frozen run state to the Tier 2 cross-model bus.
        self.store.save(state)

        # R11.6: Cloud is the highest tier — keep running on Cloud instead of
        # upshifting, pausing, or deferring to the Developer.
        if active_tier is ModelTier.CLOUD:
            return HotSwapResult(
                kind=HotSwapOutcomeKind.CONTINUED_ON_CLOUD,
                active_tier=ModelTier.CLOUD,
                paused=False,
                state=state,
            )

        target = next_higher_tier(active_tier)
        # ``target`` is non-None for every non-Cloud tier; the guard above
        # already handled Cloud.
        assert target is not None  # noqa: S101 - invariant of NEXT_TIER vs the Cloud guard

        # R11.2: unload the active model, then load the replacement within 30 s.
        if self.unloader is not None and active_model is not None:
            self.unloader(active_model)

        loaded = self._load_within_deadline(target)
        if loaded is None:
            # R11.7: load failed or overran — retain the wrapper (already saved,
            # never deleted), keep the run paused, and emit a naming error event.
            error_event = self._emit_failed_load(target)
            return HotSwapResult(
                kind=HotSwapOutcomeKind.LOAD_FAILED,
                active_tier=active_tier,
                paused=True,
                state=state,
                error_event=error_event,
                failed_tier=target,
            )

        # R11.3: read the wrapper back and rebuild the prompt window sized to the
        # allocator's context window for the replacement tier.
        resumed_state = self.store.load()
        window = self._rebuild_window(target, resumed_state)

        # R11.4: resume the FSM from the stage recorded in the wrapper.
        assert self.fsm_factory is not None  # set in __post_init__
        fsm = self.fsm_factory(resumed_state.stage)

        return HotSwapResult(
            kind=HotSwapOutcomeKind.UPSHIFTED,
            active_tier=target,
            paused=False,
            state=resumed_state,
            new_tier=target,
            prompt_window=window,
            fsm=fsm,
        )

    # -- internals ---------------------------------------------------------

    def _load_within_deadline(self, tier: ModelTier) -> ModelInterface | None:
        """Load ``tier`` bounded to the deadline (R11.2).

        Returns the live model on a clean, in-time load; returns ``None`` when
        the load raises *or* its measured duration exceeds the deadline (R11.7).
        """
        start = self.clock()
        try:
            model = self.loader(tier)
        except Exception:
            # Any loader error is a failed load (R11.7); the duration is moot.
            return None
        elapsed = self.clock() - start
        if elapsed > self.deadline_seconds:
            return None
        return model

    def _rebuild_window(self, tier: ModelTier, state: StateWrapper) -> PromptWindow:
        """Rebuild the prompt window for ``tier`` from ``state`` (R11.3, R11.5)."""
        return PromptWindow(
            tier=tier,
            size=self.allocator.window_for(tier),
            stage=state.stage,
            active_file_markers=list(state.active_file_markers),
            patch_diffs=list(state.patch_diffs),
            compilation_logs=list(state.compilation_logs),
        )

    def _emit_failed_load(self, tier: ModelTier) -> AgentEvent:
        """Build, record, and emit the SSE error event naming the failed load (R11.7)."""
        event = CommandEvent(
            seq=self._take_seq(),
            run_id=self.run_id,
            ts=datetime.now(timezone.utc).isoformat(),
            command=f"<hot-swap:load:{tier.value}>",
            error_tag=f"hot-swap-load-failed:{tier.value}",
        )
        if self.emit is not None:
            self.emit(event)
        return event

    def _take_seq(self) -> int:
        """Next monotonic sequence number from the injected source or internal counter."""
        if self.next_seq is not None:
            return self.next_seq()
        seq = self._seq_counter
        self._seq_counter += 1
        return seq
