"""Property test for failure-capture log truncation (task 5.17).

Feature: zocai-ecosystem-rebuild, Property 23: Failure capture truncates the
log.

**Validates: Requirements 5.3**

Design Property 23 (verbatim intent): *For any* compiler log, the captured
failure record retains the failed command and exit code and stores the log
truncated to at most 65,536 characters.

The failure capture lives in
:class:`zocai_gateway.memory.state_wrapper.FailureRecord`, which truncates its
``log`` to :data:`~zocai_gateway.memory.state_wrapper.LOG_MAX_CHARS` (65,536) at
construction (see ``remediation.RemediationLoop.on_checks_complete`` R5.3, which
builds the record). This property is exercised against the real
:class:`FailureRecord` (no mocks) over arbitrary-length log strings — spanning
below, at, and above the cap — asserting that:

* the captured log length is exactly ``min(len(log), 65_536)``;
* the captured log is exactly the original log's leading prefix; and
* the failed command and exit code are retained unchanged.
"""

from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st

from zocai_gateway.memory import LOG_MAX_CHARS, FailureRecord

# Logs spanning the interesting regime around the cap: well below, around the
# boundary, and comfortably above LOG_MAX_CHARS so truncation actually fires.
_LOG = st.text(max_size=LOG_MAX_CHARS * 2 + 64)
_COMMAND = st.text(max_size=64)
_EXIT_CODE = st.integers(min_value=-(2**31), max_value=2**31 - 1)


@settings(max_examples=200)
@given(command=_COMMAND, exit_code=_EXIT_CODE, log=_LOG)
def test_failure_capture_truncates_log_to_cap(
    command: str, exit_code: int, log: str
) -> None:
    """Property 23: the captured failure log is truncated to the cap.

    Feature: zocai-ecosystem-rebuild, Property 23

    **Validates: Requirements 5.3**
    """
    record = FailureRecord(command=command, exit_code=exit_code, log=log)

    expected_len = min(len(log), LOG_MAX_CHARS)
    # The stored log is capped at LOG_MAX_CHARS characters.
    assert len(record.log) == expected_len
    # ...and is exactly the original log's leading prefix (no reordering/loss
    # of earlier content, no inserted ellipsis).
    assert record.log == log[:expected_len]
    # The failed command and exit code are retained unchanged (R5.3).
    assert record.command == command
    assert record.exit_code == exit_code
