"""Property test for exact-plan application during APPLY_EDITS (task 5.9).

Feature: zocai-ecosystem-rebuild, Property 15: APPLY_EDITS applies exactly the
planned changes.

**Validates: Requirements 3.7**

Design Property 15 (verbatim intent): *For any* edit plan, the set of changes
applied during APPLY_EDITS equals the set of changes in that plan; no change
absent from the plan is applied.

Strategy
--------
We drive :meth:`EditCoordinator.apply_edits` over a :class:`FullToolset`
confined to a fresh temporary workspace and assert the materialized state is
*exactly* the plan and nothing more:

- every planned path exists with its planned content (the set applied ⊇ plan);
- no file exists outside the planned set (the set applied ⊆ plan), so no change
  absent from the plan is applied;
- exactly one contract-conforming ``edit-file`` event is emitted per applied
  change, in plan order.

Plans are generated as lists of :class:`PlannedChange` over Hypothesis-built
*safe* workspace-relative paths that are mutually conflict-free (no path is an
ancestor directory of another, and all paths are unique), so a clean,
fully-successful apply is the case under test. A fresh ``TemporaryDirectory``
per example keeps each generated workspace isolated.
"""

from __future__ import annotations

import itertools
import tempfile
from pathlib import Path

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from shared_schema.agent_events import AgentEvent as AgentEventUnion
from shared_schema.agent_events import AgentEventModel, EditFileEvent

from zocai_gateway.edits import EditCoordinator, EditPlan, PlannedChange
from zocai_gateway.toolsets import FullToolset

# Safe path segments: never "." / ".." / empty, so a path stays a real,
# in-workspace relative location.
_segment = st.text(
    alphabet="abcdefghijklmnopqrstuvwxyz0123456789_-", min_size=1, max_size=8
)


def _is_ancestor(a: tuple[str, ...], b: tuple[str, ...]) -> bool:
    """Whether path ``a`` is an ancestor *directory* of path ``b``.

    A planned file at ``a`` would clash with a planned file under ``a`` (a file
    cannot also be a directory), so such pairs are excluded from a plan.
    """
    return len(a) < len(b) and b[: len(a)] == a


@st.composite
def _plans(draw: st.DrawFn) -> EditPlan:
    """An ``EditPlan`` of conflict-free, unique-path planned changes."""
    raw_paths = draw(
        st.lists(
            st.lists(_segment, min_size=1, max_size=3),
            min_size=0,
            max_size=6,
        )
    )

    accepted: list[tuple[str, ...]] = []
    for segs in raw_paths:
        candidate = tuple(segs)
        if any(
            candidate == other
            or _is_ancestor(candidate, other)
            or _is_ancestor(other, candidate)
            for other in accepted
        ):
            continue
        accepted.append(candidate)

    changes = tuple(
        PlannedChange(
            path="/".join(segs),
            content=draw(st.text(max_size=64)),
            diff=draw(st.text(max_size=32)),
        )
        for segs in accepted
    )
    return EditPlan(reasoning=draw(st.text(max_size=32)), changes=changes)


def _snapshot(root: Path) -> dict[str, str]:
    """Map every file under ``root`` to its content (recursive).

    Reads via :meth:`Path.read_bytes` and decodes explicitly so the comparison
    is byte-faithful: it is unaffected by text-mode universal-newline
    translation (which would fold a written ``\\r`` into ``\\n`` on read) and
    therefore reflects exactly what APPLY_EDITS persisted.
    """
    return {
        path.relative_to(root).as_posix(): path.read_bytes().decode("utf-8")
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


@given(plan=_plans())
@settings(max_examples=150, suppress_health_check=[HealthCheck.too_slow])
def test_apply_edits_applies_exactly_the_planned_changes(plan: EditPlan) -> None:
    """Property 15 (R3.7): APPLY_EDITS materializes exactly the plan.

    Feature: zocai-ecosystem-rebuild, Property 15

    **Validates: Requirements 3.7**
    """
    recorded: list[AgentEventUnion] = []
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        coord = EditCoordinator(
            toolset=FullToolset(workspace_root=root),
            run_id="r1",
            emit=recorded.append,
            next_seq=itertools.count().__next__,
        )

        outcome = coord.apply_edits(plan)

        # A conflict-free plan applies cleanly: every planned change succeeds.
        assert outcome.ok is True
        assert outcome.failed is None
        assert outcome.applied == plan.changes

        # The materialized workspace is EXACTLY the plan: the set of files on
        # disk equals the planned set, with planned content and nothing else
        # (R3.7 — no change absent from the plan is applied).
        expected = {change.path: change.content for change in plan.changes}
        assert _snapshot(root) == expected

        # Exactly one edit-file event per applied change, in plan order, each
        # conforming to the Event_Contract.
        edit_events = [e for e in recorded if isinstance(e, EditFileEvent)]
        assert [e.path for e in edit_events] == [c.path for c in plan.changes]
        for event in edit_events:
            AgentEventModel.model_validate(event.model_dump(by_alias=True))
