"""Property test for the PLAN_EDITS collapsible thinking event (task 5.8).

Feature: zocai-ecosystem-rebuild, Property 14: PLAN_EDITS emits a collapsible
thinking event.

**Validates: Requirements 3.6**

Design Property 14 (verbatim intent): *For any* execution of PLAN_EDITS, a
thinking event conforming to the contract is emitted with its collapsible
display flag set.

Requirement 3.6 (verbatim): *WHEN the PLAN_EDITS stage runs, THE Gateway SHALL
emit a thinking event conforming to the Event_Contract carrying the edit
reasoning with a collapsible display flag.*

Strategy
--------
We exercise :meth:`EditCoordinator.plan_edits` over **arbitrary** edit-plan
reasoning strings (the rationale that PLAN_EDITS surfaces). For every drawn
reasoning we build an :class:`EditPlan`, run ``plan_edits``, and assert the
exhaustive PLAN_EDITS emission contract:

* exactly **one** event is emitted (and it is the returned event);
* it is a :class:`ThinkingEvent` whose ``collapsible`` flag is ``True``;
* its ``text`` is exactly the plan's reasoning (the carried rationale, R3.6);
* it conforms to the shared Event_Contract via
  ``AgentEventModel.model_validate`` (R3.6 "conforming to the Event_Contract").
"""

from __future__ import annotations

import itertools

from hypothesis import given, settings
from hypothesis import strategies as st
from shared_schema.agent_events import (
    AgentEvent,
    AgentEventModel,
    ThinkingEvent,
)

from zocai_gateway.edits import EditCoordinator, EditPlan
from zocai_gateway.toolsets import FullToolset


@settings(max_examples=200)
@given(reasoning=st.text())
def test_plan_edits_emits_one_collapsible_thinking_event_carrying_reasoning(
    reasoning: str,
    tmp_path_factory,
) -> None:
    """Property 14: PLAN_EDITS emits exactly one conforming, collapsible thinking event.

    Feature: zocai-ecosystem-rebuild, Property 14

    **Validates: Requirements 3.6**
    """
    # A fresh workspace + recording sink per example (function-scoped tmp_path
    # is incompatible with @given, so we mint a unique directory per draw).
    workspace = tmp_path_factory.mktemp("ws")
    recorded: list[AgentEvent] = []
    coord = EditCoordinator(
        toolset=FullToolset(workspace_root=workspace),
        run_id="r-prop14",
        emit=recorded.append,
        next_seq=itertools.count().__next__,
    )

    event = coord.plan_edits(EditPlan(reasoning=reasoning))

    # Exactly one event emitted, and it is the event returned to the caller.
    assert recorded == [event]
    # It is a collapsible thinking event carrying the edit reasoning (R3.6).
    assert isinstance(event, ThinkingEvent)
    assert event.collapsible is True
    assert event.text == reasoning
    # Conforms to the shared Event_Contract (R3.6 "conforming to the
    # Event_Contract"): the emit gate's validation entrypoint accepts it.
    AgentEventModel.model_validate(event.model_dump(by_alias=True))
