"""Integration test for the SSE telemetry endpoint streaming (task 7.9).

Focused coverage of ``GET /v1/agent/events`` as an SSE bus (R6.1): the endpoint
responds as ``text/event-stream`` and, for an Agent run driven end to end, the
structured contract events stream over the bus in FSM production order
(``intent`` … ``done`` with strictly increasing ``seq``). These assertions
complement ``test_app_integration.py`` by checking the SSE wire framing itself —
that every frame's ``event:`` name matches its ``data:`` payload discriminator —
rather than only the decoded payload sequence.

_Requirements: 6.1_
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient
from zocai_gateway.app import create_app
from zocai_gateway.run_pipeline import DefaultAgentBrain


def _parse_sse_frames(raw: str) -> list[tuple[str, dict[str, object]]]:
    """Parse ``(event-name, data-payload)`` pairs out of an SSE response body.

    Frames are blank-line separated; within a frame an ``event:`` line names the
    event and a ``data:`` line carries the JSON payload. ``ping`` keep-alive
    frames carry no JSON body and are skipped.
    """
    frames: list[tuple[str, dict[str, object]]] = []
    event_name: str | None = None
    for line in raw.splitlines():
        if line.startswith("event:"):
            event_name = line[len("event:") :].strip()
        elif line.startswith("data:"):
            blob = line[len("data:") :].strip()
            if blob:
                frames.append((event_name or "message", json.loads(blob)))
            event_name = None
    return frames


def test_events_endpoint_is_event_stream_and_streams_in_order(tmp_path: Path) -> None:
    """R6.1: events endpoint is ``text/event-stream`` and streams ordered frames.

    Drives an Agent run, subscribes to its SSE bus, and asserts the content type
    plus that the structured frames arrive in FSM production order — ``intent``
    first, ``done`` last, ``seq`` strictly increasing — with each SSE ``event:``
    name matching its ``data:`` payload's discriminator.
    """
    app = create_app(workspace_root=tmp_path, brain=DefaultAgentBrain())
    with TestClient(app) as client:
        run_id = client.post(
            "/v1/agent/run",
            json={"prompt": "build the thing", "mode": "agent"},
        ).json()["runId"]

        with client.stream(
            "GET", "/v1/agent/events", params={"runId": run_id}
        ) as resp:
            assert resp.status_code == 200
            # R6.1: the bus is delivered as Server-Sent Events.
            assert resp.headers["content-type"].startswith("text/event-stream")
            body = "".join(resp.iter_text())

    frames = _parse_sse_frames(body)
    assert frames, "expected at least one SSE data frame"

    # SSE framing: every frame's `event:` name equals its payload discriminator.
    for event_name, payload in frames:
        assert event_name == payload["type"]

    payloads = [payload for _, payload in frames]

    # R6.5: ordered end to end — intent leads, done terminates the stream.
    assert payloads[0]["type"] == "intent"
    assert payloads[-1]["type"] == "done"

    # R6.5: emission order equals production order — seq strictly increasing.
    seqs = [int(p["seq"]) for p in payloads]  # type: ignore[call-overload]
    assert seqs == sorted(seqs)
    assert len(set(seqs)) == len(seqs)


def test_events_endpoint_event_stream_without_run() -> None:
    """R6.1: the endpoint always opens a well-formed ``text/event-stream``.

    With no/unknown ``runId`` the bus still opens as Server-Sent Events and
    closes cleanly, so a subscriber always sees a valid stream.
    """
    with TestClient(create_app()) as client, client.stream("GET", "/v1/agent/events") as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        # Drains to completion without hanging.
        body = "".join(resp.iter_text())
    assert "event: ping" in body or "event:ping" in body
