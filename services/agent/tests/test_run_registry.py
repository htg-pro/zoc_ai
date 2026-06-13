"""Per-session live-run registry used by the approval resolve/reconcile path."""

from __future__ import annotations

from uuid import uuid4

import pytest
from llama_studio_agent.runs import RunRegistry


def test_inactive_by_default():
    reg = RunRegistry()
    assert reg.is_active(uuid4()) is False


def test_register_unregister_round_trip():
    reg = RunRegistry()
    sid = uuid4()
    reg.register(sid)
    assert reg.is_active(sid) is True
    reg.unregister(sid)
    assert reg.is_active(sid) is False


def test_overlapping_runs_count_independently():
    # A retry issued while another run winds down: the first teardown must
    # not clear the second's liveness.
    reg = RunRegistry()
    sid = uuid4()
    reg.register(sid)
    reg.register(sid)
    reg.unregister(sid)
    assert reg.is_active(sid) is True
    reg.unregister(sid)
    assert reg.is_active(sid) is False


def test_unregister_below_zero_is_safe():
    reg = RunRegistry()
    sid = uuid4()
    reg.unregister(sid)  # no-op, must not raise or go negative
    assert reg.is_active(sid) is False


def test_track_context_manager_releases_on_exception():
    reg = RunRegistry()
    sid = uuid4()
    with pytest.raises(RuntimeError), reg.track(sid):
        assert reg.is_active(sid) is True
        raise RuntimeError("boom")
    assert reg.is_active(sid) is False
