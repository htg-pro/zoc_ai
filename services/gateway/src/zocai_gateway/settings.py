"""Gateway bind/auth settings and the R12 startup bind policy.

This module implements the security posture from Requirement 12 (the
"loopback binding + auth guard") **without** touching any route handler logic:

- :class:`GatewaySettings` describes where the Gateway binds (``host``/``port``)
  and the optional shared-secret credential used to admit requests when the
  Gateway is exposed beyond loopback.
- The default bind is the loopback interface ``127.0.0.1`` (R12.1).
- :meth:`GatewaySettings.enforce_bind_policy` refuses to start the process when
  a non-loopback interface is configured **without** an authentication
  credential, raising :class:`GatewayConfigError` whose message *names* the
  missing credential environment variable (R12.2).

The companion request-admission FastAPI dependency (R12.3/R12.4) and the launch
entrypoint that performs the port handshake (R10.2/R10.3) are intentionally
**not** implemented here — they live in their own modules.
"""

from __future__ import annotations

import os
from collections.abc import Mapping

from pydantic import BaseModel, ConfigDict, Field

__all__ = [
    "AUTH_TOKEN_ENV_VAR",
    "HOST_ENV_VAR",
    "LOOPBACK_HOSTS",
    "PORT_ENV_VAR",
    "GatewayConfigError",
    "GatewaySettings",
]

#: Environment variable carrying the shared-secret credential. Its name is what
#: :meth:`GatewaySettings.enforce_bind_policy` reports when the credential is
#: missing for a non-loopback bind (R12.2).
AUTH_TOKEN_ENV_VAR = "ZOC_STUDIO_GATEWAY_TOKEN"

#: Environment variable overriding the bind host (defaults to ``127.0.0.1``).
HOST_ENV_VAR = "ZOC_STUDIO_GATEWAY_HOST"

#: Environment variable overriding the bind port (``0`` ⇒ OS-assigned).
PORT_ENV_VAR = "ZOC_STUDIO_GATEWAY_PORT"

#: Host strings treated as the loopback interface (R12.1/R12.4).
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})


class GatewayConfigError(ValueError):
    """Raised when the Gateway is misconfigured and must refuse to start.

    Used by :meth:`GatewaySettings.enforce_bind_policy` to reject a non-loopback
    bind that lacks an authentication credential; the message names the missing
    credential so the operator knows exactly what to set (R12.2).
    """


class GatewaySettings(BaseModel):
    """Where the Gateway binds and how requests are admitted (R12).

    Attributes:
        host: Bind interface. Defaults to the loopback address ``127.0.0.1``
            (R12.1). Any of :data:`LOOPBACK_HOSTS` is considered loopback.
        port: Bind port. ``0`` (the default) requests an OS-assigned port.
        auth_token: Optional shared-secret credential. Required when ``host`` is
            non-loopback; see :meth:`enforce_bind_policy`.
    """

    model_config = ConfigDict(extra="forbid")

    host: str = "127.0.0.1"
    port: int = Field(default=0, ge=0, le=65535)
    auth_token: str | None = None

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "GatewaySettings":
        """Build settings from environment variables (falling back to defaults).

        Reads :data:`HOST_ENV_VAR`, :data:`PORT_ENV_VAR`, and
        :data:`AUTH_TOKEN_ENV_VAR`. An unset or empty host/port falls back to the
        field default; an unset or empty auth token leaves the credential
        ``None`` so :meth:`enforce_bind_policy` can flag it for a non-loopback
        bind.

        Args:
            env: Mapping to read from; defaults to :data:`os.environ`.
        """
        source = os.environ if env is None else env

        defaults = cls()

        host = source.get(HOST_ENV_VAR)
        port = source.get(PORT_ENV_VAR)
        token = source.get(AUTH_TOKEN_ENV_VAR)

        return cls(
            host=host if host else defaults.host,
            port=int(port) if port else defaults.port,
            auth_token=token if token else defaults.auth_token,
        )

    def is_loopback(self) -> bool:
        """Return whether ``host`` binds the loopback interface (R12.1/R12.4)."""
        return self.host in LOOPBACK_HOSTS

    def enforce_bind_policy(self) -> None:
        """Refuse a non-loopback bind that lacks a credential (R12.2).

        Raises:
            GatewayConfigError: When ``host`` is non-loopback and ``auth_token``
                is unset. The message names :data:`AUTH_TOKEN_ENV_VAR`, the
                missing credential, so the operator knows what to configure.
        """
        if not self.is_loopback() and not self.auth_token:
            raise GatewayConfigError(
                f"non-loopback bind to {self.host!r} requires an authentication "
                f"credential; set {AUTH_TOKEN_ENV_VAR}"
            )
