"""Message_Part contract tests — zoc-agent-chat-rebuild R7.1, R7.2, R7.7, R7.9.

Feature: zoc-agent-chat-rebuild

Exercises `shared_schema.message_parts` the way both consumers do: a camelCase
wire payload in through `MessagePartModel`, the concrete typed part out, and a
camelCase payload back. The three named model validators get a case each,
because each of them refuses a payload a provider or adapter can realistically
produce — a plan naming one file twice, a failure state with no code, and a
citation against a source the list never yielded.

Requirements: 7.1, 7.2, 7.7, 7.9, 7.10, 7.11, 10.10, 10.11, 10.14, 12.8,
12.10, 13.10, 24.1
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, get_args

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shared_schema.message_parts import (
    ABSENT_DIGEST,
    Capability,
    CompactionPart,
    ConversationMode,
    DiffPart,
    ErrorPart,
    HunkAction,
    MessagePart,
    MessagePartModel,
    PartType,
    PermissionRequestPart,
    PlanFile,
    PlanPart,
    ReasoningPart,
    RunLifecyclePart,
    RunState,
    SourceKind,
    SourcePart,
    TextPart,
    ToolErrorPart,
    ToolInputPart,
    ToolKind,
    ToolOutputPart,
    UsagePart,
)

BASE: dict[str, Any] = {
    "seq": 1,
    "runId": "run_01HZ",
    "messageId": "msg_01HZ",
    "ts": "2025-01-01T00:00:00.000Z",
}


def part(**fields: Any) -> dict[str, Any]:
    """A wire payload: the common `PartBase` keys plus this part's own."""
    return {**BASE, **fields}


def carries(expected: Any, actual: Any) -> bool:
    """True when `actual` carries every key and value `expected` declares.

    A nested model dumps its unset optionals as null, so a strict equality
    check would fail on a payload that simply omitted them. Lists still have to
    match in length and order, because part order is the contract (R7.7).
    """
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(
            key in actual and carries(value, actual[key]) for key, value in expected.items()
        )
    if isinstance(expected, list):
        return (
            isinstance(actual, list)
            and len(expected) == len(actual)
            and all(carries(e, a) for e, a in zip(expected, actual, strict=True))
        )
    return bool(expected == actual)


def wire_keys(dumped: Any) -> set[str]:
    """Every key anywhere in a dumped payload, nested models included."""
    if isinstance(dumped, dict):
        keys = set(dumped)
        for value in dumped.values():
            keys |= wire_keys(value)
        return keys
    if isinstance(dumped, list):
        return {key for item in dumped for key in wire_keys(item)}
    return set()


# ── One representative payload per discriminant (R7.1, R7.9) ──────────────

TEXT = part(type="text", partId="txt_1", delta="Hello", done=False)

REASONING = part(type="reasoning", partId="rsn_1", delta="Considering…", elapsedMs=1200)

TOOL_INPUT = part(
    type="tool-input",
    toolCallId="call_1",
    toolName="workspace_read",
    kind="read",
    inputDelta='{"path":"src/a.ts"}',
    done=True,
)

TOOL_OUTPUT = part(
    type="tool-output",
    toolCallId="call_1",
    durationMs=42,
    summary="Read src/a.ts",
    output="export const a = 1;\n",
    readPaths=["src/a.ts"],
)

TOOL_ERROR = part(
    type="tool-error",
    toolCallId="call_2",
    durationMs=7,
    code="workspace_unavailable",
    message="The workspace service is restarting.",
    retryable=True,
)

PLAN = part(
    type="plan",
    planId="plan_1",
    title="Extract the mention parser",
    files=[
        {
            "path": "src/features/chat/composer/mention-query.ts",
            "action": "create",
            "rationale": "New home for the parser.",
            "addedLines": 64,
            "removedLines": 0,
            "hunkCount": 1,
        },
        {
            "path": "src/lib/mentions.ts",
            "action": "rename",
            "sourcePath": "src/lib/context-mentions.ts",
            "rationale": "Name the module for what it does.",
            "addedLines": 0,
            "removedLines": 0,
            "hunkCount": 0,
        },
        {
            "path": "src/lib/old-parser.ts",
            "action": "delete",
            "rationale": "Superseded.",
            "addedLines": 0,
            "removedLines": 31,
            "hunkCount": 1,
        },
        {
            "path": "src/lib/store.ts",
            "action": "modify",
            "rationale": "Repoint the import.",
            "addedLines": 2,
            "removedLines": 2,
            "hunkCount": 1,
        },
    ],
    verificationCommand="pnpm typecheck",
)

