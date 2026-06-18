"""Smoke test for the default loopback bind and the documented no-auth constraint (task 6.7).

Feature: zoc-agent-ecosystem-merge

**Validates: Requirements 12.1, 12.5**

A lightweight smoke test (not a property test) pinning two facts the rest of the
R12 security posture depends on:

1. **Default loopback bind (R12.1).** A freshly constructed ``GatewaySettings()``
   — with no environment overrides — binds to the loopback interface. We assert
   both the concrete default host (``127.0.0.1``) and that
   :meth:`GatewaySettings.is_loopback` agrees it is loopback.

2. **Documented no-auth constraint (R12.5).** The Gateway ``README.md`` records
   that loopback-bound endpoints accept requests without authentication as a
   known, intentional security constraint, and names the credential
   (``ZOC_STUDIO_GATEWAY_TOKEN``) that gates any wider exposure. We assert the
   README contains that security note so the constraint cannot silently vanish
   from the docs.

The server is never started — these are direct assertions only.
"""

from __future__ import annotations

from pathlib import Path

from zocai_gateway.settings import GatewaySettings

#: The gateway README lives one parent up from the tests directory:
#: ``services/gateway/tests/<this file>`` → ``services/gateway/README.md``.
README_PATH = Path(__file__).resolve().parents[1] / "README.md"


def test_default_settings_bind_to_loopback() -> None:
    """Default ``GatewaySettings()`` binds the loopback interface (R12.1)."""
    settings = GatewaySettings()

    assert settings.host == "127.0.0.1"
    assert settings.is_loopback() is True


def test_readme_documents_loopback_no_auth_constraint() -> None:
    """The README documents the loopback no-auth security constraint (R12.5)."""
    assert README_PATH.is_file(), f"expected gateway README at {README_PATH}"

    readme = README_PATH.read_text(encoding="utf-8").lower()

    # The README must call out a Security note that ties the loopback interface
    # to the absence of authentication, and name the credential env var that
    # gates any non-loopback exposure.
    assert "security" in readme
    assert "loopback" in readme
    assert "authentication" in readme
    assert "zoc_studio_gateway_token" in readme
