"""Property test for unrecoverable-error terminal closure (task 5.12).

Feature: zocai-ecosystem-rebuild, Property 18: Unrecoverable error before DONE
emits a terminal error event and closes the stream.

**Validates: Requirements 3.10**

Design Property 18 (verbatim intent): *For any* unrecoverable error occurring
at any stage before the FSM reaches DONE, the Gateway emits a terminal error
event distinct from the normal ``done`` event and closes the SSE stream via the
ERROR_CLOSED terminal state, without emitting a normal ``done`` event for that
run.

Requirement 3.10 (verbatim): *IF an unrecoverable error occurs before the FSM
reaches the DONE stage, THEN THE Gateway SHALL emit a terminal error event over
the SSE_Bus and close the SSE_Bus stream for the run.*

Strategy
--------
We exercise the real :class:`FSM` (no mocks) over the **complete** set of
non-terminal start stages — every :class:`Stage` except the two terminals
``DONE`` and ``ERROR_CLOSED``. From each such start stage we invoke
:meth:`FSM.fail` with an arbitrary reason and assert the terminal-error
contract:

* the FSM lands in ``ERROR_CLOSED`` and is now terminal (``is_terminal``);
* ``ERROR_CLOSED`` is **distinct** from ``DONE`` — the run never reached the
  normal terminal;
* the last emitted event is the terminal error event — a
  :class:`CommandEvent` carrying an ``error_tag`` (the failure reason),
  **not** a :class:`DoneEvent` — and *no* ``done`` event was emitted for the
  run (closing the stream on the error path, R3.10);
* that terminal error event conforms to the shared Event_Contract via
  ``AgentEventModel.model_validate``.
"""

from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st
from shared_schema.agent_events import (
    AgentEventModel,
    CommandEvent,
    DoneEvent,
)

from zocai_gateway.fsm import FSM
from zocai_gateway.stages import Stage

# The two terminal stages; ``fail()`` is only legal from a non-terminal stage.
_TERMINAL = {Stage.DONE, Stage.ERROR_CLOSED}

# Every non-terminal start stage — the full domain Property 18 ranges over,
# including the off-happy-path HANDLE_ERROR and PAUSED stages.
NON_TERMINAL_STAGES = [s for s in Stage if s not in _TERMINAL]


@settings(max_examples=200)
@given(
    start=st.sampled_from(NON_TERMINAL_STAGES),
    reason=st.text(min_size=0, max_size=80),
)
def test_unrecoverable_error_before_done_closes_stream_with_terminal_error(
    start: Stage,
    reason: str,
) -> None:
    """Property 18: failing before DONE yields a terminal error close, not a done.

    Feature: zocai-ecosystem-rebuild, Property 18

    **Validates: Requirements 3.10**
    """
    recorded: list = []
    fsm = FSM(initial=start, run_id="r-prop18", emit=recorded.append)

    landed = fsm.fail(reason)

    # The error path terminates at ERROR_CLOSED, distinct from DONE (R3.10).
    assert landed is Stage.ERROR_CLOSED
    assert fsm.current is Stage.ERROR_CLOSED
    assert fsm.current is not Stage.DONE
    assert fsm.is_terminal is True

    # The last emitted event is the terminal error event: a CommandEvent
    # carrying the failure reason as its error_tag — not a DoneEvent (R3.10).
    terminal = recorded[-1]
    assert isinstance(terminal, CommandEvent)
    assert not isinstance(terminal, DoneEvent)
    assert terminal.error_tag == reason

    # No normal ``done`` completion event was emitted for the run; the stream
    # closes on the error path instead (R3.10).
    assert not any(isinstance(ev, DoneEvent) for ev in recorded)

    # The terminal error event conforms to the shared Event_Contract (R3.10):
    # the emit gate's validation entrypoint accepts it.
    AgentEventModel.model_validate(terminal.model_dump(by_alias=True))
