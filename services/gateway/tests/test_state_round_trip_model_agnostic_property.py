"""Property test for State_Wrapper round-trip + model-agnosticism (task 9.7).

Feature: zocai-ecosystem-rebuild, Property 39: State serialization round-trips
and is model-agnostic.

**Validates: Requirements 9.5, 9.6, 11.1, 11.5**

Design Property 39 (verbatim intent): *For any* run state, serializing it to the
State_Wrapper and deserializing it preserves the FSM stage, active file markers,
patch diffs, and compilation logs, and the wrapper schema contains no
tier-specific fields.

The (de)serialization under test lives in
:class:`zocai_gateway.memory.state_wrapper.StateWrapper` (``to_json`` /
``from_json``) and the on-disk :class:`StateWrapperStore`. This property is
exercised against the real types (no mocks) over arbitrary run states —
arbitrary FSM ``stage``, ``active_file_markers``, ``patch_diffs``, and
``compilation_logs`` — asserting two things:

* **Round-trip (R9.5 / R11.1 / R11.5).** ``from_json(to_json(w)) == w`` for
  every representable wrapper, both in-memory and through the atomic on-disk
  store, so a replacement model rebuilds the exact recorded run state.
* **Model-agnostic (R9.6).** The serialized document's top-level keys are
  exactly :data:`SCHEMA_KEYS` — no Model_Tier, context-window, or other
  model-bound field ever appears.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from zocai_gateway.memory import (
    LOG_MAX_CHARS,
    SCHEMA_KEYS,
    Diff,
    FailureRecord,
    StateWrapper,
    StateWrapperStore,
)
from zocai_gateway.stages import Stage

# Any FSM stage is a representable run state (R3.1/R11.5).
_STAGE = st.sampled_from(list(Stage))

# Arbitrary file markers, patch diffs, and compilation logs. Log sizes span the
# truncation cap so the round-trip is checked at and beyond the boundary; the
# in-memory wrapper already holds the truncated value, so equality stays exact.
_MARKERS = st.lists(st.text(max_size=64), max_size=8)
_DIFFS = st.lists(
    st.builds(Diff, path=st.text(max_size=64), diff=st.text(max_size=256)),
    max_size=6,
)
_LOGS = st.lists(
    st.builds(
        FailureRecord,
        command=st.text(max_size=64),
        exit_code=st.integers(min_value=-(2**31), max_value=2**31 - 1),
        log=st.text(max_size=LOG_MAX_CHARS + 128),
    ),
    max_size=4,
)


@st.composite
def _wrappers(draw: st.DrawFn) -> StateWrapper:
    """Build an arbitrary, representable :class:`StateWrapper` run state."""
    return StateWrapper(
        stage=draw(_STAGE),
        active_file_markers=draw(_MARKERS),
        patch_diffs=draw(_DIFFS),
        compilation_logs=draw(_LOGS),
    )


@settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
@given(wrapper=_wrappers())
def test_state_round_trips_and_is_model_agnostic(wrapper: StateWrapper) -> None:
    """Property 39: round-trip preservation + model-agnostic schema.

    Feature: zocai-ecosystem-rebuild, Property 39

    **Validates: Requirements 9.5, 9.6, 11.1, 11.5**
    """
    text = wrapper.to_json()

    # Round-trip: deserializing the serialized wrapper reproduces it exactly,
    # so a replacement model resumes from the identical run state (R9.5/R11.1).
    restored = StateWrapper.from_json(text)
    assert restored == wrapper
    # The resumable slice is preserved field-by-field (R11.5).
    assert restored.stage == wrapper.stage
    assert restored.active_file_markers == wrapper.active_file_markers
    assert restored.patch_diffs == wrapper.patch_diffs
    assert restored.compilation_logs == wrapper.compilation_logs

    # Model-agnostic: the on-disk schema's top-level keys are *exactly* the
    # fixed schema set — no tier-specific / model-bound field leaks in (R9.6).
    payload = json.loads(text)
    assert set(payload.keys()) == set(SCHEMA_KEYS)


@settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
@given(wrapper=_wrappers())
def test_state_round_trips_through_atomic_store(wrapper: StateWrapper) -> None:
    """Property 39: the round-trip holds through the atomic on-disk store.

    Feature: zocai-ecosystem-rebuild, Property 39

    **Validates: Requirements 9.5, 11.1, 11.5**
    """
    # A fresh directory per example keeps the store writes independent.
    with tempfile.TemporaryDirectory() as base:
        store = StateWrapperStore(Path(base) / "cross_model_bus" / "state_wrapper.json")
        store.save(wrapper)
        assert store.exists()
        assert store.load() == wrapper
