"""Unit tests for PLAN_EDITS / APPLY_EDITS behavior (task 5.3).

These example-based tests pin the behavior task 5.3 owns:

- PLAN_EDITS emits a collapsible ``thinking`` event carrying the edit
  reasoning (R3.6);
- APPLY_EDITS applies exactly the planned changes and nothing else (R3.7);
- an empty plan applies nothing (R3.8 — the skip transition itself is the
  FSM's, exercised in ``test_fsm.py``);
- an apply failure halts the stage, retains already-applied changes, and emits
  an error event naming the failed change (R3.9).

The dedicated property tests (Property 14, 15, 16, 17) live in tasks 5.8-5.11.
"""

from __future__ import annotations

import itertools
from pathlib import Path

from shared_schema.agent_events import (
    AgentEventModel,
    CommandEvent,
    EditFileEvent,
    ThinkingEvent,
)
from shared_schema.agent_events import (
    AgentEvent as AgentEventUnion,
)

from zocai_gateway.edits import EditCoordinator, EditPlan, PlannedChange
from zocai_gateway.toolsets import FullToolset


def make_coordinator(tmp_path: Path) -> tuple[EditCoordinator, list[AgentEventUnion]]:
    """An EditCoordinator over a workspace toolset wired to a recording sink."""
    recorded: list[AgentEventUnion] = []
    seq = itertools.count().__next__
    coord = EditCoordinator(
        toolset=FullToolset(workspace_root=tmp_path),
        run_id="r1",
        emit=recorded.append,
        next_seq=seq,
    )
    return coord, recorded


# -- PLAN_EDITS emits a collapsible thinking event (R3.6) --------------------


def test_plan_edits_emits_collapsible_thinking_event(tmp_path: Path) -> None:
    coord, recorded = make_coordinator(tmp_path)
    event = coord.plan_edits(EditPlan(reasoning="rewrite the parser for clarity"))
    assert isinstance(event, ThinkingEvent)
    assert event.collapsible is True
    assert event.text == "rewrite the parser for clarity"
    assert recorded == [event]
    # Conforms to the Event_Contract (R3.6 / R6.2).
    AgentEventModel.model_validate(event.model_dump(by_alias=True))


# -- APPLY_EDITS applies exactly the planned changes and nothing else (R3.7) -


def test_apply_edits_writes_exactly_the_planned_changes(tmp_path: Path) -> None:
    coord, recorded = make_coordinator(tmp_path)
    plan = EditPlan(
        reasoning="add two files",
        changes=(
            PlannedChange(path="a.txt", content="alpha", diff="+alpha"),
            PlannedChange(path="sub/b.txt", content="beta", diff="+beta"),
        ),
    )
    outcome = coord.apply_edits(plan)

    assert outcome.ok is True
    assert outcome.failed is None
    assert outcome.applied == plan.changes
    # Exactly the planned files exist with the planned content (R3.7).
    assert (tmp_path / "a.txt").read_text(encoding="utf-8") == "alpha"
    assert (tmp_path / "sub" / "b.txt").read_text(encoding="utf-8") == "beta"
    # One edit-file event per applied change, in order.
    edit_events = [e for e in recorded if isinstance(e, EditFileEvent)]
    assert [e.path for e in edit_events] == ["a.txt", "sub/b.txt"]
    for e in edit_events:
        AgentEventModel.model_validate(e.model_dump(by_alias=True))


def test_apply_edits_does_not_write_paths_outside_the_plan(tmp_path: Path) -> None:
    coord, _ = make_coordinator(tmp_path)
    plan = EditPlan(changes=(PlannedChange(path="only.txt", content="x"),))
    coord.apply_edits(plan)
    # The workspace contains exactly the single planned file (R3.7).
    written = [p.name for p in tmp_path.iterdir()]
    assert written == ["only.txt"]


# -- empty plan applies nothing (R3.8) ---------------------------------------


def test_empty_plan_applies_nothing(tmp_path: Path) -> None:
    coord, recorded = make_coordinator(tmp_path)
    outcome = coord.apply_edits(EditPlan(reasoning="no changes needed"))
    assert outcome.ok is True
    assert outcome.applied == ()
    # No edit-file events and no files written for an empty plan (R3.8).
    assert [e for e in recorded if isinstance(e, EditFileEvent)] == []
    assert list(tmp_path.iterdir()) == []


# -- apply failure halts, retains applied changes, names the failed change (R3.9)


def test_apply_failure_retains_prior_changes_and_reports_failed_change(
    tmp_path: Path,
) -> None:
    coord, recorded = make_coordinator(tmp_path)
    # The middle change escapes the workspace -> ReadOnlyViolation on write.
    plan = EditPlan(
        reasoning="three changes, the second is out of bounds",
        changes=(
            PlannedChange(path="first.txt", content="one"),
            PlannedChange(path="../escape.txt", content="boom"),
            PlannedChange(path="third.txt", content="three"),
        ),
    )
    outcome = coord.apply_edits(plan)

    # Halted on the failing change; later changes are NOT attempted (R3.9).
    assert outcome.ok is False
    assert outcome.failed == plan.changes[1]
    assert outcome.error is not None and "escape.txt" in outcome.error
    # Already-applied change is retained, both in the outcome and on disk.
    assert outcome.applied == (plan.changes[0],)
    assert (tmp_path / "first.txt").read_text(encoding="utf-8") == "one"
    assert not (tmp_path / "third.txt").exists()
    # An error event naming the failed change was emitted last (R3.9).
    error_events = [e for e in recorded if isinstance(e, CommandEvent)]
    assert len(error_events) == 1
    err = error_events[0]
    assert err.command == "apply-edit:../escape.txt"
    assert err.error_tag is not None and "escape.txt" in err.error_tag
    AgentEventModel.model_validate(err.model_dump(by_alias=True))
    # The retained edit-file event for the first change is still on the stream.
    edit_events = [e for e in recorded if isinstance(e, EditFileEvent)]
    assert [e.path for e in edit_events] == ["first.txt"]


def test_emitted_events_share_one_monotonic_sequence(tmp_path: Path) -> None:
    coord, recorded = make_coordinator(tmp_path)
    coord.plan_edits(EditPlan(reasoning="r"))
    coord.apply_edits(
        EditPlan(changes=(PlannedChange(path="x.txt", content="x"),))
    )
    seqs = [e.seq for e in recorded]
    assert seqs == list(range(len(recorded)))
