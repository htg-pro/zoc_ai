from __future__ import annotations

import pytest
from pydantic import ValidationError

from shared_schema.agent_events import AgentEventModel


TS = "2024-01-01T00:00:00Z"


def test_plan_plan_update_review_and_enriched_command_validate() -> None:
    payloads = [
        {
            "type": "plan",
            "seq": 1,
            "runId": "run",
            "ts": TS,
            "checkpointId": "cp-1",
            "items": [{"id": "apply", "label": "Apply edits", "status": "active"}],
        },
        {
            "type": "plan-update",
            "seq": 2,
            "runId": "run",
            "ts": TS,
            "id": "apply",
            "status": "done",
        },
        {
            "type": "command",
            "seq": 3,
            "runId": "run",
            "ts": TS,
            "command": "pnpm test",
            "commandId": "checks",
            "status": "pass",
            "exitCode": 0,
            "outputDelta": "ok",
            "outputTail": "ok",
        },
        {
            "type": "review",
            "seq": 4,
            "runId": "run",
            "ts": TS,
            "checkpointId": "cp-1",
            "files": [
                {
                    "path": "src/App.tsx",
                    "diff": "@@ -1 +1 @@\n-old\n+new",
                    "adds": 1,
                    "dels": 1,
                }
            ],
            "validation": {
                "typecheck": {"status": "pass"},
                "build": {"status": "skipped"},
                "tests": {"status": "skipped"},
            },
        },
    ]

    for payload in payloads:
        AgentEventModel.model_validate(payload)


def test_budget_event_validates_with_camel_case_wire_fields() -> None:
    event = AgentEventModel.model_validate(
        {
            "type": "budget",
            "seq": 5,
            "runId": "run",
            "ts": TS,
            "tokensUsed": 3200,
            "tokenLimit": 4000,
            "iterations": 4,
            "recoveries": 1,
        }
    ).root

    assert event.type == "budget"
    assert event.tokens_used == 3200
    assert event.token_limit == 4000


def test_test_results_event_validates_with_counts_and_output() -> None:
    event = AgentEventModel.model_validate(
        {
            "type": "test-results",
            "seq": 6,
            "runId": "run",
            "ts": TS,
            "status": "fail",
            "command": "pnpm test",
            "source": "package.json",
            "passed": 7,
            "failed": 2,
            "exitCode": 1,
            "outputTail": "2 failed",
            "durationMs": 1200,
            "timedOut": False,
        }
    ).root

    assert event.type == "test-results"
    assert event.passed == 7
    assert event.failed == 2


def test_recovery_attempt_event_validates_failures() -> None:
    event = AgentEventModel.model_validate(
        {
            "type": "recovery-attempt",
            "seq": 7,
            "runId": "run",
            "ts": TS,
            "attempt": 2,
            "failures": ["tests/test_api.py::test_create"],
        }
    ).root

    assert event.type == "recovery-attempt"
    assert event.attempt == 2


def test_plan_update_rejects_unknown_status() -> None:
    with pytest.raises(ValidationError):
        AgentEventModel.model_validate(
            {
                "type": "plan-update",
                "seq": 1,
                "runId": "run",
                "ts": TS,
                "id": "apply",
                "status": "blocked",
            }
        )
