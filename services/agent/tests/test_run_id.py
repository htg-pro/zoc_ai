"""Integration tests for run_id minting and stamping.

Spec: chat-memory-session-system, Task 11.3.

Task 11.1 made ``run_agent`` mint ``run_id = payload.run_id or uuid4().hex``
for every run and return it in the JSON response (``RunAgentRequest`` gained a
``run_id`` field aliased ``runId``). Task 11.2 made the orchestrator's ``_emit``
stamp that ``run_id`` onto every emitted event while ``EventBus.next_seq``
remains the sole monotonic ``seq`` source.

These tests pin the end-to-end contract:

  1. ``POST /agent/run`` returns a non-empty ``run_id`` (and echoes a
     client-supplied ``runId`` when one is provided).
  2. Every event streamed for that run carries the same ``run_id``.
  3. ``seq`` is strictly monotonic across the streamed events.

Requirements: 1.2, 1.7
"""

from __future__ import annotations

import json

from llama_studio_agent.providers.mock import MockResponse


def _queue_run(mock_provider) -> None:
    """Queue a minimal planner + answer script for one agent run."""
    mock_provider.reset()
    mock_provider.queue(
        MockResponse(text='{"goal":"g","steps":[{"title":"a"}]}'),
        MockResponse(text="hello"),
    )


def _parse_sse(raw: str) -> list[tuple[str, dict]]:
    """Parse a raw SSE text stream into ``(event_type, payload)`` records.

    Each record may carry an optional ``id:`` line, then an ``event:`` line and
    a ``data:`` line. Comment-only heartbeat blocks (``: keepalive``) are
    skipped.
    """
    records: list[tuple[str, dict]] = []
    for block in raw.split("\n\n"):
        block = block.strip("\n")
        if not block:
            continue
        lines = block.split("\n")
        idx = 0
        if lines[idx].startswith("id:"):
            idx += 1
        if idx >= len(lines) or not lines[idx].startswith("event:"):
            # Heartbeat comment or partial frame — ignore.
            continue
        if idx + 1 >= len(lines) or not lines[idx + 1].startswith("data:"):
            continue
        event_type = lines[idx][len("event:") :].strip()
        payload = json.loads(lines[idx + 1][len("data:") :].strip())
        records.append((event_type, payload))
    return records


def _collect_run_events(client, session_id) -> list[tuple[str, dict]]:
    """Replay the persisted SSE history for ``session_id`` until ``done``.

    The run has already completed synchronously, so its terminal ``done``
    event is in the replayed history; we stop reading there instead of
    blocking on the live (heartbeat) subscription.
    """
    raw = ""
    with client.stream(
        "GET", f"/v1/sessions/{session_id}/agent/events", params={"since_seq": 0}
    ) as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        for line in resp.iter_lines():
            raw += line + "\n"
            if line.startswith("event: done"):
                # Drain the data line that follows this terminal event.
                continue
            if raw.rstrip().endswith("}") and "event: done" in raw:
                break
    return _parse_sse(raw)


def test_run_returns_non_empty_run_id(client, session, mock_provider):
    _queue_run(mock_provider)
    r = client.post(
        f"/v1/sessions/{session.id}/agent/run",
        json={"prompt": "hi", "max_repair_attempts": 0},
    )
    assert r.status_code == 200, r.text
    run_id = r.json()["run_id"]
    assert isinstance(run_id, str) and run_id


def test_run_echoes_client_supplied_run_id(client, session, mock_provider):
    _queue_run(mock_provider)
    r = client.post(
        f"/v1/sessions/{session.id}/agent/run",
        json={"prompt": "hi", "runId": "client-run-123", "max_repair_attempts": 0},
    )
    assert r.status_code == 200, r.text
    assert r.json()["run_id"] == "client-run-123"


def test_streamed_events_carry_run_id_and_monotonic_seq(client, session, mock_provider):
    _queue_run(mock_provider)
    r = client.post(
        f"/v1/sessions/{session.id}/agent/run",
        json={"prompt": "hi", "runId": "run-abc", "max_repair_attempts": 0},
    )
    assert r.status_code == 200, r.text
    run_id = r.json()["run_id"]
    assert run_id == "run-abc"

    events = _collect_run_events(client, session.id)
    assert events, "no events were streamed for the run"

    # (2) Every event streamed for this run carries the same run_id.
    assert all(payload.get("run_id") == run_id for _, payload in events), [
        (t, payload.get("run_id")) for t, payload in events
    ]

    # The run's lifecycle is bracketed by a terminal done event.
    assert any(t == "done" for t, _ in events)

    # (3) seq is strictly monotonic across the streamed events.
    seqs = [payload["seq"] for _, payload in events]
    assert all(b > a for a, b in zip(seqs, seqs[1:])), seqs
