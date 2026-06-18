"""Property test for the Gateway startup bind policy (task 6.2).

Feature: zoc-agent-ecosystem-merge, Property 6: Gateway startup bind policy

**Validates: Requirements 12.2**

Design Property 6 (verbatim intent): *For any* configured (host, credential)
pair, the startup bind-policy check refuses to start (raising a configuration
error that identifies the missing credential) if and only if the host is a
non-loopback interface and no authentication credential is configured;
otherwise startup proceeds.

Strategy
--------
We drive the real :meth:`GatewaySettings.enforce_bind_policy` across the full
(host, credential) input space:

* ``host`` — a mix of the loopback values (:data:`LOOPBACK_HOSTS`) and
  arbitrary non-loopback hostnames / IP-like strings, so both sides of the
  loopback predicate are exercised.
* ``auth_token`` — ``None`` (unset), the empty string (set-but-blank, which the
  policy treats as *no credential*), and non-empty secrets.

For every drawn pair we compute the expected outcome directly from the
specification's biconditional — refuse *iff* non-loopback **and** no credential
— and assert that ``enforce_bind_policy`` matches it: raising
:class:`GatewayConfigError` whose message names the missing credential
(:data:`AUTH_TOKEN_ENV_VAR`) in the refuse case, and returning ``None`` without
raising otherwise.
"""

from __future__ import annotations

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from zocai_gateway.settings import (
    AUTH_TOKEN_ENV_VAR,
    LOOPBACK_HOSTS,
    GatewayConfigError,
    GatewaySettings,
)

# Loopback hosts the policy must always accept (R12.1/R12.4).
_loopback_hosts = st.sampled_from(sorted(LOOPBACK_HOSTS))

# Arbitrary non-loopback hostnames / IP-like strings. We exclude any value that
# happens to be a loopback host so this strategy stays strictly non-loopback.
_non_loopback_hosts = st.one_of(
    # Public / private IPv4-looking addresses.
    st.from_regex(r"\A(?:[1-9]?[0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])"
                  r"(?:\.(?:[0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])){3}\Z",
                  fullmatch=True),
    # DNS-style hostnames.
    st.from_regex(r"\A[a-z][a-z0-9-]{0,20}(?:\.[a-z][a-z0-9-]{0,20}){0,3}\Z", fullmatch=True),
    # Bind-all / arbitrary tokens.
    st.sampled_from(["0.0.0.0", "::", "example.com", "10.0.0.5", "192.168.1.10"]),
).filter(lambda h: h not in LOOPBACK_HOSTS)

_hosts = st.one_of(_loopback_hosts, _non_loopback_hosts)

# Credential: unset (None), set-but-blank (""), or a non-empty secret. The
# empty string is deliberately included because the policy treats it as
# "no credential" (falsy), so it must behave like None.
_auth_tokens = st.one_of(
    st.none(),
    st.just(""),
    st.text(min_size=1, max_size=40),
)


@settings(max_examples=200)
@given(host=_hosts, auth_token=_auth_tokens)
def test_bind_policy_refuses_iff_non_loopback_without_credential(
    host: str,
    auth_token: str | None,
) -> None:
    """Property 6: refuse to start *iff* non-loopback and no credential.

    Feature: zoc-agent-ecosystem-merge, Property 6: Gateway startup bind policy

    **Validates: Requirements 12.2**
    """
    settings_obj = GatewaySettings(host=host, auth_token=auth_token)

    # The specification's biconditional, computed independently of the host
    # check under test: a credential is "configured" iff it is truthy.
    is_loopback = host in LOOPBACK_HOSTS
    has_credential = bool(auth_token)
    should_refuse = (not is_loopback) and (not has_credential)

    if should_refuse:
        # Non-loopback bind without a credential must refuse to start, and the
        # error must name the missing credential so the operator can fix it.
        with pytest.raises(GatewayConfigError) as exc_info:
            settings_obj.enforce_bind_policy()
        assert AUTH_TOKEN_ENV_VAR in str(exc_info.value)
    else:
        # Loopback (with or without a credential) or a non-loopback bind that
        # *does* carry a credential: startup proceeds, no exception raised.
        assert settings_obj.enforce_bind_policy() is None
