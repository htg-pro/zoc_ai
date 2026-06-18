"""Property test for Gateway request admission (task 6.4).

Feature: zoc-agent-ecosystem-merge, Property 7: Gateway request admission policy

**Validates: Requirements 12.3, 12.4**

Design Property 7 (verbatim intent): *For any* binding (loopback or
non-loopback) and any credential presented (absent, invalid, or valid), a
control/telemetry request is admitted **if and only if** the binding is
loopback *or* the presented credential is valid; a non-admitted request is
exactly the non-loopback binding with an absent/invalid credential.

Strategy
--------
We drive the real pure admission policy
:func:`zocai_gateway.auth.is_request_admitted` across the full input space:

* **binding** — a host drawn from both the loopback set (``127.0.0.1``,
  ``::1``, ``localhost``) and a sample of non-loopback hosts, so both branches
  of the policy are exercised;
* **configured credential** — ``auth_token`` is sometimes ``None``, sometimes
  the empty string (which must count as *no* valid credential), and sometimes a
  non-empty secret;
* **presented credential** — drawn so it is sometimes ``None`` (absent),
  sometimes a wrong string (invalid), and sometimes *exactly* the configured
  token (valid only when that token is non-empty).

For every drawn ``(settings, presented)`` pair we assert the result matches the
independently-computed spec predicate
``is_loopback OR (token is non-empty AND presented == token)`` and, separately,
that a non-admitted case is *exactly* the non-loopback + absent/invalid case.
"""

from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st

from zocai_gateway.auth import is_request_admitted
from zocai_gateway.settings import LOOPBACK_HOSTS, GatewaySettings

# Hosts that bind the loopback interface (admission must be unconditional).
_loopback_hosts = st.sampled_from(sorted(LOOPBACK_HOSTS))

# A sample of non-loopback bind hosts (admission requires a valid credential).
_non_loopback_hosts = st.sampled_from(
    ["0.0.0.0", "10.0.0.5", "192.168.1.10", "::", "example.com", "203.0.113.7"]
)

# The configured credential: absent (None), empty (treated as no credential),
# or a non-empty shared secret.
_configured_tokens = st.one_of(
    st.none(),
    st.just(""),
    st.text(min_size=1, max_size=32),
)


@st.composite
def _admission_inputs(draw: st.DrawFn) -> tuple[GatewaySettings, str | None]:
    """Draw a ``(GatewaySettings, presented_credential)`` pair spanning the space.

    The presented credential is deliberately drawn to land in each admission
    category: ``None`` (absent), a string unequal to the configured token
    (invalid), or a string equal to the configured token (valid iff non-empty).
    """
    host = draw(st.one_of(_loopback_hosts, _non_loopback_hosts))
    token = draw(_configured_tokens)
    settings_obj = GatewaySettings(host=host, port=0, auth_token=token)

    # A "wrong" credential guaranteed not to equal the configured token.
    wrong = draw(st.text(max_size=32).filter(lambda s: s != (token or "")))

    presented = draw(
        st.one_of(
            st.none(),  # absent
            st.just(wrong),  # invalid
            st.just(token if token else wrong),  # equal to configured token
        )
    )
    return settings_obj, presented


@settings(max_examples=200)
@given(_admission_inputs())
def test_request_admitted_iff_loopback_or_valid_credential(
    case: tuple[GatewaySettings, str | None],
) -> None:
    """Property 7: admitted iff loopback OR presented credential is valid.

    Feature: zoc-agent-ecosystem-merge, Property 7: Gateway request admission policy

    **Validates: Requirements 12.3, 12.4**
    """
    settings_obj, presented = case

    # Independent spec predicate: a credential is valid only when a non-empty
    # token is configured and the presented credential equals it exactly.
    token = settings_obj.auth_token
    credential_valid = bool(token) and presented == token
    expected_admitted = settings_obj.is_loopback() or credential_valid

    admitted = is_request_admitted(settings_obj, presented)

    assert admitted == expected_admitted

    # A non-admitted request is *exactly* the non-loopback binding with an
    # absent/invalid credential (R12.3); loopback is always admitted (R12.4).
    if not admitted:
        assert not settings_obj.is_loopback()
        assert not credential_valid
    if settings_obj.is_loopback():
        assert admitted is True
