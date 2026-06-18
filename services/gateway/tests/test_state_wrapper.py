"""Unit tests for the Tier 2 ``State_Wrapper`` store (task 9.3, R9.5 + R9.6).

These example-based tests exercise the serialize/deserialize round-trip, the
model-agnostic schema guard (no tier-specific fields), compilation-log
truncation, and the atomic on-disk store. The dedicated property test for
"state serialization round-trips and is model-agnostic" lives in task 9.7
(Property 39).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from zocai_gateway.memory import (
    LOG_MAX_CHARS,
    SCHEMA_KEYS,
    SCHEMA_VERSION,
    Diff,
    FailureRecord,
    StateWrapper,
    StateWrapperError,
    StateWrapperStore,
)
from zocai_gateway.stages import Stage


def _sample_wrapper() -> StateWrapper:
    return StateWrapper(
        stage=Stage.PLAN_EDITS,
        active_file_markers=["src/a.py", "src/b.py"],
        patch_diffs=[
            Diff(path="src/a.py", diff="@@ -1 +1 @@\n-old\n+new\n"),
            Diff(path="src/b.py", diff="@@ -2 +2 @@\n-foo\n+bar\n"),
        ],
        compilation_logs=[
            FailureRecord(command="pytest", exit_code=1, log="assertion failed"),
        ],
    )


# ── round-trip (R9.5) ─────────────────────────────────────────────────────────


def test_dict_round_trip_preserves_state() -> None:
    wrapper = _sample_wrapper()
    assert StateWrapper.from_dict(wrapper.to_dict()) == wrapper


def test_json_round_trip_preserves_state() -> None:
    wrapper = _sample_wrapper()
    assert StateWrapper.from_json(wrapper.to_json()) == wrapper


def test_empty_wrapper_round_trips() -> None:
    wrapper = StateWrapper(stage=Stage.INTAKE)
    restored = StateWrapper.from_json(wrapper.to_json())
    assert restored == wrapper
    assert restored.active_file_markers == []
    assert restored.patch_diffs == []
    assert restored.compilation_logs == []


@pytest.mark.parametrize("stage", list(Stage))
def test_every_stage_round_trips(stage: Stage) -> None:
    wrapper = StateWrapper(stage=stage)
    assert StateWrapper.from_json(wrapper.to_json()).stage is stage


def test_serialization_is_deterministic() -> None:
    wrapper = _sample_wrapper()
    assert wrapper.to_json() == wrapper.to_json()


# ── model-agnostic schema (R9.6) ──────────────────────────────────────────────


def test_serialized_keys_are_exactly_the_schema_keys() -> None:
    payload = json.loads(_sample_wrapper().to_json())
    assert set(payload.keys()) == SCHEMA_KEYS


def test_schema_has_no_tier_specific_fields() -> None:
    payload = json.loads(_sample_wrapper().to_json())
    text = _sample_wrapper().to_json().lower()
    # No key — and no serialized content key — names a model tier / context.
    forbidden = ("tier", "model", "context_window", "model_id", "device")
    assert not any(any(f in key.lower() for f in forbidden) for key in payload)
    for f in forbidden:
        assert f not in {k.lower() for k in payload}
    assert "schema_version" in text  # sanity: real content is present


def test_unexpected_top_level_field_is_rejected() -> None:
    payload = _sample_wrapper().to_dict()
    payload["model_tier"] = "edge"  # a tier-specific field must be refused
    with pytest.raises(StateWrapperError, match="unexpected state wrapper field"):
        StateWrapper.from_dict(payload)


def test_unknown_stage_is_rejected() -> None:
    payload = _sample_wrapper().to_dict()
    payload["stage"] = "not_a_real_stage"
    with pytest.raises(StateWrapperError, match="unknown FSM stage"):
        StateWrapper.from_dict(payload)


def test_unsupported_schema_version_is_rejected() -> None:
    payload = _sample_wrapper().to_dict()
    payload["schema_version"] = SCHEMA_VERSION + 1
    with pytest.raises(StateWrapperError, match="schema_version"):
        StateWrapper.from_dict(payload)


def test_invalid_json_is_rejected() -> None:
    with pytest.raises(StateWrapperError, match="not valid JSON"):
        StateWrapper.from_json("{not json")


# ── compilation-log truncation (design "Run State") ───────────────────────────


def test_failure_record_log_is_truncated_at_construction() -> None:
    record = FailureRecord(command="cc", exit_code=2, log="x" * (LOG_MAX_CHARS + 100))
    assert len(record.log) == LOG_MAX_CHARS


def test_truncated_log_round_trips_exactly() -> None:
    wrapper = StateWrapper(
        stage=Stage.RUN_CHECKS,
        compilation_logs=[FailureRecord("cc", 2, "y" * (LOG_MAX_CHARS * 2))],
    )
    assert StateWrapper.from_json(wrapper.to_json()) == wrapper


def test_failure_record_rejects_bool_exit_code() -> None:
    with pytest.raises(StateWrapperError, match="exit_code"):
        FailureRecord.from_dict({"command": "cc", "exit_code": True, "log": ""})


# ── on-disk store ─────────────────────────────────────────────────────────────


def test_store_save_then_load_round_trips(tmp_path: Path) -> None:
    store = StateWrapperStore(tmp_path / "cross_model_bus" / "state_wrapper.json")
    wrapper = _sample_wrapper()
    store.save(wrapper)
    assert store.exists()
    assert store.load() == wrapper


def test_store_save_creates_parent_directories(tmp_path: Path) -> None:
    path = tmp_path / "nested" / "cross_model_bus" / "state_wrapper.json"
    store = StateWrapperStore(path)
    assert store.exists() is False
    store.save(StateWrapper(stage=Stage.INTAKE))
    assert path.is_file()


def test_store_save_is_atomic_and_overwrites(tmp_path: Path) -> None:
    path = tmp_path / "state_wrapper.json"
    store = StateWrapperStore(path)
    store.save(StateWrapper(stage=Stage.INTAKE))
    store.save(StateWrapper(stage=Stage.SUMMARY))
    # No temp file is left behind, and the latest write wins.
    assert list(path.parent.iterdir()) == [path]
    assert store.load().stage is Stage.SUMMARY


def test_store_load_missing_file_raises(tmp_path: Path) -> None:
    store = StateWrapperStore(tmp_path / "absent.json")
    with pytest.raises(StateWrapperError, match="no state wrapper"):
        store.load()


def test_store_integrates_with_memory_matrix(tmp_path: Path) -> None:
    from zocai_gateway.memory import MemoryMatrix

    matrix = MemoryMatrix(tmp_path)
    matrix.initialize()
    store = StateWrapperStore(matrix.state_wrapper_path)
    wrapper = _sample_wrapper()
    store.save(wrapper)
    assert store.load() == wrapper
