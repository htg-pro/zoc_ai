"""Property test for the ceiling-triggered budget pause (task 5.14).

Feature: zocai-ecosystem-rebuild, Property 20: Budget pause fires exactly at the
ceiling before the next operation.

**Validates: Requirements 4.3, 4.4**

Design Property 20 (verbatim intent): *For any* run, no file operation begins
once the file-iteration counter reaches 20 and no recovery begins once the
error-recovery counter reaches 3; in each case the run pauses and emits a
budget-exceeded event before the next operation.

Strategy
--------
For each generated operation count ``n`` we drive a fresh :class:`Orchestrator`
(wired to a real :class:`~zocai_gateway.toolsets.FullToolset` over an isolated
temporary workspace) by attempting ``n`` gated operations one at a time and
recording, per attempt, whether the run was already paused and whether the
operation succeeded. We then assert the pause fires *exactly* at the ceiling:

- **Not before.** Every one of the first ``min(n, CEILING)`` attempts runs
  (returns success) with the run live, and the cumulative counter advances by
  exactly one per successful op.
- **At the ceiling.** The run is paused *iff* more than ``CEILING`` operations
  were attempted — i.e. the pause is triggered by attempting the
  ``(CEILING + 1)``-th operation, never the ``CEILING``-th.
- **Not after / blocked op not performed.** The operation that triggers the
  pause is blocked before it starts: it returns the blocked sentinel, the
  cumulative counter stays pinned at ``CEILING`` (the blocked op is not
  counted), no side effect occurs (for files, the target is never written),
  and exactly one contract-conforming budget-exceeded ``ApprovalEvent`` is
  emitted.

``n`` is drawn over a band straddling each ceiling (with the boundary values
pinned as explicit examples) so the at-ceiling / before / after partition is
exercised directly. A fresh ``TemporaryDirectory`` per example keeps each
generated workspace isolated.
"""

from __future__ import annotations

import itertools
import tempfile
from pathlib import Path

from hypothesis import HealthCheck, example, given, settings
from hypothesis import strategies as st

from shared_schema.agent_events import AgentEventModel, ApprovalEvent

from zocai_gateway.edits import EditCoordinator, PlannedChange
from zocai_gateway.fsm import FSM
from zocai_gateway.orchestrator import Budget, Orchestrator
from zocai_gateway.stages import Stage
from zocai_gateway.toolsets import FullToolset

_FILE_CEILING = Budget.FILE_CEILING  # 20 (R4.3)
_ERROR_CEILING = Budget.ERROR_CEILING  # 3 (R4.4)


def _make_orchestrator(
    workspace: Path,
) -> tuple[Orchestrator, list[ApprovalEvent]]:
    """A fresh Orchestrator over a confined toolset wired to a recording sink."""
    recorded: list[ApprovalEvent] = []
    seq = itertools.count().__next__
    toolset = FullToolset(workspace_root=workspace)
    fsm = FSM(initial=Stage.READ_FILES, run_id="r1")
    edits = EditCoordinator(toolset=toolset, run_id="r1")
    orch = Orchestrator(
        fsm=fsm,
        edits=edits,
        run_id="r1",
        emit=recorded.append,  # type: ignore[arg-type]
        next_seq=seq,
    )
    return orch, recorded


