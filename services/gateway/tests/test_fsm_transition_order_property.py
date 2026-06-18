"""Property test for the 9-stage Agent-Mode FSM transition table and order (task 5.6).

Feature: zocai-ecosystem-rebuild, Property 12: FSM transitions follow the legal
table in canonical order.

**Validates: Requirements 3.2**

Design Property 12 (verbatim intent): *For any* Agent-Mode run, every observed
stage transition is a member of the legal transition table, and a successful run
advances stages in the exact canonical order without skipping or reordering.

Strategy
--------
Two complementary properties exercise the real :class:`FSM` against the real
:data:`LEGAL` table (no mocks):

* **Legality over the full domain.** For every ordered ``(source, target)`` pair
  drawn from the complete :class:`Stage` domain we construct an FSM at ``source``
  and attempt :meth:`FSM.transition_to`. The move is accepted *iff* ``target`` is
  present in ``LEGAL[source]`` (current advances to ``target``); otherwise it
  raises :class:`IllegalTransitionError` and leaves the FSM parked at ``source``.
  This proves only legal-table edges are constructable (R3.2).

* **Canonical order of a successful run.** We drive a successful run from
  ``INTAKE`` to ``DONE`` and, at every stage along the way, inject a randomized
  batch of illegal jump attempts that must all be rejected without disturbing
  state. The surviving forward steps must equal the exact canonical order
  ``INTAKE → ANALYZE → MAP_FILES → READ_FILES → PLAN_EDITS → APPLY_EDITS →
  RUN_CHECKS → SUMMARY → DONE`` with no skipping or reordering (R3.2), and every
  consecutive pair must be a legal-table edge.
"""

from __future__ import annotations

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from zocai_gateway.fsm import (
    LEGAL,
    FSM,
    IllegalTransitionError,
)
from zocai_gateway.stages import Stage

# The complete stage domain — every move is drawn from here so legality is
# verified across the whole space, not just the happy-path neighbours.
ALL_STAGES = list(Stage)

# The canonical happy-path order fixed by R3.2.
CANONICAL_ORDER = [
    Stage.INTAKE,
    Stage.ANALYZE,
    Stage.MAP_FILES,
    Stage.READ_FILES,
    Stage.PLAN_EDITS,
    Stage.APPLY_EDITS,
    Stage.RUN_CHECKS,
    Stage.SUMMARY,
    Stage.DONE,
]


@settings(max_examples=300)
@given(source=st.sampled_from(ALL_STAGES), target=st.sampled_from(ALL_STAGES))
def test_transition_accepted_iff_present_in_legal_table(
    source: Stage,
    target: Stage,
) -> None:
    """Property 12: a transition is accepted exactly when it is in the legal table.

    Feature: zocai-ecosystem-rebuild, Property 12

    **Validates: Requirements 3.2**
    """
    fsm = FSM(initial=source)
    is_legal = target in LEGAL.get(source, set())

    if is_legal:
        assert fsm.transition_to(target) is target
        assert fsm.current is target
    else:
        with pytest.raises(IllegalTransitionError):
            fsm.transition_to(target)
        # An illegal attempt must not move the FSM off its current stage.
        assert fsm.current is source


@settings(max_examples=300)
@given(data=st.data())
def test_successful_run_advances_in_canonical_order(data: st.DataObject) -> None:
    """Property 12: a successful run follows the exact canonical order.

    At each stage we throw randomized illegal jump attempts at the FSM; every one
    must raise :class:`IllegalTransitionError` and leave the stage unchanged. The
    forward progress that survives must reproduce the canonical order with no
    skip or reorder, and each step taken must be a member of the legal table.

    Feature: zocai-ecosystem-rebuild, Property 12

    **Validates: Requirements 3.2**
    """
    fsm = FSM(initial=Stage.INTAKE)
    visited = [Stage.INTAKE]

    while fsm.current is not Stage.DONE:
        here = fsm.current
        legal_here = LEGAL.get(here, set())

        # Inject a randomized batch of illegal jump attempts from this stage.
        for _ in range(data.draw(st.integers(min_value=0, max_value=3))):
            bogus = data.draw(st.sampled_from(ALL_STAGES))
            if bogus in legal_here:
                continue  # not an illegal move; skip
            with pytest.raises(IllegalTransitionError):
                fsm.transition_to(bogus)
            assert fsm.current is here  # rejected, state preserved

        # Take the single canonical forward step toward DONE.
        nxt = CANONICAL_ORDER[len(visited)]
        assert nxt in legal_here  # the forward step is a legal-table edge
        assert fsm.transition_to(nxt) is nxt
        visited.append(nxt)

    # The successful run reproduced the canonical order exactly — no skip/reorder.
    assert visited == CANONICAL_ORDER
    # And every consecutive pair is a member of the legal transition table.
    for a, b in zip(visited, visited[1:]):
        assert b in LEGAL[a]
    assert fsm.is_terminal is True
