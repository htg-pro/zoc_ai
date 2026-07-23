"""Feature: editor-diagnostics-completions, Property 16: The endpoint invokes the
model only for admitted requests.

**Validates: Requirements 15.2, 15.3, 15.5**

Drives the real ``POST /v1/completions`` route via ``TestClient`` over the full
admission input space (loopback / non-loopback binding × absent / invalid /
valid credential), with the streaming core replaced by a spy so "the model was
reached" is observable. A request is admitted iff the binding is loopback or the
presented credential is valid; a non-admitted request is rejected (401) and the
spy is never invoked.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from unittest import mock

from fastapi.testclient import TestClient
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st
from zocai_gateway.app import create_app
from zocai_gateway.settings import LOOPBACK_HOSTS, GatewaySettings

_loopback_hosts = st.sampled_from(sorted(LOOPBACK_HOSTS))
_non_loopback_hosts = st.sampled_from(["0.0.0.0", "10.0.0.5", "192.168.1.10", "example.com"])
# Header-safe printable ASCII: a credential is sent as an HTTP header value.
_header_safe = st.text(
    alphabet=st.characters(min_codepoint=0x21, max_codepoint=0x7E), max_size=24
)
_configured_tokens = st.one_of(st.none(), st.just(""), _header_safe.filter(lambda s: len(s) >= 1))

_VALID_BODY = {
    "prefix": "a",
    "suffix": "b",
    "language": "python",
    "filePath": "/f.py",
    "provider": "p",
    "model": "m",
}


@st.composite
def _admission_inputs(draw: st.DrawFn) -> tuple[GatewaySettings, str | None]:
    host = draw(st.one_of(_loopback_hosts, _non_loopback_hosts))
    token = draw(_configured_tokens)
    settings_obj = GatewaySettings(host=host, port=0, auth_token=token)
    wrong = draw(_header_safe.filter(lambda s: s != (token or "")))
    presented = draw(st.one_of(st.none(), st.just(wrong), st.just(token if token else wrong)))
    return settings_obj, presented


@settings(max_examples=100, suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(_admission_inputs())
def test_property_16_model_invoked_only_when_admitted(
    case: tuple[GatewaySettings, str | None],
) -> None:
    settings_obj, presented = case
    calls = {"n": 0}

    async def spy_stream(req, *, cache) -> AsyncIterator[dict[str, str]]:
        calls["n"] += 1
        yield {"event": "done", "data": "{}"}

    token = settings_obj.auth_token
    credential_valid = bool(token) and presented == token
    expected_admitted = settings_obj.is_loopback() or credential_valid

    with mock.patch("zocai_gateway.app.stream_completion_events", spy_stream):
        app = create_app(settings=settings_obj)
        with TestClient(app) as client:
            headers = {"X-Zoc-Studio-Token": presented} if presented is not None else {}
            resp = client.post("/v1/completions", json=_VALID_BODY, headers=headers)

    if expected_admitted:
        assert resp.status_code == 200
        assert calls["n"] == 1  # R15.3: admitted → the model path is reached.
    else:
        # R15.2/R15.5: not admitted → rejected, and the model is never invoked.
        assert resp.status_code == 401
        assert calls["n"] == 0
