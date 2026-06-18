"""Timing check for ``Model_Allocator`` tier selection latency (R1.2).

R1.2 requires the ``Model_Allocator`` to select exactly one Model_Tier *within
500 milliseconds*. This is a non-functional performance bound, so per the
design Testing Strategy ("Performance / Timing Checks") it is verified with a
targeted measurement rather than a property: we exercise ``select()`` across a
representative spread of inputs — every selection path (Cloud, Edge, Local SLM,
and the R1.6 ``None`` fallback) — and assert each call completes well within the
500 ms budget.

Tier selection is pure in-memory scoring with no I/O, so it should finish in
well under a millisecond. We measure with a monotonic clock and assert against
a conservative fraction of the budget so a CI machine under load still passes
while a genuine regression that approaches 500 ms is caught.

Validates: Requirements 1.2
"""

from __future__ import annotations

import time

from zocai_gateway.hardware_probe import HardwareProfile
from zocai_gateway.model_allocator import ModelAllocator

# R1.2's hard ceiling, in seconds.
_BUDGET_S = 0.5
# Conservative pass threshold: tier selection is pure scoring and should be
# orders of magnitude faster than the budget. We assert each call stays under a
# small fraction of the ceiling, leaving generous headroom for a loaded CI host
# while still flagging a regression that creeps toward 500 ms.
_THRESHOLD_S = _BUDGET_S / 10.0  # 50 ms

# Representative inputs spanning every selection path:
#   * high complexity + low latency + fat memory   -> Cloud
#   * mid complexity + low latency + 8+ GB memory   -> Edge
#   * low complexity                                -> Local SLM
#   * thin memory / high latency                    -> Local SLM
#   * unmeasured latency / absent hardware (None)   -> R1.6 fallback
_REPRESENTATIVE_INPUTS = [
    (0.95, 20.0, HardwareProfile(gpu_memory_gb=48.0, system_memory_gb=128.0)),
    (0.5, 50.0, HardwareProfile(gpu_memory_gb=12.0, system_memory_gb=32.0)),
    (0.1, 30.0, HardwareProfile(gpu_memory_gb=2.0, system_memory_gb=4.0)),
    (0.9, 5_000.0, HardwareProfile(gpu_memory_gb=48.0, system_memory_gb=128.0)),
    (0.7, 25.0, HardwareProfile(gpu_memory_gb=1.0, system_memory_gb=2.0)),
    (0.5, None, HardwareProfile(gpu_memory_gb=16.0, system_memory_gb=64.0)),
    (0.5, 40.0, None),
    (0.0, 0.0, HardwareProfile(gpu_memory_gb=0.0, system_memory_gb=0.0)),
]


def test_tier_selection_within_budget_per_input() -> None:
    """Each representative ``select()`` call completes within the 500 ms budget.

    Measures a single selection per representative input and asserts it lands
    under a conservative fraction of the R1.2 ceiling, confirming the bound
    holds across every selection path.

    Validates: Requirements 1.2
    """
    allocator = ModelAllocator()
    for complexity, latency_ms, hw in _REPRESENTATIVE_INPUTS:
        start = time.perf_counter()
        allocator.select(complexity=complexity, latency_ms=latency_ms, hw=hw)
        elapsed = time.perf_counter() - start
        assert elapsed < _BUDGET_S, (
            f"select(complexity={complexity}, latency_ms={latency_ms}, hw={hw}) "
            f"took {elapsed * 1000:.3f} ms, exceeding the {_BUDGET_S * 1000:.0f} ms budget"
        )
        assert elapsed < _THRESHOLD_S, (
            f"select(complexity={complexity}, latency_ms={latency_ms}, hw={hw}) "
            f"took {elapsed * 1000:.3f} ms, exceeding the {_THRESHOLD_S * 1000:.0f} ms "
            "timing-check threshold"
        )


def test_tier_selection_sustained_average_within_budget() -> None:
    """Sustained tier selection stays comfortably within the 500 ms budget.

    Runs many selections across the representative inputs and asserts both the
    worst single call and the average remain far below the R1.2 ceiling, so a
    cold first call cannot mask a steady-state regression.

    Validates: Requirements 1.2
    """
    allocator = ModelAllocator()
    iterations = 1_000
    worst = 0.0
    total = 0.0
    count = 0
    for _ in range(iterations):
        for complexity, latency_ms, hw in _REPRESENTATIVE_INPUTS:
            start = time.perf_counter()
            allocator.select(complexity=complexity, latency_ms=latency_ms, hw=hw)
            elapsed = time.perf_counter() - start
            worst = max(worst, elapsed)
            total += elapsed
            count += 1

    average = total / count
    assert worst < _BUDGET_S, (
        f"worst tier selection took {worst * 1000:.3f} ms, exceeding the "
        f"{_BUDGET_S * 1000:.0f} ms budget"
    )
    assert average < _THRESHOLD_S, (
        f"average tier selection took {average * 1000:.3f} ms, exceeding the "
        f"{_THRESHOLD_S * 1000:.0f} ms timing-check threshold"
    )