@given(n=st.integers(min_value=0, max_value=_FILE_CEILING + 5))
@example(n=_FILE_CEILING - 1)
@example(n=_FILE_CEILING)
@example(n=_FILE_CEILING + 1)
@settings(max_examples=120, suppress_health_check=[HealthCheck.too_slow])
def test_file_budget_pause_fires_exactly_at_ceiling(n: int) -> None:
    """Property 20 (file budget): pause fires iff op #(20+1) is attempted (R4.3)."""
    with tempfile.TemporaryDirectory() as tmp:
        workspace = Path(tmp)
        orch, recorded = _make_orchestrator(workspace)

        attempts: list[tuple[int, bool, bool]] = []  # (index, was_paused, succeeded)
        for i in range(n):
            was_paused = orch.is_paused
            if was_paused:
                # Once paused, the gate raises rather than silently running; the
                # pause has already fired, so we stop attempting further ops.
                break
            succeeded = orch.write_file(
                PlannedChange(path=f"f{i}.txt", content=str(i))
            )
            attempts.append((i, was_paused, succeeded))

        expected_success = min(n, _FILE_CEILING)

        # Not before: every attempt up to the ceiling ran live and succeeded.
        for index, was_paused, succeeded in attempts[:expected_success]:
            assert was_paused is False
            assert succeeded is True
            assert (workspace / f"f{index}.txt").read_text(encoding="utf-8") == str(
                index
            )

        # The cumulative counter equals exactly the number of ops performed.
        assert orch.budget.file_iterations == expected_success

        # At the ceiling: paused iff strictly more than CEILING ops were attempted.
        assert orch.is_paused is (n > _FILE_CEILING)

        if n > _FILE_CEILING:
            # The (21st) attempt is the blocked one: index == CEILING.
            index, was_paused, succeeded = attempts[_FILE_CEILING]
            assert index == _FILE_CEILING
            assert was_paused is False  # it triggered the pause, not paused before
            assert succeeded is False  # blocked before it started (R4.3)
            # Not after: the blocked op is not performed and not counted.
            assert not (workspace / f"f{_FILE_CEILING}.txt").exists()
            assert orch.budget.file_iterations == _FILE_CEILING
            # Exactly one contract-conforming budget-exceeded approval emitted.
            assert len(recorded) == 1
            event = recorded[0]
            assert isinstance(event, ApprovalEvent)
            assert "file" in event.prompt and str(_FILE_CEILING) in event.prompt
            AgentEventModel.model_validate(event.model_dump(by_alias=True))
        else:
            # Before the ceiling: never paused, no budget event emitted.
            assert recorded == []


@given(n=st.integers(min_value=0, max_value=_ERROR_CEILING + 5))
@example(n=_ERROR_CEILING - 1)
@example(n=_ERROR_CEILING)
@example(n=_ERROR_CEILING + 1)
@settings(max_examples=120, suppress_health_check=[HealthCheck.too_slow])
def test_error_budget_pause_fires_exactly_at_ceiling(n: int) -> None:
    """Property 20 (error budget): pause fires iff recovery #(3+1) is attempted (R4.4)."""
    with tempfile.TemporaryDirectory() as tmp:
        orch, recorded = _make_orchestrator(Path(tmp))

        attempts: list[tuple[bool, bool]] = []  # (was_paused, succeeded)
        for _ in range(n):
            was_paused = orch.is_paused
            if was_paused:
                break
            succeeded = orch.enter_error_recovery()
            attempts.append((was_paused, succeeded))

        expected_success = min(n, _ERROR_CEILING)

        # Not before: every recovery up to the ceiling ran live and was counted.
        for was_paused, succeeded in attempts[:expected_success]:
            assert was_paused is False
            assert succeeded is True

        assert orch.budget.error_recoveries == expected_success

        # At the ceiling: paused iff strictly more than CEILING recoveries attempted.
        assert orch.is_paused is (n > _ERROR_CEILING)

        if n > _ERROR_CEILING:
            was_paused, succeeded = attempts[_ERROR_CEILING]
            assert was_paused is False  # it triggered the pause
            assert succeeded is False  # blocked before it started (R4.4)
            # Not after: the blocked recovery is not counted.
            assert orch.budget.error_recoveries == _ERROR_CEILING
            assert len(recorded) == 1
            event = recorded[0]
            assert isinstance(event, ApprovalEvent)
            assert "error" in event.prompt and str(_ERROR_CEILING) in event.prompt
            AgentEventModel.model_validate(event.model_dump(by_alias=True))
        else:
            assert recorded == []