DIFF = part(
    type="diff",
    planId="plan_1",
    path="src/features/chat/composer/mention-query.ts",
    action="create",
    hunks=[
        {
            "hunkId": "hunk_1",
            "oldStart": 1,
            "oldLines": 0,
            "newStart": 1,
            "newLines": 2,
            "patch": "+export const AT = '@';\n+export default AT;\n",
        }
    ],
    baseDigest=ABSENT_DIGEST,
)

PERMISSION_REQUEST = part(
    type="permission-request",
    requestId="req_1",
    toolCallId="call_3",
    toolName="workspace_run_command",
    kind="execute",
    prompt="Run `pnpm test` in the workspace root?",
    paths=["package.json"],
    reason="mode-ask",
    expiresAt="2025-01-01T00:10:00.000Z",
)

RUN_LIFECYCLE = part(type="run-lifecycle", state="awaiting-approval")

USAGE = part(
    type="usage",
    inputTokens=4096,
    outputTokens=512,
    reasoningTokens=128,
    cachedInputTokens=2048,
    contextLimit=131_072,
    estimatedCostCents=1.75,
    tokensPerSecond=48.5,
    messagesInContext=12,
    sessionMessageCount=47,
    messagesOutOfWindow=31,
    summaryActive=True,
)

ERROR = part(
    type="error",
    code="provider_unavailable",
    message="The provider is not answering right now.",
    retryable=True,
)

SOURCE = part(
    type="source",
    sources=[
        {"sourceId": "src_1", "kind": "url", "url": "https://example.test/a", "title": "A"},
        {"sourceId": "src_2", "kind": "document", "mediaType": "application/pdf", "title": "B"},
    ],
    citations=[{"sourceId": "src_2", "partId": "txt_1", "start": 0, "end": 5, "quote": "Hello"}],
    toolName="web_search",
)

COMPACTION = part(
    type="compaction",
    compactionId="cmp_1",
    foldedMessageIds=["msg_01", "msg_02", "msg_03"],
    foldedTurnCount=2,
    contextTokensBefore=112_000,
    contextTokensAfter=18_400,
    summary="The user asked for a mention parser; it was extracted and typechecked.",
)

REPRESENTATIVE: list[tuple[str, dict[str, Any], type]] = [
    ("text", TEXT, TextPart),
    ("reasoning", REASONING, ReasoningPart),
    ("tool-input", TOOL_INPUT, ToolInputPart),
    ("tool-output", TOOL_OUTPUT, ToolOutputPart),
    ("tool-error", TOOL_ERROR, ToolErrorPart),
    ("plan", PLAN, PlanPart),
    ("diff", DIFF, DiffPart),
    ("permission-request", PERMISSION_REQUEST, PermissionRequestPart),
    ("run-lifecycle", RUN_LIFECYCLE, RunLifecyclePart),
    ("usage", USAGE, UsagePart),
    ("error", ERROR, ErrorPart),
    ("source", SOURCE, SourcePart),
    ("compaction", COMPACTION, CompactionPart),
]


@pytest.mark.parametrize(("discriminant", "payload", "model"), REPRESENTATIVE, ids=lambda v: v)
def test_each_discriminant_routes_to_its_model(
    discriminant: str, payload: dict[str, Any], model: type
) -> None:
    """R7.1: the union is the validation entrypoint for every part kind."""
    validated = MessagePartModel.model_validate(payload).root
    assert isinstance(validated, model)
    assert validated.type == discriminant
    assert validated.seq == 1
    assert validated.run_id == "run_01HZ"
    assert validated.agent_name is None  # null through all of M1


@pytest.mark.parametrize(("discriminant", "payload", "model"), REPRESENTATIVE, ids=lambda v: v)
def test_wire_payloads_round_trip_in_camel_case(
    discriminant: str, payload: dict[str, Any], model: type
) -> None:
    """R7.2: the wire keys the surface reads are the wire keys it was sent.

    Every key in the dump is a camelCase alias — a snake_case key reaching the
    wire is the drift this convention exists to prevent — and re-validating the
    dump yields the same part, so the contract is a fixed point.
    """
    validated = MessagePartModel.model_validate(payload)
    dumped = validated.model_dump(by_alias=True)

    assert sorted(key for key in wire_keys(dumped) if "_" in key) == []
    assert carries(payload, dumped)
    assert MessagePartModel.model_validate(dumped).root == validated.root


