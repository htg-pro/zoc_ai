"""Property test for budget counter correctness (task 5.13).

Feature: zocai-ecosystem-rebuild, Property 19: Budget counters equal the number
of corresponding operations.

**Validates: Requirements 4.1, 4.2, 5.2**

Design Property 19 (verbatim intent): *For any* sequence of operations within a
run, the file-iteration counter equals the number of file read/write operations
performed, and the error-recovery counter equals the number of entries into the
HANDLE_ERROR stage.

Strategy
--------
We drive a real :class:`Orchestrator` (composed over a :class:`FullToolset`
confined to a fresh temporary workspace, plus an :class:`FSM` and an
:class:`EditCoordinator`) over a Hypothesis-generated sequence of operations,
each one of:

- ``read``  — a gated workspace read (R4.1),
- ``write`` — a gated workspace write (R4.1),
- ``error`` — an entry into the error-remediation loop (R4.2 / R5.2).

The generated sequences are allowed to run past the 20 file-iteration and 3
error-recovery ceilings; whenever an operation is blocked because a ceiling was
reached the run pauses, and we confirm continuation (granting a fresh window)
and retry, so the operation is ultimately *performed*. We independently count
how many read/write operations and how many error-recovery entries were
actually performed and assert the cumulative counters equal those counts
exactly — confirmation grants a window without ever un-counting prior work, so
the counters stay faithful to the operations performed.

A fresh ``TemporaryDirectory`` per example keeps each generated workspace
isolated.
"""

from __future__ import annotations

import itertools
import tempfile
from pathlib import Path

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from shared_schema.agent_events import ApprovalEvent

from zocai_gateway.edits import EditCoordinator, PlannedChange
from zocai_gateway.fsm import FSM
from zocai_gateway.orchestrator import Orchestrator
from zocai_gateway.stages import Stage
from zocai_gateway.toolsets import FullToolset

# The three operation kinds the budget counts: reads and writes both increment
# file_iterations (R4.1); error entries increment error_recoveries (R4.2/R5.2).
_OPS = ("read", "write", "error")

# Sequences long enough to push past the 20 file / 3 error ceilings, so the
# confirm-and-continue path is exercised alongside within-ceiling runs.
_sequences = st.lists(st.sampled_from(_OPS), min_size=0, max_size=60)


@given(ops=_sequences)
@settings(max_examples=150, suppress_health_check=[HealthCheck.too_slow])
def test_budget_counters_equal_operations_performed(ops: list[str]) -> None:
    """Property 19 (R4.1, R4.2, R5.2): counters == operations performed.

    Feature: zocai-ecosystem-rebuild, Property 19

    **Validates: Requirements 4.1, 4.2, 5.2**
    """
    recorded: list[ApprovalEvent] = []
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        # A pre-seeded file so gated reads resolve to real content.
        (root / "seed.txt").write_text("seed", encoding="utf-8")

        toolset = FullToolset(workspace_root=root)
        orch = Orchestrator(
            fsm=FSM(initial=Stage.READ_FILES, run_id="r1"),
            edits=EditCoordinator(toolset=toolset, run_id="r1"),
            run_id="r1",
            emit=recorded.append,  # type: ignore[arg-type]
            next_seq=itertools.count().__next__,
        )

        expected_file_ops = 0
        expected_recoveries = 0
        write_seq = itertools.count()

        for op in ops:
            if op == "read":
                # Retry once after confirming continuation if a ceiling paused
                # the run before this read could start (R4.3 / R4.6).
                if orch.read_file("seed.txt") is None:
                    orch.confirm_continue()
                    assert orch.read_file("seed.txt") is not None
                expected_file_ops += 1
            elif op == "write":
                change = PlannedChange(
                    path=f"w{next(write_seq)}.txt", content="x", diff="+x"
                )
                if orch.write_file(change) is False:
                    orch.confirm_continue()
                    assert orch.write_file(change) is True
                expected_file_ops += 1
            else:  # "error"
                if orch.enter_error_recovery() is False:
                    orch.confirm_continue()
                    assert orch.enter_error_recovery() is True
                expected_recoveries += 1

        # The run was resumed after every pause, so it ends live.
        assert orch.is_paused is False

        # Property 19: the cumulative file-iteration counter equals the number
        # of read/write operations performed (R4.1), and the error-recovery
        # counter equals the number of HANDLE_ERROR entries performed
        # (R4.2 / R5.2).
        assert orch.budget.file_iterations == expected_file_ops
        assert orch.budget.error_recoveries == expected_recoveries
