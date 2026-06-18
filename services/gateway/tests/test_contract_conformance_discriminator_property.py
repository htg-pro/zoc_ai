"""Property test for Agent-Mode contract conformance + valid discriminator (task 7.4).

Feature: zocai-ecosystem-rebuild, Property 26: Every Agent-Mode event conforms to
the contract with a valid discriminator.

**Validates: Requirements 6.2**

Design Property 26 (verbatim intent): *For any* event emitted in Agent Mode, the
payload validates against the Event_Contract and its ``type`` discriminator
matches exactly one of the eight defined row kinds.

Strategy
--------
We build Hypothesis strategies that generate *valid* instances of each of the
eight contract row kinds (intent, thinking, read-files, edit-file, command,
summary, approval, done) directly from the real ``shared_schema`` Pydantic
models — no mocks. Each generated model is dumped to its wire form and pushed
through the real :class:`EmitGate.emit` (the single Agent-Mode emission gate).

For every generated event the property asserts that:

* ``emit`` returns ``True`` — the payload conformed to the Event_Contract and
  was forwarded to the sink (R6.2),
* the gate recorded **no** contract violation,
* the forwarded wire payload carries a ``type`` discriminator that matches
  **exactly one** of the eight defined row kinds, and
* that discriminator equals the kind we generated.

Because the eight model strategies span every row kind, the property holds
*for any* Agent-Mode event, which is the universal claim of Property 26.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import get_args

from hypothesis import given, settings
from hypothesis import strategies as st

# The eight row kinds are derived from the contract's EventType Literal so the
# test stays in lock-step with the schema: exactly these are valid discriminators.
from shared_schema.agent_events import (
    ApprovalEvent,
    CommandEvent,
    DoneEvent,
    EditFileEvent,
    EventType,
    IntentEvent,
    ReadFileRef,
    ReadFilesEvent,
    SummaryEvent,
    ThinkingEvent,
)

from zocai_gateway.emit_gate import EmitGate

#: The eight and only valid discriminator values per the Event_Contract (R6.3).
EIGHT_ROW_KINDS: frozenset[str] = frozenset(get_args(EventType))


class _RecordingSink:
    """Captures forwarded wire events in call order for assertions."""

    def __init__(self) -> None:
        self.events: list[Mapping[str, object]] = []

    def __call__(self, event: Mapping[str, object]) -> None:
        self.events.append(event)


# ── Shared field strategies ─────────────────────────────────────────────────
_seqs = st.integers(min_value=0, max_value=1_000_000)
_run_ids = st.text(min_size=1, max_size=32)
_ts = st.just("2024-01-01T00:00:00Z")
_text = st.text(max_size=200)
_paths = st.text(min_size=1, max_size=80)
_model_tiers = st.sampled_from(["local-slm", "edge", "cloud"])


# NOTE: We map dicts of drawn values through each model's constructor rather
# than using ``st.builds(Model, ...)`` directly. The contract models declare a
# ``runId`` alias with ``populate_by_name``; ``st.builds`` introspects the model
# signature and would supply *both* the alias and the field name, which the
# ``extra="forbid"`` config rejects. Passing only field-name kwargs via ``.map``
# constructs a genuinely valid model instance with no alias/name conflict.
def _read_file_refs() -> st.SearchStrategy[ReadFileRef]:
    spans = st.one_of(
        st.none(),
        st.tuples(
            st.integers(min_value=0, max_value=10_000),
            st.integers(min_value=0, max_value=10_000),
        ),
    )
    return st.fixed_dictionaries({"path": _paths, "span": spans}).map(
        lambda d: ReadFileRef(**d)
    )


# ── One strategy per contract row kind, each yielding a valid model ──────────
def _intent_events() -> st.SearchStrategy[IntentEvent]:
    return st.fixed_dictionaries(
        {
            "seq": _seqs,
            "run_id": _run_ids,
            "ts": _ts,
            "text": _text,
            "model_tier": _model_tiers,
            "context_window_tokens": st.integers(min_value=1, max_value=1_000_000),
            "fallback_reason": st.one_of(st.none(), st.text(max_size=80)),
        }
    ).map(lambda d: IntentEvent(**d))


def _thinking_events() -> st.SearchStrategy[ThinkingEvent]:
    return st.fixed_dictionaries(
        {"seq": _seqs, "run_id": _run_ids, "ts": _ts, "text": _text}
    ).map(lambda d: ThinkingEvent(**d))


def _read_files_events() -> st.SearchStrategy[ReadFilesEvent]:
    return st.fixed_dictionaries(
        {
            "seq": _seqs,
            "run_id": _run_ids,
            "ts": _ts,
            "files": st.lists(_read_file_refs(), max_size=8),
        }
    ).map(lambda d: ReadFilesEvent(**d))


def _edit_file_events() -> st.SearchStrategy[EditFileEvent]:
    return st.fixed_dictionaries(
        {
            "seq": _seqs,
            "run_id": _run_ids,
            "ts": _ts,
            "path": _paths,
            "diff": st.text(max_size=400),
        }
    ).map(lambda d: EditFileEvent(**d))


def _command_events() -> st.SearchStrategy[CommandEvent]:
    return st.fixed_dictionaries(
        {
            "seq": _seqs,
            "run_id": _run_ids,
            "ts": _ts,
            "command": st.text(min_size=1, max_size=120),
            "exit_code": st.one_of(
                st.none(), st.integers(min_value=-256, max_value=256)
            ),
            "error_tag": st.one_of(st.none(), st.text(max_size=40)),
        }
    ).map(lambda d: CommandEvent(**d))


def _summary_events() -> st.SearchStrategy[SummaryEvent]:
    return st.fixed_dictionaries(
        {"seq": _seqs, "run_id": _run_ids, "ts": _ts, "text": _text}
    ).map(lambda d: SummaryEvent(**d))


def _approval_events() -> st.SearchStrategy[ApprovalEvent]:
    return st.fixed_dictionaries(
        {
            "seq": _seqs,
            "run_id": _run_ids,
            "ts": _ts,
            "prompt": st.text(min_size=1, max_size=120),
            "decision": st.sampled_from([None, "approve", "reject"]),
        }
    ).map(lambda d: ApprovalEvent(**d))


def _done_events() -> st.SearchStrategy[DoneEvent]:
    return st.fixed_dictionaries(
        {
            "seq": _seqs,
            "run_id": _run_ids,
            "ts": _ts,
            "ok": st.booleans(),
            "reason": st.one_of(st.none(), st.text(max_size=80)),
        }
    ).map(lambda d: DoneEvent(**d))


#: A valid instance of *any* of the eight row kinds — spans the whole contract.
ANY_AGENT_EVENT = st.one_of(
    _intent_events(),
    _thinking_events(),
    _read_files_events(),
    _edit_file_events(),
    _command_events(),
    _summary_events(),
    _approval_events(),
    _done_events(),
)


@settings(max_examples=200)
@given(event=ANY_AGENT_EVENT)
def test_agent_event_conforms_and_has_valid_discriminator(event: object) -> None:
    """Property 26: every Agent-Mode event conforms with a valid discriminator.

    Feature: zocai-ecosystem-rebuild, Property 26

    **Validates: Requirements 6.2**
    """
    sink = _RecordingSink()
    gate = EmitGate(sink=sink)

    # The producer hands the gate the model's wire form (camelCase aliases).
    payload = event.model_dump(by_alias=True)  # type: ignore[attr-defined]

    emitted = gate.emit(payload)

    # Conforms to the contract: forwarded, with no violation recorded (R6.2).
    assert emitted is True
    assert gate.violations == ()
    assert len(sink.events) == 1

    wire = sink.events[0]
    discriminator = wire["type"]

    # The discriminator matches exactly one of the eight defined row kinds.
    assert discriminator in EIGHT_ROW_KINDS
    matches = [k for k in EIGHT_ROW_KINDS if k == discriminator]
    assert len(matches) == 1

    # ...and it is exactly the kind we generated.
    assert discriminator == event.type  # type: ignore[attr-defined]


def test_contract_defines_exactly_eight_row_kinds() -> None:
    """Guard: the discriminator domain is exactly the eight contract kinds (R6.3)."""
    assert EIGHT_ROW_KINDS == frozenset(
        {
            "intent",
            "thinking",
            "read-files",
            "edit-file",
            "command",
            "summary",
            "approval",
            "done",
        }
    )
    assert len(EIGHT_ROW_KINDS) == 8