def test_part_type_alias_matches_the_union_exactly() -> None:
    """R7.9: `PartType` is the surface's discriminant list, so it cannot drift."""
    union_members = get_args(get_args(MessagePart)[0])
    from_models = {get_args(m.model_fields["type"].annotation)[0] for m in union_members}
    assert from_models == set(get_args(PartType))
    assert len(union_members) == 13


def test_snake_case_attribute_names_are_accepted() -> None:
    """`populate_by_name=True`, matching `agent_events.py`."""
    validated = TextPart.model_validate(
        {
            "seq": 2,
            "run_id": "run_01HZ",
            "message_id": "msg_01HZ",
            "ts": BASE["ts"],
            "type": "text",
            "part_id": "txt_1",
            "delta": "Hi",
        }
    )
    assert validated.part_id == "txt_1"
    assert validated.model_dump(by_alias=True)["partId"] == "txt_1"


def test_an_unknown_key_is_refused() -> None:
    """`extra="forbid"`: a part carrying a field the contract never declared."""
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        MessagePartModel.model_validate({**TEXT, "surprise": True})


def test_seq_starts_at_one() -> None:
    """R7.7: the allocator starts at 1, so 0 is out of contract."""
    with pytest.raises(ValidationError):
        MessagePartModel.model_validate({**TEXT, "seq": 0})


# ── The shared enums (R10.10, R10.11, R32) ────────────────────────────────


def test_shared_enums_carry_exactly_their_declared_values() -> None:
    """The Capability_Policy and the surface both key off these."""
    assert "awaiting-approval" in get_args(RunState)
    assert set(get_args(HunkAction)) == {"create", "modify", "delete", "rename"}
    assert set(get_args(SourceKind)) == {"url", "document"}
    assert set(get_args(Capability)) == {"read", "write", "execute"}
    assert set(get_args(ConversationMode)) == {"ask", "plan", "agent"}
    assert set(get_args(ToolKind)) == {"read", "write", "execute", "search", "network", "mcp"}


def test_plan_and_diff_carry_both_ends_of_a_rename() -> None:
    """R10.14: a rename keeps its origin, so the review can say the file moved."""
    plan = PlanPart.model_validate(PLAN)
    renamed = next(f for f in plan.files if f.action == "rename")
    assert renamed.source_path == "src/lib/context-mentions.ts"
    assert renamed.path == "src/lib/mentions.ts"

    diff = DiffPart.model_validate(
        {**DIFF, "action": "rename", "sourcePath": "src/lib/old.ts", "hunks": []}
    )
    assert diff.source_path == "src/lib/old.ts"


def test_a_rename_without_its_origin_is_refused() -> None:
    """R10.14 again, from the other side: one path and a lost origin."""
    with pytest.raises(ValidationError, match="sourcePath"):
        PlanFile.model_validate(
            {
                "path": "src/b.ts",
                "action": "rename",
                "rationale": "Moved.",
                "addedLines": 0,
                "removedLines": 0,
                "hunkCount": 0,
            }
        )


def test_plan_file_actions_cover_the_four_workspace_actions() -> None:
    """R10.11: the action letter the plan card renders in its fixed-width slot."""
    plan = PlanPart.model_validate(PLAN)
    assert {f.action for f in plan.files} == set(get_args(HunkAction))


# ── UsagePart: accounting, Token_Rate, context census ─────────────────────


def test_usage_carries_the_full_accounting_shape() -> None:
    """R13.10, R12.8, R12.10: eleven fields, and the census rides with the limit."""
    usage = UsagePart.model_validate(USAGE)
    assert (usage.input_tokens, usage.output_tokens) == (4096, 512)
    assert (usage.reasoning_tokens, usage.cached_input_tokens) == (128, 2048)
    assert usage.context_limit == 131_072
    assert usage.estimated_cost_cents == 1.75
    assert usage.tokens_per_second == 48.5
    assert usage.messages_in_context == 12
    assert usage.session_message_count == 47
    assert usage.messages_out_of_window == 31
    assert usage.summary_active is True


