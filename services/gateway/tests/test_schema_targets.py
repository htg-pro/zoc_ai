"""Schema-target tests for the run-stream contract additions (task 1.4).

Feature: zoc-ai-agent-chat-overhaul.

Two ``DoneEvent`` classes with the same ``type: Literal["done"]`` literal make a
wrong-file edit type-check, so this asserts the *target* explicitly: the new
fields must land on the run-stream contract (``shared_schema.agent_events``) —
the union ``EmitGate`` validates every SSE frame against — and must be absent
from the session/legacy union (``shared_schema.models``). It also asserts the
generated TypeScript mirror is in sync (``pnpm schema:check`` drift).

**Validates: Requirements 8.7, 11.5**
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

from shared_schema import agent_events, models

_REPO_ROOT = Path(__file__).resolve().parents[3]
_GENERATE_TS = _REPO_ROOT / "packages" / "shared-types" / "scripts" / "generate_ts.py"


def test_files_changed_on_agent_events_done_frame_only() -> None:
    """``files_changed`` lands on the run-stream ``DoneEvent`` (R8.7), not models.py."""
    assert "files_changed" in agent_events.DoneEvent.model_fields
    # The session/legacy DoneEvent carries ``summary`` instead and is untouched.
    assert "files_changed" not in models.DoneEvent.model_fields
    assert "summary" in models.DoneEvent.model_fields
    # The wire alias is camelCase so the TS mirror reads ``filesChanged``.
    assert agent_events.DoneEvent.model_fields["files_changed"].alias == "filesChanged"


def test_done_frame_files_changed_defaults_to_zero() -> None:
    """The count defaults to zero so an unchanged run reports it cleanly (R8.7/R8.8)."""
    done = agent_events.DoneEvent(seq=0, run_id="r", ts="2024-01-01T00:00:00Z", ok=True)
    assert done.files_changed == 0


def test_operation_on_approval_event_only() -> None:
    """``operation`` lands on ``ApprovalEvent`` (R11.5), not the legacy ToolCallEvent."""
    assert "operation" in agent_events.ApprovalEvent.model_fields
    assert "operation" not in models.ToolCallEvent.model_fields


def test_base_hash_on_edit_file_event() -> None:
    """``base_hash`` lands on the run-stream ``EditFileEvent`` for stale detection (R12.7)."""
    assert "base_hash" in agent_events.EditFileEvent.model_fields
    assert agent_events.EditFileEvent.model_fields["base_hash"].alias == "baseHash"


def test_stage_event_is_a_run_stream_contract_member() -> None:
    """The new ``StageEvent`` exists and carries stage/state/reason (R7.1-R7.4)."""
    fields = agent_events.StageEvent.model_fields
    assert {"stage", "state", "reason"} <= set(fields)
    assert "stage" in agent_events.EventType.__args__


def test_generated_typescript_has_no_drift() -> None:
    """``pnpm schema:check`` reports no drift after the contract additions (task 1.1)."""
    spec = importlib.util.spec_from_file_location("_generate_ts_for_test", _GENERATE_TS)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # generate_ts.py inserts the shared-types python package onto sys.path itself.
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
        assert module.check_drift() is True
    finally:
        sys.modules.pop(spec.name, None)
