"""Timing check for the hot-swap model load deadline (R11.2).

R11.2 requires the Orchestrator to unload the active model and load the next
higher ``Model_Tier`` *within 30 seconds*. R11.7 makes the consequence explicit:
a load that fails *or exceeds 30 seconds* retains the State_Wrapper, keeps the
run paused, and emits an error event naming the failed load.

This is a non-functional performance bound, so per the design Testing Strategy
("Performance / Timing Checks") it is verified with a targeted measurement of
the deadline branch rather than a property. Crucially, we do **not** wait 30
real seconds: :class:`~zocai_gateway.hot_swap.HotSwapCoordinator` measures the
load against an *injected clock*, so we drive the elapsed duration
deterministically by queueing the start/end readings the coordinator takes
around the load. This lets us pin the exact behaviour at, just under, and just
over the 30 s boundary in microseconds of test time.

The bound under test:
    * elapsed load duration ``<= 30.0 s``  -> the load is in time -> ``UPSHIFTED``
      (the run resumes, not paused).
    * elapsed load duration ``>  30.0 s``  -> the load overran -> ``LOAD_FAILED``
      (the wrapper is retained and the run stays paused).

The boundary is inclusive: a load measured at *exactly* 30.0 s succeeds; the
first failing duration is anything strictly greater. The deadline is the
production constant :data:`~zocai_gateway.hot_swap.HOT_SWAP_DEADLINE_SECONDS`,
which this check also pins to ``30.0`` so a change to the ceiling can never
silently pass.

Validates: Requirements 11.2
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pytest
from zocai_gateway.hot_swap import (
    HOT_SWAP_DEADLINE_SECONDS,
    HotSwapCoordinator,
    HotSwapOutcomeKind,
)
from zocai_gateway.memory.state_wrapper import (
    Diff,
    FailureRecord,
    StateWrapper,
    StateWrapperStore,
)
from zocai_gateway.model_allocator import ModelAllocator
from zocai_gateway.model_interface import Edge, ModelInterface, ModelTier
from zocai_gateway.stages import Stage

#: The contractual ceiling on the unload+load step from R11.2, in seconds.
_DEADLINE_S = 30.0


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
    """A clock returning queued readings on successive calls.

    The coordinator reads the clock once before the load (``start``) and once
    after (``end``); the measured duration is ``end - start``. Queueing those
    two readings lets us simulate any load duration without real waiting.
    """

    def __init__(self, *values: float) -> None:
        self._values = list(values)

    def __call__(self) -> float:
        return self._values.pop(0)


def _ok_loader(model: ModelInterface) -> Callable[[ModelTier], ModelInterface]:
    def loader(tier: ModelTier) -> ModelInterface:
        return model

    return loader


def _trigger_with_duration(tmp_path: Path, duration_s: float) -> HotSwapOutcomeKind:
    """Run one hot-swap whose load takes exactly ``duration_s`` (injected clock)."""
    coord = HotSwapCoordinator(
        store=_store(tmp_path),
        allocator=ModelAllocator(),
        loader=_ok_loader(Edge()),
        # start at 0.0, end at duration_s -> measured load == duration_s.
        clock=_FakeClock(0.0, duration_s),
    )
    result = coord.trigger(_sample_wrapper(), ModelTier.LOCAL_SLM)
    return result.kind


def test_production_deadline_constant_is_30_seconds() -> None:
    """The shipped deadline is pinned to 30.0 s so the R11.2 bound can't drift.

    Validates: Requirements 11.2
    """
    assert HOT_SWAP_DEADLINE_SECONDS == _DEADLINE_S


@pytest.mark.parametrize(
    "duration_s",
    [
        0.0,  # instantaneous load
        1.0,
        15.0,
        _DEADLINE_S - 0.001,  # a hair under the ceiling
        _DEADLINE_S,  # exactly the ceiling — inclusive, still in time
    ],
)
def test_load_within_deadline_upshifts(tmp_path: Path, duration_s: float) -> None:
    """A load measured at or under 30 s is in time: the run upshifts, not paused.

    Validates: Requirements 11.2
    """
    kind = _trigger_with_duration(tmp_path, duration_s)
    assert kind is HotSwapOutcomeKind.UPSHIFTED, (
        f"a {duration_s:.3f} s load is within the {_DEADLINE_S:.0f} s deadline and "
        "must upshift"
    )


@pytest.mark.parametrize(
    "duration_s",
    [
        _DEADLINE_S + 0.001,  # just over the ceiling — first failing duration
        _DEADLINE_S + 1.0,
        45.0,
        120.0,
    ],
)
def test_load_exceeding_deadline_is_a_failed_load(tmp_path: Path, duration_s: float) -> None:
    """A load measured over 30 s overran: it's a failed load and the run stays paused.

    Validates: Requirements 11.2
    """
    coord = HotSwapCoordinator(
        store=_store(tmp_path),
        allocator=ModelAllocator(),
        loader=_ok_loader(Edge()),
        clock=_FakeClock(0.0, duration_s),
    )
    result = coord.trigger(_sample_wrapper(), ModelTier.LOCAL_SLM)

    assert result.kind is HotSwapOutcomeKind.LOAD_FAILED, (
        f"a {duration_s:.3f} s load overruns the {_DEADLINE_S:.0f} s deadline and "
        "must be treated as a failed load"
    )
    assert result.paused is True
