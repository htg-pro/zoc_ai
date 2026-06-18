"""End-to-end gateway integration tests (task 14.1).

Drive the running gateway over its real HTTP surface: an Agent run streams the
ordered structured events (intent → … → done) over the SSE bus and is mirrored
to the Session_Diary (R6.5, R9.3), the diary recovery endpoint replays them
(R10.2), and an Ask run streams text-only (R6.6).
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from zocai_gateway.app import create_app


def _data_events(raw: str) -> list[dict[str, object]]:
    """Parse the ``data:`` JSON payloads out of an SSE response body."""
    out: list[dict[str, object]] = []
    for line in raw.splitlines():
        if line.startswith("data:"):
            blob = line[len("data:") :].strip()
            if blob:
                out.append(json.loads(blob))
    return out


def _drain_events(client: TestClient, run_id: str) -> list[dict[str, object]]:
    with client.stream("GET", "/v1/agent/events", params={"runId": run_id}) as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        body = "".join(resp.iter_text())
    return _data_events(body)


def test_agent_run_streams_ordered_events_and_mirrors_diary(tmp_path: Path) -> None:
    app = create_app(workspace_root=tmp_path)
    with TestClient(app) as client:
        run_id = client.post(
            "/v1/agent/run", json={"prompt": "build the thing", "mode": "agent"}
        ).json()["runId"]

        events = _drain_events(client, run_id)

        # R1.9 + R6.5: intent first, done last, strictly increasing seq.
        assert events[0]["type"] == "intent"
        assert events[0]["modelTier"] == "local-slm"
        assert events[-1]["type"] == "done"
        seqs = [int(e["seq"]) for e in events]  # type: ignore[call-overload]
        assert seqs == sorted(seqs)

        # R9.3 + R10.2: the events were mirrored to the diary and replay here.
        diary = client.get("/v1/agent/diary", params={"runId": run_id}).json()
        assert [e["type"] for e in diary] == [e["type"] for e in events]

    # R9.1/R9.2: the .zocai/ session diary store was created and written.
    assert (tmp_path / ".zocai" / "session_diary.jsonl").is_file()


def test_ask_run_streams_text_only(tmp_path: Path) -> None:
    app = create_app(workspace_root=tmp_path)
    with TestClient(app) as client:
        run_id = client.post(
            "/v1/agent/run", json={"prompt": "explain the design", "mode": "ask"}
        ).json()["runId"]

        events = _drain_events(client, run_id)

        # R6.6: Ask Mode is text-only — only raw token frames, no structured rows.
        assert events
        assert all(e["type"] == "token" for e in events)
        assert "explain the design" in "".join(str(e["text"]) for e in events)


def test_diary_endpoint_empty_without_workspace() -> None:
    # Without a workspace-backed diary, recovery returns an empty feed.
    with TestClient(create_app()) as client:
        assert client.get("/v1/agent/diary").json() == []
