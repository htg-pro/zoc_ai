"""Property test for Agent-Mode rendered-event contract conformance.

The generated strategy spans every member of the 12-kind rendered ``EventType``
domain (including plan, plan-update, map-files, and review). Each payload is
validated by the real EmitGate, and its discriminator must identify exactly one
rendered kind. Validated-only telemetry remains in AgentEvent but outside this
row-registry domain.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import get_args

from hypothesis import given, settings
from hypothesis import strategies as st

# The twelve row kinds are derived from the contract's EventType Literal so the
# test stays in lock-step with the schema: exactly these are valid discriminators.
from shared_schema.agent_events import (
    ApprovalEvent,
    CommandEvent,
    DoneEvent,
    EditFileEvent,
    EventType,
    IntentEvent,
    MapFilesEvent,
    PlanEvent,
    PlanItem,
    PlanUpdateEvent,
    ReadFileRef,
    ReadFilesEvent,
    ReviewEvent,
    ReviewFile,
    SummaryEvent,
    ThinkingEvent,
)
from zocai_gateway.emit_gate import EmitGate

#: The twelve and only valid discriminator values per the Event_Contract (R6.3).
RENDERED_ROW_KINDS: frozenset[str] = frozenset(get_args(EventType))


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


def _plan_events() -> st.SearchStrategy[PlanEvent]:
    items = st.lists(
        st.fixed_dictionaries(
            {
                "id": st.text(min_size=1, max_size=20),
                "label": _text,
                "status": st.sampled_from(["pending", "active", "done"]),
            }
        ).map(lambda d: PlanItem(**d)),
        max_size=6,
    )
    return st.fixed_dictionaries(
        {"seq": _seqs, "run_id": _run_ids, "ts": _ts, "items": items}
    ).map(lambda d: PlanEvent(**d))


def _plan_update_events() -> st.SearchStrategy[PlanUpdateEvent]:
    return st.fixed_dictionaries(
        {
            "seq": _seqs,
            "run_id": _run_ids,
            "ts": _ts,
            "id": st.text(min_size=1, max_size=20),
            "status": st.sampled_from(["pending", "active", "done"]),
        }
    ).map(lambda d: PlanUpdateEvent(**d))


def _map_files_events() -> st.SearchStrategy[MapFilesEvent]:
    return st.fixed_dictionaries(
        {
            "seq": _seqs,
            "run_id": _run_ids,
            "ts": _ts,
            "read_list": st.lists(_paths, max_size=8),
            "write_list": st.lists(_paths, max_size=12),
            "rationale": _text,
        }
    ).map(lambda d: MapFilesEvent(**d))


def _review_events() -> st.SearchStrategy[ReviewEvent]:
    files = st.lists(
        st.fixed_dictionaries(
            {"path": _paths, "diff": st.text(max_size=200)}
        ).map(lambda d: ReviewFile(**d)),
        max_size=6,
    )
    return st.fixed_dictionaries(
        {"seq": _seqs, "run_id": _run_ids, "ts": _ts, "files": files}
    ).map(lambda d: ReviewEvent(**d))


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


#: A valid instance of *any* of the twelve row kinds — spans the whole contract.
ANY_AGENT_EVENT = st.one_of(
    _intent_events(),
    _thinking_events(),
    _plan_events(),
    _plan_update_events(),
    _map_files_events(),
    _read_files_events(),
    _edit_file_events(),
    _command_events(),
    _review_events(),
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

    # The discriminator matches exactly one of the twelve defined row kinds.
    assert discriminator in RENDERED_ROW_KINDS
    matches = [k for k in RENDERED_ROW_KINDS if k == discriminator]
    assert len(matches) == 1

    # ...and it is exactly the kind we generated.
    assert discriminator == event.type  # type: ignore[attr-defined]


def test_contract_defines_exactly_twelve_rendered_row_kinds() -> None:
    """Guard: EventType is exactly the rendered row-registry domain."""
    assert frozenset(
        {
            "intent",
            "thinking",
            "plan",
            "plan-update",
            "map-files",
            "read-files",
            "edit-file",
            "command",
            "review",
            "summary",
            "approval",
            "done",
        }
    ) == RENDERED_ROW_KINDS
    assert len(RENDERED_ROW_KINDS) == 12
