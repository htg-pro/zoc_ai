"""Write-allowlist property for APPLY_EDITS."""

from __future__ import annotations

import tempfile
from pathlib import Path

from hypothesis import given, settings
from hypothesis import strategies as st
from shared_schema.agent_events import ApprovalEvent
from zocai_gateway.context.steering_compiler import MapFilesEvent, preapproved_writes
from zocai_gateway.edits import EditCoordinator, EditPlan, PlannedChange
from zocai_gateway.toolsets import FullToolset


@settings(max_examples=100, deadline=None)
@given(declared=st.lists(st.booleans(), min_size=0, max_size=15))
def test_write_allowlist_admits_declared_and_halts_on_first_undeclared(
    declared: list[bool],
) -> None:
    """Feature: advanced-context-engine, Property 18: write allowlist.

    **Validates: Requirements 16.2, 16.3**
    """
    changes = tuple(
        PlannedChange(path=f"src/file-{index}.txt", content=f"value-{index}")
        for index in range(len(declared))
    )
    allowed_paths = tuple(
        change.path for change, is_declared in zip(changes, declared, strict=True)
        if is_declared
    )
    map_event = MapFilesEvent(read_list=(), write_list=allowed_paths, rationale="")

    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        events: list[object] = []
        coordinator = EditCoordinator(
            toolset=FullToolset(root),
            run_id="property",
            emit=events.append,
            write_allowlist=preapproved_writes(map_event),
        )
        outcome = coordinator.apply_edits(EditPlan(changes=changes))

        first_undeclared = next(
            (index for index, is_declared in enumerate(declared) if not is_declared),
            None,
        )
        prefix_length = len(changes) if first_undeclared is None else first_undeclared
        assert outcome.applied == changes[:prefix_length]

        for index, change in enumerate(changes):
            path = root / change.path
            assert path.exists() is (index < prefix_length)

        approvals = [event for event in events if isinstance(event, ApprovalEvent)]
        if first_undeclared is None:
            assert outcome.ok is True
            assert outcome.pending_approval is None
            assert approvals == []
        else:
            halting = changes[first_undeclared]
            assert outcome.ok is False
            assert outcome.needs_approval is True
            assert outcome.pending_approval == halting
            assert outcome.rejected is False
            assert len(approvals) == 1
            assert halting.path in approvals[0].prompt
            assert approvals[0].decision is None
            assert not (root / halting.path).exists()
