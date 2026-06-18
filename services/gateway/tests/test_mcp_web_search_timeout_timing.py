"""Timing check for the ``mcp::web::search`` worker timeout bound (task 8.14).

R8.4 requires that an ``mcp::web::search`` tool call retrieve its documents
**within a 30-second timeout**, and R8.8 requires that a worker which **exceeds
its 30-second timeout** be **terminated**, yielding an error indication that
names the failed tool with **no partial results**. The production bound is
:data:`WEB_SEARCH_TIMEOUT_SECONDS` (``30.0`` s).

This is a non-functional timing bound, so per the design Testing Strategy
("Performance / Timing Checks") it is verified with a targeted measurement
rather than a property. Waiting a real 30 s per example would make the suite
unusable, so the test drives the gateway with a **small injected timeout** and
a **hung stub worker** that never finishes its fetch. The gateway must cut the
hung worker off **at the injected bound** (not early, not indefinitely), and
the same bound-driven termination is exactly what fires at 30 s in production.

We assert the production bound is 30 s so the constant cannot silently drift,
then measure the terminate-at-bound behavior against several small budgets to
show termination tracks the bound rather than any fixed delay.

The worker is the only host/network seam, so the stub keeps every example
fully in-process with no real network call.

Validates: Requirements 8.4
"""

from __future__ import annotations

import threading
import time
from collections.abc import Sequence

from zocai_gateway.context.mcp_gateway import (
    WEB_SEARCH_TIMEOUT_SECONDS,
    WEB_SEARCH_TOOL,
    MCPError,
    MCPErrorKind,
    MCPGateway,
    RawDocument,
    WorkerTimeout,
)

# Production wall-clock bound for an ``mcp::web::search`` worker (R8.4/R8.8).
_PRODUCTION_BOUND_S = 30.0

# Small budgets used to drive the terminate-at-bound behavior quickly. The
# gateway / worker contract is bound-driven, so verifying termination tracks
# these sub-second budgets demonstrates the identical behavior at the 30 s
# production bound without waiting 30 s per example.
_SMALL_BUDGETS_S = (0.05, 0.1, 0.2)

# Slack above a budget to absorb scheduler/CI jitter while still proving the
# worker was terminated promptly at the bound rather than hanging past it.
_TERMINATION_SLACK_S = 2.0


class _HungWorker:
    """A :class:`WebSearchWorker` stub whose ``fetch`` never finishes.

    Models a worker hung past its budget exactly as the production subprocess
    worker does: ``fetch`` blocks on an event that is never set (the "work"
    never completes) for up to the timeout budget, then raises
    :class:`WorkerTimeout` — mirroring ``subprocess.Popen.communicate(timeout)``
    raising ``TimeoutExpired`` and being converted to ``WorkerTimeout``. The
    gateway is then responsible for terminating it (R8.8).

    Records the wall-clock instant ``terminate`` was called so the test can
    measure that termination happened *at* the bound.
    """

    def __init__(self) -> None:
        # Never set: the worker's "work" never completes, so it stays hung for
        # strictly longer than any finite budget.
        self._never_finishes = threading.Event()
        self.terminated = False
        self.fetch_started_at: float | None = None
        self.terminated_at: float | None = None

    def fetch(self, timeout: float) -> Sequence[RawDocument]:
        self.fetch_started_at = time.perf_counter()
        # Block up to the budget; the event is never set so this always times
        # out, faithfully representing a hung worker that exceeds its bound.
        finished = self._never_finishes.wait(timeout)
        if not finished:
            raise WorkerTimeout(f"worker exceeded the {timeout:g}s timeout")
        # Unreachable: the event is never set. Present only to satisfy typing.
        return ()  # pragma: no cover

    def terminate(self) -> None:
        self.terminated = True
        self.terminated_at = time.perf_counter()


def test_production_web_search_timeout_bound_is_thirty_seconds() -> None:
    """The production ``mcp::web::search`` timeout bound is 30 s (R8.4/R8.8).

    Pins the constant so the bound the timing check stands in for cannot drift.

    Validates: Requirements 8.4
    """
    assert WEB_SEARCH_TIMEOUT_SECONDS == _PRODUCTION_BOUND_S


def _run_hung_search(budget: float) -> tuple[_HungWorker, object, float]:
    """Drive ``web_search`` with a hung worker and the given budget.

    Returns the worker, the outcome, and the measured seconds from the start of
    the call to the worker's termination.
    """
    worker = _HungWorker()
    gateway = MCPGateway(web_search_spawner=lambda query, cap: worker)

    start = time.perf_counter()
    outcome = gateway.web_search("anything", timeout=budget)
    assert worker.terminated_at is not None, "hung worker was never terminated"
    elapsed_to_terminate = worker.terminated_at - start
    return worker, outcome, elapsed_to_terminate


def test_hung_worker_is_terminated_at_the_timeout_bound() -> None:
    """A worker hung past its budget is terminated at the bound (R8.4/R8.8).

    Drives the gateway with a small injected timeout and a worker that never
    finishes. Asserts the hung worker is terminated, the outcome is a TIMEOUT
    ``MCPError`` naming the tool with no partial results, and termination lands
    *at* the bound — no earlier than the budget and no later than the budget
    plus a small jitter slack. The same bound-driven cut-off fires at the 30 s
    production bound.

    Validates: Requirements 8.4
    """
    budget = _SMALL_BUDGETS_S[1]
    worker, outcome, elapsed = _run_hung_search(budget)

    # The hung worker was terminated and released (R8.8).
    assert worker.terminated is True

    # A clean, attributable timeout error with no partial results (R8.8).
    assert isinstance(outcome, MCPError)
    assert outcome.tool == WEB_SEARCH_TOOL
    assert outcome.kind is MCPErrorKind.TIMEOUT
    assert not hasattr(outcome, "documents")

    # Terminated *at* the bound: the worker blocked for the full budget (not
    # cut off early) and was terminated promptly once the bound elapsed.
    assert elapsed >= budget, (
        f"worker was terminated after {elapsed * 1000:.1f} ms, before its "
        f"{budget * 1000:.0f} ms budget elapsed"
    )
    assert elapsed < budget + _TERMINATION_SLACK_S, (
        f"hung worker ran {elapsed * 1000:.1f} ms, past its "
        f"{budget * 1000:.0f} ms budget plus {_TERMINATION_SLACK_S:.0f} s "
        f"slack — it was not terminated promptly at the bound"
    )


def test_termination_tracks_the_injected_bound() -> None:
    """Termination latency tracks the budget, not a fixed delay (R8.4/R8.8).

    Runs the hung worker across several small budgets and asserts each is
    terminated no earlier than its own budget. Because termination tracks the
    injected bound rather than any constant delay, the identical behavior holds
    at the 30 s production bound.

    Validates: Requirements 8.4
    """
    for budget in _SMALL_BUDGETS_S:
        worker, outcome, elapsed = _run_hung_search(budget)

        assert worker.terminated is True
        assert isinstance(outcome, MCPError)
        assert outcome.kind is MCPErrorKind.TIMEOUT
        assert elapsed >= budget, (
            f"for a {budget * 1000:.0f} ms budget the worker was terminated "
            f"after only {elapsed * 1000:.1f} ms"
        )
        assert elapsed < budget + _TERMINATION_SLACK_S, (
            f"for a {budget * 1000:.0f} ms budget the worker ran "
            f"{elapsed * 1000:.1f} ms, past the bound plus slack"
        )
