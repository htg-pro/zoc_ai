"""The structured error envelope and read-only mode isolation.

Two rules are pinned here:

1. Every error the renderer can see has a code and a human-readable message, and
   the message never carries an internal identifier. The reported symptom was
   ``Error: unknown run: <uuid>`` — an id shown as if it were a diagnosis.
2. Ask and Plan are read-only. Ask's toolset physically lacks mutating
   operations; Plan reaches the workspace only after an explicit approval gate.
"""

from __future__ import annotations

from zocai_gateway.errors import (
    ERROR_MESSAGES,
    ErrorCode,
    error_body,
    error_envelope,
    sanitize_detail,
)
from zocai_gateway.mode_router import AgentRunRequest, Mode, ModeRouter
from zocai_gateway.toolsets import ReadOnlyToolset, ReadOnlyViolation

# ── envelope shape ─────────────────────────────────────────────────────────


def test_envelope_defaults_to_the_registered_message() -> None:
    envelope = error_envelope(ErrorCode.NO_WORKSPACE)
    assert envelope.code == ErrorCode.NO_WORKSPACE
    assert envelope.message == ERROR_MESSAGES[ErrorCode.NO_WORKSPACE]
    assert envelope.details is None


def test_envelope_marks_transient_failures_retryable() -> None:
    assert error_envelope(ErrorCode.RUN_ATTACH_FAILED).retryable is True
    # A rejected request is not worth retrying unchanged.
    assert error_envelope(ErrorCode.PATH_OUTSIDE_WORKSPACE).retryable is False


def test_every_code_has_a_user_readable_message() -> None:
    codes = [
        value
        for name, value in vars(ErrorCode).items()
        if not name.startswith("_") and isinstance(value, str)
    ]
    assert codes
    for code in codes:
        message = ERROR_MESSAGES[code]
        assert message.strip()
        # A message is a sentence for a person, not a symbol for a machine.
        assert code not in message
        assert not message.startswith("{")


def test_details_are_bounded() -> None:
    assert sanitize_detail(None) is None
    assert sanitize_detail("   ") is None
    long_detail = sanitize_detail("x" * 5_000)
    assert long_detail is not None
    assert len(long_detail) <= 601


def test_error_body_is_json_serialisable_with_all_four_fields() -> None:
    body = error_body(ErrorCode.RUN_FAILED, details="boom")
    assert set(body) == {"code", "message", "details", "retryable"}
    assert body["details"] == "boom"


# ── mode isolation ─────────────────────────────────────────────────────────


#: The mutating operations that exist only on `FullToolset`. Ask mode must not
#: have any of them — the guarantee is structural, not a runtime check.
_MUTATING_OPERATIONS = (
    "write_file",
    "make_dir",
    "delete_file",
    "move_file",
    "run_shell",
    "fetch_url",
)


def test_ask_mode_toolset_cannot_mutate() -> None:
    path = ModeRouter().route(AgentRunRequest(prompt="explain this", mode="ask"))
    assert path.mode is Mode.ASK
    assert path.is_read_only is True
    toolset = path.toolset
    assert isinstance(toolset, ReadOnlyToolset)
    # Reading is available; every mutating operation is absent rather than
    # merely rejected, so an Ask run cannot write a file or run a command.
    assert hasattr(toolset, "read_file")
    for operation in _MUTATING_OPERATIONS:
        assert not hasattr(toolset, operation), operation


def test_agent_toolset_has_the_mutating_operations_ask_lacks() -> None:
    """Guards the test above from silently passing after a rename."""
    agent = ModeRouter().route(AgentRunRequest(prompt="add a file", mode="agent"))
    for operation in _MUTATING_OPERATIONS:
        assert hasattr(agent.toolset, operation), operation


def test_read_only_violation_names_the_rejected_operation() -> None:
    violation = ReadOnlyViolation("write_file")
    assert violation.operation == "write_file"
    assert "write_file" in str(violation)


def test_plan_mode_is_routed_as_plan_not_agent() -> None:
    """Plan must not be silently promoted to a writing Agent run."""
    path = ModeRouter().route(AgentRunRequest(prompt="plan the change", mode="plan"))
    assert path.mode is Mode.PLAN
    assert path.plan_only is True


def test_agent_mode_is_the_only_writing_path() -> None:
    agent = ModeRouter().route(AgentRunRequest(prompt="add a file", mode="agent"))
    assert agent.mode is Mode.AGENT
    assert agent.is_read_only is False
    assert agent.plan_only is False
