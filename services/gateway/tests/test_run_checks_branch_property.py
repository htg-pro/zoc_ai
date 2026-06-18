"""Property test for the RUN_CHECKS exit-code branch of the Agent-Mode FSM (task 5.16).

Feature: zocai-ecosystem-rebuild, Property 22: RUN_CHECKS branches on exit code.

**Validates: Requirements 5.1, 5.8**

Design Property 22 (verbatim intent): *For any* RUN_CHECKS outcome, a non-zero
exit code transitions to HANDLE_ERROR (R5.1) and a zero exit code transitions to
SUMMARY (R5.8).

Strategy
--------
:meth:`zocai_gateway.fsm.FSM.run_checks_result` owns the branch out of
``RUN_CHECKS``. We exercise it against the real FSM (no mocks) over arbitrary
integer exit codes — including ``0``, positive codes, and negative codes
(signal-style terminations) — and assert the exact branch shape:

* exit code ``== 0`` lands on ``SUMMARY`` (R5.8);
* every non-zero exit code lands on ``HANDLE_ERROR`` (R5.1).

The generator draws full-width integers so the property covers the entire
exit-code domain rather than a small sample, and runs well beyond the
100-example floor.
"""

from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st

from zocai_gateway.fsm import FSM
from zocai_gateway.stages import Stage

# Arbitrary integer exit codes spanning the full domain: zero, positive
# success-adjacent codes, and negative (signal-style) terminations.
_exit_codes = st.integers()


@settings(max_examples=200)
@given(exit_code=_exit_codes)
def test_run_checks_branches_on_exit_code(exit_code: int) -> None:
    """Property 22: zero exit -> SUMMARY (R5.8); non-zero exit -> HANDLE_ERROR (R5.1).

    Feature: zocai-ecosystem-rebuild, Property 22

    **Validates: Requirements 5.1, 5.8**
    """
    fsm = FSM(initial=Stage.RUN_CHECKS)
    landed = fsm.run_checks_result(exit_code)

    if exit_code == 0:
        assert landed is Stage.SUMMARY
    else:
        assert landed is Stage.HANDLE_ERROR
    # The FSM actually moved to the branched stage.
    assert fsm.current is landed
