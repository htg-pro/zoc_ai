"""Request-admission auth guard for the Gateway control/telemetry routes (R12).

This module implements the *request-time* half of Requirement 12 — the
loopback-binding + auth guard — as a FastAPI dependency that runs **before** a
route handler executes. It is the runtime companion to the *startup-time*
:meth:`~zocai_gateway.settings.GatewaySettings.enforce_bind_policy` guard:

- On a **non-loopback** binding, a request that does not present a valid
  credential is rejected with HTTP ``401`` *before* the handler runs, so the
  requested operation never executes (R12.3).
- On a **loopback** binding, requests are admitted whether or not a credential
  is present (R12.4).

The admission decision itself is a small pure function,
:func:`is_request_admitted`, so it is trivially testable in isolation (this is
the function exercised by Property 7, "Gateway request admission policy"). The
FastAPI plumbing — extracting the presented credential from request headers and
turning a non-admission into an :class:`~fastapi.HTTPException` — is layered on
top.

The dependency obtains the active :class:`GatewaySettings` from
``request.app.state`` under :data:`STATE_SETTINGS_KEY`. The launch entrypoint
(and any app factory wiring) is expected to publish the resolved settings there;
when no settings are present (e.g. an app constructed in a test without the
security wiring) the guard falls back to default **loopback** settings and
therefore admits every request, preserving the unauthenticated loopback posture
(R12.4) rather than failing closed on an unconfigured app.

A credential may be presented either as an ``Authorization: Bearer <token>``
header or as an ``X-Zoc-Studio-Token: <token>`` header; both are compared
against :attr:`GatewaySettings.auth_token` in constant time.
"""

from __future__ import annotations

import hmac
from collections.abc import Mapping

from fastapi import HTTPException, Request, status

from zocai_gateway.settings import GatewaySettings

__all__ = [
    "AUTH_SCHEME",
    "STATE_SETTINGS_KEY",
    "TOKEN_HEADER_NAME",
    "extract_credential",
    "get_gateway_settings",
    "is_request_admitted",
    "require_admission",
]

#: Attribute name under which the active :class:`GatewaySettings` is published
#: on ``app.state``. The launch entrypoint / app wiring sets
#: ``app.state.gateway_settings = settings`` so this dependency can read the
#: live bind host and credential. Kept as a named constant so the producer and
#: consumer of the state never drift.
STATE_SETTINGS_KEY = "gateway_settings"

#: The ``Authorization`` scheme recognized for the shared-secret credential.
#: A request may send ``Authorization: Bearer <token>``.
AUTH_SCHEME = "Bearer"

#: Alternative header carrying the shared-secret credential directly, for
#: clients (e.g. ``EventSource``) that cannot set ``Authorization``.
TOKEN_HEADER_NAME = "X-Zoc-Studio-Token"


def _credential_is_valid(expected: str | None, presented: str | None) -> bool:
    """Return whether ``presented`` matches the configured ``expected`` token.

    A credential is valid only when a credential is actually configured
    (``expected`` is a non-empty string) and a non-empty credential is presented
    that matches it. The comparison uses :func:`hmac.compare_digest` so it does
    not leak the token length or contents through timing.
    """
    if not expected or not presented:
        return False
    return hmac.compare_digest(expected.encode("utf-8"), presented.encode("utf-8"))


def is_request_admitted(
    settings: GatewaySettings, presented_credential: str | None
) -> bool:
    """Decide whether a control/telemetry request is admitted (R12.3/R12.4).

    This is the pure admission policy (Property 7): a request is admitted **iff**
    the binding is loopback *or* the presented credential is valid. On a
    non-loopback binding an absent or invalid credential is *not* admitted.

    Args:
        settings: The active Gateway settings (bind host + configured token).
        presented_credential: The credential extracted from the request, or
            ``None`` when the request presented none.

    Returns:
        ``True`` when the request should reach the handler; ``False`` when it
        must be rejected.
    """
    if settings.is_loopback():
        return True
    return _credential_is_valid(settings.auth_token, presented_credential)


def _lookup_header(headers: Mapping[str, str], name: str) -> str | None:
    """Case-insensitively read ``name`` from ``headers``.

    Starlette's ``request.headers`` is already case-insensitive, but this guard
    accepts any :class:`~collections.abc.Mapping` (including a plain ``dict`` in
    tests), so the lookup normalizes header names itself rather than relying on
    the mapping's behavior.
    """
    direct = headers.get(name)
    if direct is not None:
        return direct
    target = name.lower()
    for key, value in headers.items():
        if key.lower() == target:
            return value
    return None


def extract_credential(headers: Mapping[str, str]) -> str | None:
    """Extract the presented shared-secret credential from request headers.

    Recognizes, in order:

    1. ``Authorization: Bearer <token>`` (scheme matched case-insensitively),
    2. ``X-Zoc-Studio-Token: <token>``.

    Header *names* are matched case-insensitively regardless of the mapping
    type, so a plain ``dict`` works the same as Starlette's headers.

    Args:
        headers: A header mapping (FastAPI/Starlette ``request.headers``
            satisfies this).

    Returns:
        The bare token string, or ``None`` when neither header carries a
        non-empty credential.
    """
    authorization = _lookup_header(headers, "Authorization")
    if authorization:
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() == AUTH_SCHEME.lower():
            token = token.strip()
            if token:
                return token

    direct = _lookup_header(headers, TOKEN_HEADER_NAME)
    if direct:
        direct = direct.strip()
        if direct:
            return direct

    return None


def get_gateway_settings(request: Request) -> GatewaySettings:
    """Return the active :class:`GatewaySettings` for ``request``.

    Reads the settings published on ``app.state`` under
    :data:`STATE_SETTINGS_KEY`. When none are published (an app constructed
    without the R12 wiring), falls back to default **loopback** settings so the
    guard admits requests rather than failing closed — matching the
    unauthenticated loopback posture (R12.4).
    """
    settings = getattr(request.app.state, STATE_SETTINGS_KEY, None)
    if isinstance(settings, GatewaySettings):
        return settings
    return GatewaySettings()


async def require_admission(request: Request) -> None:
    """FastAPI dependency that admits or rejects a request before the handler.

    Wire this as a route/router dependency on the control and telemetry
    endpoints. It reads the live :class:`GatewaySettings`, extracts any
    presented credential, and applies :func:`is_request_admitted`. When the
    request is not admitted it raises :class:`~fastapi.HTTPException` with status
    ``401`` so the operation never executes (R12.3); on a loopback binding it is
    a no-op and the request proceeds (R12.4).

    Raises:
        HTTPException: ``401 Unauthorized`` when the binding is non-loopback and
            the request lacks a valid credential.
    """
    settings = get_gateway_settings(request)
    presented = extract_credential(request.headers)
    if not is_request_admitted(settings, presented):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing or invalid Gateway authentication credential",
            headers={"WWW-Authenticate": AUTH_SCHEME},
        )
