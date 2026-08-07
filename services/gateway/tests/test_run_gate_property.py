"""Property + example tests for the run-start gates (zoc-ai-agent-chat-overhaul).

Feature: zoc-ai-agent-chat-overhaul, Property 2, Property 9, Property 30 and the
mode-by-mode run-gate examples (tasks 6.2, 6.5, 6.6, 20.3).
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st
from zocai_gateway.app import SessionRegistry, create_app
from zocai_gateway.errors import ErrorCode
from zocai_gateway.mode_router import Mode
from zocai_gateway.run_pipeline import DefaultAgentBrain
from zocai_gateway.workspace_binder import NoWorkspaceError, WorkspaceBinder
from zocai_gateway.workspace_context import resolve_terminal_cwd, workspace_context_from_path

_HEALTH = [HealthCheck.function_scoped_fixture]


# ── Property 9: a run cannot be created without a ready model ────────────────


@settings(max_examples=100, deadline=None, suppress_health_check=_HEALTH)
@given(
    provider=st.sampled_from(["", "openai", "llamacpp"]),
    model=st.sampled_from(["", "gpt-4o", "qwen"]),
    base_url=st.sampled_from(["", "http://127.0.0.1:8080"]),
)
def test_run_refused_without_a_ready_model(provider: str, model: str, base_url: str) -> None:
    """Property 9: a run with no ready model is refused and creates no run record.

    Feature: zoc-ai-agent-chat-overhaul, Property 9

    **Validates: Requirements 5.2**
    """
    # Live path (no injected brain) so the readiness gate applies; Ask mode so
    # the workspace gate never confounds the readiness verdict (R1.7). Inject a
    # healthy probe so this test isolates the *structural* gate (the live-probe
    # rejection is covered separately below).
    app = create_app(drive=False, model_health_probe=lambda _base: True)
    client = TestClient(app)
    registry = app.state.run_registry
    before = registry.count()

    payload: dict[str, object] = {"prompt": "explain", "mode": "ask"}
    if provider:
        payload["provider"] = provider
    if model:
        payload["model"] = model
    if base_url:
        payload["baseUrl"] = base_url

    # A structurally-ready request needs a provider+model and, for an
    # endpoint-backed provider, a base_url (anthropic aside).
    ready = bool(provider and model and base_url)
    resp = client.post("/v1/agent/run", json=payload)

    if ready:
        assert resp.status_code == 200
    else:
        assert resp.status_code == 409
        assert resp.json()["detail"]["code"] == ErrorCode.MODEL_NOT_READY
        # R5.2: the run registry is unchanged when the request is refused.
        assert registry.count() == before


# ── Property 2 + 6.6: the no-workspace decision ─────────────────────────────


def _dir_set(base: Path) -> set[str]:
    return {str(p) for p in base.rglob("*") if p.is_dir()}


@settings(max_examples=100, deadline=None, suppress_health_check=_HEALTH)
@given(mode=st.sampled_from(list(Mode)), requested=st.sampled_from([None, "sub", "../escape"]))
def test_no_workspace_refuses_writes_admits_ask_creates_nothing(
    mode: Mode, requested: str | None, tmp_path_factory: pytest.TempPathFactory
) -> None:
    """Property 2: no-workspace refuses writes, admits Ask, and creates nothing.

    Feature: zoc-ai-agent-chat-overhaul, Property 2

    **Validates: Requirements 1.3, 1.4, 1.7, 1.8**
    """
    base = tmp_path_factory.mktemp("no_ws")
    before_dirs = _dir_set(base)

    # Terminal cwd with no workspace: always a refusal carrying no_workspace,
    # never a fabricated directory (R1.3, R1.8).
    decision = resolve_terminal_cwd(requested, None)
    assert decision.cwd is None
    assert decision.code == ErrorCode.NO_WORKSPACE

    # Run-start per mode with no workspace resolved (isolated binder): Ask is
    # accepted, Plan/Agent are refused with no_workspace (R1.4, R1.7).
    app = create_app(drive=False, brain=DefaultAgentBrain())
    client = TestClient(app)
    resp = client.post("/v1/agent/run", json={"prompt": "do it", "mode": mode.value})
    if mode is Mode.ASK:
        assert resp.status_code == 200
    else:
        assert resp.status_code == 409
        assert resp.json()["detail"]["code"] == ErrorCode.NO_WORKSPACE

    # Across every outcome, no directory was created anywhere under the base.
    assert _dir_set(base) == before_dirs


def test_mode_by_mode_run_gate_examples(tmp_path: Path) -> None:
    """6.6: ask starts with no root; plan/agent are refused; nothing is created.

    **Validates: Requirements 1.4, 1.7**
    """
    app = create_app(drive=False, brain=DefaultAgentBrain())
    client = TestClient(app)
    before = _dir_set(tmp_path)

    ask = client.post("/v1/agent/run", json={"prompt": "q", "mode": "ask"})
    assert ask.status_code == 200

    for mode in ("plan", "agent"):
        refused = client.post("/v1/agent/run", json={"prompt": "q", "mode": mode})
        assert refused.status_code == 409
        assert refused.json()["detail"]["code"] == ErrorCode.NO_WORKSPACE

    assert _dir_set(tmp_path) == before


# ── Property 30: sessions are bound to the resolved workspace ────────────────


@settings(max_examples=100, deadline=None, suppress_health_check=_HEALTH)
@given(advisory=st.sampled_from(["/tmp/somewhere-else", "relative/path", "."]))
def test_session_bound_to_resolved_root(
    advisory: str, tmp_path_factory: pytest.TempPathFactory
) -> None:
    """Property 30: a created session's root equals the resolved root (R15.1).

    Feature: zoc-ai-agent-chat-overhaul, Property 30

    **Validates: Requirements 15.1, 15.2**
    """
    from shared_schema.models import CreateSessionRequest

    root = tmp_path_factory.mktemp("session_ws")
    binder = WorkspaceBinder(override=root, env={})
    registry = SessionRegistry()
    req = CreateSessionRequest(title="s", workspace_root=advisory)
    session = registry.create(req, binder=binder)
    # The resolved root wins; the advisory request root is ignored (R15.1/R15.2).
    assert session.workspace_root == str(root.resolve())


def test_session_creation_refused_without_workspace() -> None:
    """Property 30: no resolved workspace ⇒ creation refused, no placeholder (R15.2)."""
    from shared_schema.models import CreateSessionRequest

    binder = WorkspaceBinder(override=None, config_path=Path("/nonexistent/desktop.json"), env={})
    registry = SessionRegistry()
    with pytest.raises(NoWorkspaceError):
        registry.create(CreateSessionRequest(title="s", workspace_root="/tmp/x"), binder=binder)
    assert registry.list() == []


def test_session_creation_over_http_refused_without_workspace() -> None:
    """R15.2: the /v1/sessions route maps the refusal to a typed no_workspace 409."""
    client = TestClient(create_app(drive=False))
    resp = client.post("/v1/sessions", json={"title": "s", "workspace_root": "/tmp/x"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == ErrorCode.NO_WORKSPACE


def test_session_creation_over_http_binds_resolved_root(tmp_path: Path) -> None:
    """R15.1: with a workspace bound, the session's root is the resolved root."""
    client = TestClient(create_app(drive=False, workspace_root=tmp_path))
    resp = client.post("/v1/sessions", json={"title": "s", "workspace_root": "/somewhere/else"})
    assert resp.status_code == 201
    assert resp.json()["workspace_root"] == str(tmp_path.resolve())


def test_workspace_context_confirms_none_terminal_decision() -> None:
    """A resolved workspace admits an inside cwd; the check is the binder's (R1.3)."""
    ctx = workspace_context_from_path(str(Path(__file__).resolve().parent))
    assert ctx is not None
    decision = resolve_terminal_cwd(None, ctx)
    assert decision.cwd == str(ctx.root)
