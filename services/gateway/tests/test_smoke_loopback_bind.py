"""Smoke test for the default loopback bind and the documented no-auth constraint (task 6.7).

Feature: zoc-agent-ecosystem-merge

**Validates: Requirements 12.1, 12.5**

This is a lightweight smoke test (not a property test) that pins two facts the
rest of the R12 security posture relies on:

1. **Default loopback bind (R12.1).** A freshly constructed ``GatewaySettings()``
   — with no environment overrides — binds to the loopback interface. We assert
   both the concrete default host (``127.0.0.1``) and that
   :meth:`GatewaySettings.is_loopback` agrees it is loopback.

2. **Documented no-auth constraint (R12.5).** The Gateway ``README.md`` records
   that loopback-bound endpoints accept requests without authentication as a
   known, intentional security constraint. We assert the README file contains
   the documented Security / loopback-no-auth text so the constraint can never
   silently disappear from the docs.
"""

from __future__ import annotations

from pathlib import Path

from zocai_gateway.settings import GatewaySettings

#: The gateway README lives two parents up from this test file:
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

    readme = README_PATH.read_text(encoding="utf-8")

    # A Security section must exist and call out the loopback no-auth posture as
    # a known/intentional constraint, naming the loopback interface explicitly.
    assert "## Security" in readme
    assert "loopback" in readme.lower()
    assert "127.0.0.1" in readme
    assert "without any authentication" in readme.lower()
    assert "known" in readme.lower() and "intentional" in readme.lower()
