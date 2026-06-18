"""Property test for the empty-plan skip of the Agent-Mode FSM (task 5.10).

Feature: zocai-ecosystem-rebuild, Property 16: Empty plan skips application.

**Validates: Requirements 3.8**

Design Property 16 (verbatim intent): *For any* empty edit plan, the FSM skips
file modification and transitions directly to RUN_CHECKS.

Strategy
--------
The behavior splits across two real collaborators (no mocks):

* :meth:`zocai_gateway.fsm.FSM.plan_complete` owns the branch out of
  ``PLAN_EDITS``. We assert the *iff* shape over arbitrary plans: an **empty**
  plan (``has_changes=False``) skips ``APPLY_EDITS`` and lands directly on
  ``RUN_CHECKS`` (R3.8), while a **non-empty** plan (``has_changes=True``)
  routes through ``APPLY_EDITS``. ``EditPlan.has_changes`` is derived from the
  generated changes, so the branch decision is driven by real plan data.

* :meth:`zocai_gateway.edits.EditCoordinator.apply_edits` over an **empty**
  plan must perform no workspace writes and emit no ``edit-file`` events — the
  "skips file modification" half of R3.8. We run it against a real
  :class:`~zocai_gateway.toolsets.FullToolset` over a fresh temp workspace and
  assert the workspace is untouched and no :class:`EditFileEvent` reached the
  sink.

Both properties run well beyond the 100-example floor.
"""

from __future__ import annotations

import itertools
import tempfile
from pathlib import Path

from hypothesis import given, settings
from hypothesis import strategies as st
from shared_schema.agent_events import EditFileEvent
from shared_schema.agent_events import AgentEvent as AgentEventUnion

from zocai_gateway.edits import EditCoordinator, EditPlan, PlannedChange
from zocai_gateway.fsm import FSM
from zocai_gateway.stages import Stage
from zocai_gateway.toolsets import FullToolset

# ── Generators ──────────────────────────────────────────────────────────────

# Reasoning text is free-form; an empty plan may still carry rationale (R3.6).
_reasoning = st.text(max_size=40)

# Safe relative file names confined to the workspace root (R3.5). Restricting
# to a small alphabet keeps every generated path a valid, in-workspace file.
_filenames = st.text(
    alphabet=st.characters(whitelist_categories=("Ll", "Lu", "Nd")),
    min_size=1,
    max_size=12,
)


@st.composite
def _planned_changes(draw: st.DrawFn) -> tuple[PlannedChange, ...]:
    """A non-empty tuple of changes with distinct in-workspace paths."""
    names = draw(
        st.lists(_filenames, min_size=1, max_size=4, unique=True)
    )
    return tuple(
        PlannedChange(path=f"{name}.txt", content=draw(st.text(max_size=20)))
        for name in names
    )


_empty_plans = st.builds(EditPlan, reasoning=_reasoning, changes=st.just(()))
_non_empty_plans = st.builds(
    EditPlan, reasoning=_reasoning, changes=_planned_changes()
)


# ── Property 16: the FSM branch ──────────────────────────────────────────────


@settings(max_examples=200)
@given(plan=st.one_of(_empty_plans, _non_empty_plans))
def test_empty_plan_skips_to_run_checks_else_apply_edits(plan: EditPlan) -> None:
    """Property 16: empty plans skip to RUN_CHECKS; non-empty go to APPLY_EDITS.

    Feature: zocai-ecosystem-rebuild, Property 16

    **Validates: Requirements 3.8**
    """
    fsm = FSM(initial=Stage.PLAN_EDITS)
    landed = fsm.plan_complete(has_changes=plan.has_changes)

    if plan.has_changes:
        # A non-empty plan routes through file modification.
        assert landed is Stage.APPLY_EDITS
    else:
        # An empty plan skips APPLY_EDITS entirely and lands on RUN_CHECKS.
        assert landed is Stage.RUN_CHECKS
    assert fsm.current is landed


# ── Property 16: empty plan performs no file modification ─────────────────────


@settings(max_examples=200, deadline=None)
@given(plan=_empty_plans)
def test_empty_plan_writes_nothing_and_emits_no_edit_file_events(
    plan: EditPlan,
) -> None:
    """Property 16: applying an empty plan touches no file and emits no edit event.

    The "skips file modification" half of R3.8: a real ``EditCoordinator`` over
    a fresh workspace applies the empty plan and must leave the workspace
    exactly as it found it (no files created) and emit no ``edit-file`` event.

    Feature: zocai-ecosystem-rebuild, Property 16

    **Validates: Requirements 3.8**
    """
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        recorded: list[AgentEventUnion] = []
        coord = EditCoordinator(
            toolset=FullToolset(workspace_root=root),
            run_id="r1",
            emit=recorded.append,
            next_seq=itertools.count().__next__,
        )

        before = sorted(p.name for p in root.iterdir())
        outcome = coord.apply_edits(plan)
        after = sorted(p.name for p in root.iterdir())

        # No write occurred: the workspace is byte-for-byte unchanged.
        assert after == before == []
        # The outcome is a clean no-op.
        assert outcome.ok is True
        assert outcome.applied == ()
        # No edit-file event was emitted (to the sink or the recorded log).
        assert not any(isinstance(e, EditFileEvent) for e in recorded)
        assert not any(isinstance(e, EditFileEvent) for e in coord.events)
