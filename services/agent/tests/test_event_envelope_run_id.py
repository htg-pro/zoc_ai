"""Unit tests for the extended AgentEvent envelope (optional ``run_id``).

Spec: chat-memory-session-system, Task 1.2.

Task 1.1 added ``run_id: str | None = None`` to ``AgentEventBase`` so every
event subclass inherits an optional run id. These tests pin that:

  1. ``AgentEventBase`` (and a subclass, ``MessageEvent``) default ``run_id``
     to ``None``.
  2. ``model_dump`` serializes ``run_id`` and the value round-trips through
     ``model_validate`` (both when absent/None and when explicitly set).

Requirements: 1.2, 1.7
"""

from __future__ import annotations

from uuid import uuid4

from shared_schema.models import AgentEventBase, Message, MessageEvent, MessageRole


def test_base_defaults_run_id_to_none() -> None:
    event = AgentEventBase(session_id=uuid4(), seq=1)
    assert event.run_id is None


def test_subclass_defaults_run_id_to_none() -> None:
    msg = Message(role=MessageRole.user, content="hi")
    event = MessageEvent(session_id=uuid4(), seq=1, message=msg)
    assert event.run_id is None


def test_model_dump_includes_run_id_and_round_trips_when_none() -> None:
    session_id = uuid4()
    event = MessageEvent(
        session_id=session_id,
        seq=5,
        message=Message(role=MessageRole.user, content="hello"),
    )

    dumped = event.model_dump(mode="json")
    # The field is present in the serialized payload, defaulting to None.
    assert "run_id" in dumped
    assert dumped["run_id"] is None

    restored = MessageEvent.model_validate(dumped)
    assert restored.run_id is None
    assert restored == event


def test_model_dump_round_trips_explicit_run_id() -> None:
    session_id = uuid4()
    event = MessageEvent(
        session_id=session_id,
        seq=6,
        run_id="R2",
        message=Message(role=MessageRole.assistant, content="ok"),
    )

    dumped = event.model_dump(mode="json")
    assert dumped["run_id"] == "R2"

    restored = MessageEvent.model_validate(dumped)
    assert restored.run_id == "R2"
    assert restored == event


def test_base_model_dump_round_trips_explicit_run_id() -> None:
    event = AgentEventBase(session_id=uuid4(), seq=9, run_id="R7")

    restored = AgentEventBase.model_validate(event.model_dump(mode="json"))
    assert restored.run_id == "R7"
    assert restored == event
