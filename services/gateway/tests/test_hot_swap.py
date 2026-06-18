"""Unit tests for the model hot-swap sequence (task 11.1, R11.1–R11.7).

These example-based tests exercise the freeze/serialize step, the strict
upshift to the next higher tier with window rebuild and stage resume, the
Cloud "keep running" override, and the failed/over-deadline load path that
retains the wrapper, keeps the run paused, and emits a naming error event.
The dedicated property tests (Properties 42/43) live in tasks 11.2/11.3.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pytest
from shared_schema.agent_events import CommandEvent
from zocai_gateway.hot_swap import (
    HOT_SWAP_DEADLINE_SECONDS,
    HotSwapCoordinator,
    HotSwapOutcomeKind,
    next_higher_tier,
)
from zocai_gateway.memory.state_wrapper import (
    Diff,
    FailureRecord,
    StateWrapper,
    StateWrapperStore,
)
from zocai_gateway.model_allocator import ModelAllocator
from zocai_gateway.model_interface import Cloud, Edge, LocalSLM, ModelInterface, ModelTier
from zocai_gateway.stages import Stage


def _sample_wrapper(stage: Stage = Stage.APPLY_EDITS) -> StateWrapper:
    return StateWrapper(
        stage=stage,
        active_file_markers=["src/a.py", "src/b.py"],
        patch_diffs=[Diff(path="src/a.py", diff="@@ -1 +1 @@\n-old\n+new\n")],
        compilation_logs=[FailureRecord(command="pytest", exit_code=1, log="boom")],
    )


def _store(tmp_path: Path) -> StateWrapperStore:
    return StateWrapperStore(tmp_path / "cross_model_bus" / "state_wrapper.json")


class _FakeClock:
    """A clock that returns queued values on successive calls."""

    def __init__(self, *values: float) -> None:
        self._values = list(values)

    def __call__(self) -> float:
        return self._values.pop(0)


def _ok_loader(model: ModelInterface) -> Callable[[ModelTier], ModelInterface]:
    def loader(tier: ModelTier) -> ModelInterface:
        return model

    return loader


# ── R11.1: freeze + serialize ────────────────────────────────────────────────


def test_trigger_writes_state_wrapper_first(tmp_path: Path) -> None:
    store = _store(tmp_path)
    coord = HotSwapCoordinator(
        store=store,
        allocator=ModelAllocator(),
        loader=_ok_loader(Edge()),
        clock=_FakeClock(0.0, 1.0),
    )

    state = _sample_wrapper()
    coord.trigger(state, ModelTier.LOCAL_SLM)

    # R11.1: the run-resumable slice was persisted to the Tier 2 bus.
    assert store.exists()
    assert store.load() == state


# ── R11.2–R11.5: upshift, rebuild window, resume stage ───────────────────────


def test_upshift_local_to_edge_rebuilds_window_and_resumes(tmp_path: Path) -> None:
    allocator = ModelAllocator()
    coord = HotSwapCoordinator(
        store=_store(tmp_path),
        allocator=allocator,
        loader=_ok_loader(Edge()),
        clock=_FakeClock(0.0, 5.0),
    )

    state = _sample_wrapper(stage=Stage.PLAN_EDITS)
    result = coord.trigger(state, ModelTier.LOCAL_SLM)

    assert result.kind is HotSwapOutcomeKind.UPSHIFTED
    assert result.new_tier is ModelTier.EDGE  # R11.2: next higher tier
    assert result.paused is False
    # R11.3: window sized to the allocator's context window for the new tier.
    assert result.prompt_window is not None
    assert result.prompt_window.size == allocator.window_for(ModelTier.EDGE)
    # R11.4: FSM resumes from the recorded stage.
    assert result.fsm is not None
    assert result.fsm.current is Stage.PLAN_EDITS
    # R11.5: resumed values equal the stored values.
    assert result.prompt_window.stage == state.stage
    assert result.prompt_window.active_file_markers == state.active_file_markers
    assert result.prompt_window.patch_diffs == state.patch_diffs
    assert result.prompt_window.compilation_logs == state.compilation_logs


def test_upshift_edge_to_cloud(tmp_path: Path) -> None:
    allocator = ModelAllocator()
    coord = HotSwapCoordinator(
        store=_store(tmp_path),
        allocator=allocator,
        loader=_ok_loader(Cloud()),
        clock=_FakeClock(0.0, 2.0),
    )

    result = coord.trigger(_sample_wrapper(), ModelTier.EDGE)

    assert result.kind is HotSwapOutcomeKind.UPSHIFTED
    assert result.new_tier is ModelTier.CLOUD
    assert result.prompt_window is not None
    assert result.prompt_window.size == allocator.window_for(ModelTier.CLOUD)


def test_unloader_called_with_active_model_before_load(tmp_path: Path) -> None:
    unloaded: list[ModelInterface] = []
    active = LocalSLM()
    coord = HotSwapCoordinator(
        store=_store(tmp_path),
        allocator=ModelAllocator(),
        loader=_ok_loader(Edge()),
        unloader=unloaded.append,
        clock=_FakeClock(0.0, 1.0),
    )

    coord.trigger(_sample_wrapper(), ModelTier.LOCAL_SLM, active_model=active)

    assert unloaded == [active]


# ── R11.6: already at Cloud — continue running ───────────────────────────────


def test_cloud_continues_running_without_pause(tmp_path: Path) -> None:
    store = _store(tmp_path)
    coord = HotSwapCoordinator(
        store=store,
        allocator=ModelAllocator(),
        loader=_ok_loader(Cloud()),
    )

    state = _sample_wrapper()
    result = coord.trigger(state, ModelTier.CLOUD)

    assert result.kind is HotSwapOutcomeKind.CONTINUED_ON_CLOUD
    assert result.active_tier is ModelTier.CLOUD
    assert result.paused is False  # not paused, not deferred (R11.6)
    assert result.new_tier is None  # no upshift
    # State is still written on the ceiling (R11.1) before the override.
    assert store.load() == state


# ── R11.7: load fails or overruns ────────────────────────────────────────────


def test_failed_load_retains_wrapper_pauses_and_emits_error(tmp_path: Path) -> None:
    store = _store(tmp_path)
    events: list[object] = []

    def failing_loader(tier: ModelTier) -> ModelInterface:
        raise RuntimeError("model unavailable")

    coord = HotSwapCoordinator(
        store=store,
        allocator=ModelAllocator(),
        loader=failing_loader,
        run_id="run-7",
        emit=events.append,
        clock=_FakeClock(0.0, 1.0),
    )

    state = _sample_wrapper()
    result = coord.trigger(state, ModelTier.LOCAL_SLM)

    assert result.kind is HotSwapOutcomeKind.LOAD_FAILED
    assert result.paused is True  # run stays paused
    assert result.failed_tier is ModelTier.EDGE
    # Wrapper retained (never deleted) and unchanged.
    assert store.exists()
    assert store.load() == state
    # An error event naming the failed load was emitted over the bus.
    assert len(events) == 1
    event = events[0]
    assert isinstance(event, CommandEvent)
    assert event.error_tag is not None
    assert ModelTier.EDGE.value in event.error_tag
    assert result.error_event is event


def test_load_exceeding_deadline_is_a_failed_load(tmp_path: Path) -> None:
    store = _store(tmp_path)
    # Loader returns fine, but the measured duration overruns the 30 s deadline.
    coord = HotSwapCoordinator(
        store=store,
        allocator=ModelAllocator(),
        loader=_ok_loader(Edge()),
        clock=_FakeClock(0.0, HOT_SWAP_DEADLINE_SECONDS + 1.0),
    )

    result = coord.trigger(_sample_wrapper(), ModelTier.LOCAL_SLM)

    assert result.kind is HotSwapOutcomeKind.LOAD_FAILED
    assert result.paused is True
    assert result.failed_tier is ModelTier.EDGE


def test_load_at_exactly_deadline_succeeds(tmp_path: Path) -> None:
    coord = HotSwapCoordinator(
        store=_store(tmp_path),
        allocator=ModelAllocator(),
        loader=_ok_loader(Edge()),
        clock=_FakeClock(0.0, HOT_SWAP_DEADLINE_SECONDS),
    )

    result = coord.trigger(_sample_wrapper(), ModelTier.LOCAL_SLM)

    assert result.kind is HotSwapOutcomeKind.UPSHIFTED


# ── tier ladder ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("tier", "expected"),
    [
        (ModelTier.LOCAL_SLM, ModelTier.EDGE),
        (ModelTier.EDGE, ModelTier.CLOUD),
        (ModelTier.CLOUD, None),
    ],
)
def test_next_higher_tier(tier: ModelTier, expected: ModelTier | None) -> None:
    assert next_higher_tier(tier) == expected
