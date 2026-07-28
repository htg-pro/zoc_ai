"""Property test for the mode capability table (zoc-ai-agent-chat-overhaul, Property 16).

Feature: zoc-ai-agent-chat-overhaul, Property 16: Mode permissions follow the
declared capability table.

**Validates: Requirements 7.6, 7.7, 16.2, 16.3, 16.4**
"""

from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st
from zocai_gateway.errors import ErrorCode
from zocai_gateway.mode_router import PERMISSIONS, Capability, Mode, check_capability

_modes = st.sampled_from(list(Mode))
_capabilities = st.sampled_from(list(Capability))


def _expected(mode: Mode, approved: bool, capability: Capability) -> bool:
    """The rule the table encodes (design Mode_Router / R7.6-R7.7 / R16.2-16.4)."""
    if capability is Capability.READ:
        return True
    if mode is Mode.AGENT:
        return True
    if mode is Mode.PLAN:
        return approved
    return False  # Mode.ASK never permits write/execute


@settings(max_examples=200)
@given(mode=_modes, approved=st.booleans(), capability=_capabilities)
def test_check_capability_equals_declared_table(
    mode: Mode, approved: bool, capability: Capability
) -> None:
    """Property 16: the decision equals the declared table entry.

    Feature: zoc-ai-agent-chat-overhaul, Property 16

    **Validates: Requirements 7.6, 7.7, 16.2, 16.3, 16.4**
    """
    expected = _expected(mode, approved, capability)
    assert PERMISSIONS[(mode, approved, capability)] is expected

    decision = check_capability(mode, approved, capability)
    assert decision.permitted is expected
    if expected:
        assert decision.code is None
    else:
        # A rejection is typed as a mode-permission error (R7.6, R16.2).
        assert decision.rejected is True
        assert decision.code == ErrorCode.MODE_NOT_PERMITTED
        assert decision.message


def test_table_is_exhaustive_over_the_domain() -> None:
    """Every (mode, approved, capability) combination has a declared entry (R7.1)."""
    assert len(PERMISSIONS) == len(Mode) * 2 * len(Capability)


def test_read_is_always_permitted() -> None:
    """Read-only tools are permitted in every mode and approval state (R16.2/16.3)."""
    for mode in Mode:
        for approved in (False, True):
            assert check_capability(mode, approved, Capability.READ).permitted


def test_ask_and_preapproval_plan_reject_writes_and_execution() -> None:
    """Ask and pre-approval plan reject write/execute with a typed error (R16.2/16.3)."""
    for capability in (Capability.WRITE, Capability.EXECUTE):
        assert check_capability(Mode.ASK, False, capability).rejected
        assert check_capability(Mode.ASK, True, capability).rejected
        assert check_capability(Mode.PLAN, False, capability).rejected
        # Agent and post-approval plan permit them (R7.7, R16.4).
        assert check_capability(Mode.PLAN, True, capability).permitted
        assert check_capability(Mode.AGENT, False, capability).permitted
        assert check_capability(Mode.AGENT, True, capability).permitted
