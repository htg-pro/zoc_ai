"""Property test for stage-entry events (task 5.7).

Feature: zocai-ecosystem-rebuild, Property 13: Every entered stage emits a
conforming stage event.

**Validates: Requirements 3.3**

Design Property 13 (verbatim intent): *For any* stage the FSM enters, a
contract-valid event naming that stage is emitted.

Requirement 3.3 (verbatim): *WHEN the FSM enters a stage, THE Gateway SHALL
emit an event conforming to the Event_Contract that names the entered stage
over the SSE_Bus.*

Strategy
--------
We drive the real :class:`FSM` along randomized **legal** transition
sequences. Starting from the initial stage entry, each step picks a legal move
through the FSM's own guarded API:

* deterministic single-successor stages advance via :meth:`FSM.advance`;
* the branching stages take an arbitrary decision — ``PLAN_EDITS`` via
  :meth:`FSM.plan_complete` (with/without changes, exercising the empty-plan
  skip R3.8) and ``RUN_CHECKS`` via :meth:`FSM.run_checks_result` (arbitrary
  exit code, exercising the SUMMARY vs HANDLE_ERROR branch);
* ``HANDLE_ERROR`` returns via :meth:`FSM.remediate`.

To exercise the off-happy-path stage entries that also emit (R3.3), a run may
randomly terminate early through :meth:`FSM.fail` (→ ``ERROR_CLOSED``) or
:meth:`FSM.pause` (→ ``PAUSED``).

For every drawn sequence we assert the exhaustive stage-entry contract:

* the FSM emits **exactly one** event per entered stage (count + ordered
  ``seq`` 0..n-1);
* every emitted event validates against the shared Event_Contract via
  ``AgentEventModel.model_validate`` (R3.3 "conforming to the Event_Contract");
* every emitted event **names** the stage it was emitted for (R3.3 "names the
  entered stage").
"""

from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st
from shared_schema.agent_events import (
    AgentEvent,
    AgentEventModel,
    CommandEvent,
    DoneEvent,
    SummaryEvent,
    ThinkingEvent,
)

from zocai_gateway.fsm import FSM
from zocai_gateway.stages import Stage

# Bound the randomized walk so HANDLE_ERROR → PLAN_EDITS remediation loops
# terminate; well above the 9-stage happy path plus several remediation cycles.
_MAX_STEPS = 40


def _event_names_stage(event: AgentEvent, stage: Stage) -> bool:
    """Whether ``event`` names ``stage`` per the default stage-event factory (R3.3).

    The default factory maps each stage to a contract event that carries the
    stage's name:

    * ``DONE`` → a terminal :class:`DoneEvent` completion (the normal-path
      terminal — naming is by kind, R3.4);
    * ``ERROR_CLOSED`` → a :class:`CommandEvent` whose ``command`` embeds the
      stage value (R3.10);
    * ``SUMMARY`` → a :class:`SummaryEvent` whose ``text`` is the stage value;
    * every other stage → a :class:`ThinkingEvent` whose ``text`` is the stage
      value.
    """
    if stage is Stage.DONE:
        return isinstance(event, DoneEvent)
    if stage is Stage.ERROR_CLOSED:
        return isinstance(event, CommandEvent) and stage.value in event.command
    if stage is Stage.SUMMARY:
        return isinstance(event, SummaryEvent) and event.text == stage.value
    return isinstance(event, ThinkingEvent) and event.text == stage.value


@settings(max_examples=200)
@given(data=st.data())
def test_every_entered_stage_emits_one_conforming_naming_event(
    data: st.DataObject,
) -> None:
    """Property 13: every entered stage emits exactly one conforming, naming event.

    Feature: zocai-ecosystem-rebuild, Property 13

    **Validates: Requirements 3.3**
    """
    recorded: list[AgentEvent] = []
    fsm = FSM(run_id="r-prop13", emit=recorded.append)

    # The constructor entry into the initial stage is itself a stage entry (R3.3).
    entered: list[Stage] = [fsm.initial]

    steps = data.draw(st.integers(min_value=0, max_value=_MAX_STEPS))
    for _ in range(steps):
        if fsm.is_terminal:
            break

        # Randomly take an off-happy-path terminating entry to cover the
        # ERROR_CLOSED / PAUSED stage entries that also emit (R3.3).
        escape = data.draw(st.sampled_from(["continue", "continue", "continue", "fail", "pause"]))
        if escape == "fail":
            entered.append(fsm.fail("randomized unrecoverable error"))
            break
        if escape == "pause":
            # PAUSED is reached outside LEGAL and has no legal successors, so a
            # paused run cannot continue the legal walk here; stop after it.
            entered.append(fsm.pause("randomized pause"))
            break

        current = fsm.current
        if current is Stage.PLAN_EDITS:
            has_changes = data.draw(st.booleans())
            entered.append(fsm.plan_complete(has_changes=has_changes))
        elif current is Stage.RUN_CHECKS:
            exit_code = data.draw(st.integers(min_value=-8, max_value=8))
            entered.append(fsm.run_checks_result(exit_code))
        elif current is Stage.HANDLE_ERROR:
            entered.append(fsm.remediate())
        else:
            # Deterministic single-successor stage (or terminal with no targets).
            if not fsm.legal_targets():
                break
            entered.append(fsm.advance())

    # Exactly one emitted event per entered stage, in production order (R3.3).
    assert len(recorded) == len(entered)
    assert [e.seq for e in recorded] == list(range(len(entered)))

    for event, stage in zip(recorded, entered):
        # Conforms to the shared Event_Contract (R3.3 "conforming to the
        # Event_Contract"): the emit gate's validation entrypoint accepts it.
        AgentEventModel.model_validate(event.model_dump(by_alias=True))
        # Names the entered stage (R3.3 "that names the entered stage").
        assert _event_names_stage(event, stage), (
            f"event {event!r} does not name entered stage {stage}"
        )