def test_a_run_with_no_output_tokens_reports_no_rate() -> None:
    """R13.10: null, not zero — zero tokens per second is a false claim."""
    usage = UsagePart.model_validate(
        part(type="usage", inputTokens=100, outputTokens=0, contextLimit=8192)
    )
    assert usage.tokens_per_second is None
    assert "tokensPerSecond" not in usage.model_dump(by_alias=True, exclude_defaults=True)


# ── The three named model validators ──────────────────────────────────────


def test_plan_files_are_unique_by_path() -> None:
    """Validator 1: two entries for one file leave the review ambiguous."""
    duplicated = {**PLAN, "files": [PLAN["files"][0], {**PLAN["files"][0], "rationale": "Again."}]}
    with pytest.raises(ValidationError, match="unique by path"):
        MessagePartModel.model_validate(duplicated)


@pytest.mark.parametrize("state", ["failed", "interrupted"])
def test_failure_lifecycle_states_carry_a_code(state: str) -> None:
    """Validator 2: an error row with no code has nothing to offer retry against."""
    with pytest.raises(ValidationError, match="requires a code"):
        MessagePartModel.model_validate(part(type="run-lifecycle", state=state))

    accepted = MessagePartModel.model_validate(
        part(type="run-lifecycle", state=state, code="stream_lost")
    ).root
    assert isinstance(accepted, RunLifecyclePart)
    assert accepted.code == "stream_lost"


def test_non_failure_states_need_no_code() -> None:
    for state in ("queued", "running", "awaiting-approval", "completed", "cancelled"):
        assert MessagePartModel.model_validate(part(type="run-lifecycle", state=state))


def test_citations_name_known_sources() -> None:
    """Validator 3: the realistic adapter bug — a span against a chunk index
    the source list never yielded."""
    dangling = {
        **SOURCE,
        "citations": [{"sourceId": "src_99", "partId": "txt_1", "start": 0, "end": 5}],
    }
    with pytest.raises(ValidationError, match="unlisted sources"):
        MessagePartModel.model_validate(dangling)


def test_a_consulted_source_needs_no_citation() -> None:
    """R7.10: `sources` and `citations` are separately addressable."""
    source = SourcePart.model_validate({**SOURCE, "citations": []})
    assert [s.source_id for s in source.sources] == ["src_1", "src_2"]
    assert source.citations == []


def test_a_compaction_must_reduce_the_context() -> None:
    with pytest.raises(ValidationError, match="must not increase"):
        MessagePartModel.model_validate({**COMPACTION, "contextTokensAfter": 200_000})
    with pytest.raises(ValidationError, match="at least one message"):
        MessagePartModel.model_validate({**COMPACTION, "foldedMessageIds": []})


def test_a_citation_span_is_ordered() -> None:
    with pytest.raises(ValidationError, match="must not precede start"):
        MessagePartModel.model_validate(
            {
                **SOURCE,
                "citations": [{"sourceId": "src_1", "partId": "txt_1", "start": 9, "end": 4}],
            }
        )


def test_reasoning_can_be_redacted_with_a_duration_only() -> None:
    """R8.4: a provider that will not return its reasoning still reports elapsed time."""
    redacted = ReasoningPart.model_validate({**REASONING, "delta": "", "redacted": True})
    assert redacted.redacted is True
    assert redacted.elapsed_ms == 1200


def test_tool_error_retryability_is_explicit() -> None:
    """R6.6: the surface offers retry from this flag alone."""
    assert ToolErrorPart.model_validate(TOOL_ERROR).retryable is True
    assert ToolErrorPart.model_validate({**TOOL_ERROR, "retryable": False}).retryable is False


def test_tool_output_separates_read_and_written_paths() -> None:
    """R9.4: the timeline names every affected path, by direction."""
    output = ToolOutputPart.model_validate(TOOL_OUTPUT)
    assert output.read_paths == ["src/a.ts"]
    assert output.written_paths == []


def test_tool_input_defaults_to_no_mcp_server() -> None:
    assert ToolInputPart.model_validate(TOOL_INPUT).mcp_server is None


def test_permission_request_offers_all_three_scopes_by_default() -> None:
    """R11.7: call, run, and workspace are what the dock renders as chips."""
    request = PermissionRequestPart.model_validate(PERMISSION_REQUEST)
    assert request.offered_scopes == ["call", "run", "workspace"]
    assert request.decision is None
    assert request.decided_scope is None
