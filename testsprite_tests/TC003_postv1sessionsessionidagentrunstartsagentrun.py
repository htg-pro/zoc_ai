import requests
import threading
import time

BASE_URL = "http://127.0.0.1:36941"
TIMEOUT = 30


def test_post_v1_sessions_sessionid_agent_run_starts_agent_run():
    headers = {"Content-Type": "application/json"}
    session_id = None

    # Helper to create a session
    def create_session():
        resp = requests.post(f"{BASE_URL}/v1/sessions", timeout=TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
        assert "session_id" in data and isinstance(data["session_id"], str)
        return data["session_id"]

    # Helper to delete (close) session (best effort cleanup)
    def close_session(session_id_):
        try:
            requests.post(f"{BASE_URL}/v1/sessions/{session_id_}/close", timeout=TIMEOUT)
        except Exception:
            pass

    # Helper to consume SSE events with timeout and limited event count
    def get_sse_events(url, timeout=10, max_events=5):
        events = []

        try:
            with requests.get(url, stream=True, timeout=timeout) as resp:
                resp.raise_for_status()
                # Read line by line, parse SSE data lines (starting with 'data: ')
                buffer = ""
                start_time = time.time()
                for line in resp.iter_lines(decode_unicode=True):
                    if line is None:
                        continue
                    line = line.strip()
                    if line == "":
                        # Blank line indicates dispatch of event, if buffer present
                        if buffer:
                            events.append(buffer)
                            buffer = ""
                            if len(events) >= max_events:
                                break
                        continue
                    if line.startswith("data:"):
                        # accumulate data lines
                        data_line = line[len("data:"):].strip()
                        if buffer:
                            buffer += "\n" + data_line
                        else:
                            buffer = data_line
                    # Check time limit
                    if time.time() - start_time > timeout:
                        break
                # Capture any pending buffered event
                if buffer:
                    events.append(buffer)
        except requests.exceptions.RequestException:
            pass
        return events

    # Start test
    try:
        session_id = create_session()

        # Start the agent run with prompt and mode="agent"
        run_payload = {
            "prompt": "Run a test agent task",
            "mode": "agent"
        }
        run_resp = requests.post(
            f"{BASE_URL}/v1/sessions/{session_id}/agent/run",
            json=run_payload,
            headers=headers,
            timeout=TIMEOUT,
        )
        run_resp.raise_for_status()
        assert run_resp.status_code == 200

        # After starting the agent run, get SSE events
        events_url = f"{BASE_URL}/v1/sessions/{session_id}/agent/events"
        events = get_sse_events(events_url, timeout=15, max_events=10)

        # Assert that we received some events related to the agent run lifecycle
        # Check for presence of expected event types in received SSE event data strings:
        # run.started, todo_update, tool_call, checkpoint.created, diff.ready, run.awaiting_review

        event_markers = [
            "run.started",
            "todo_update",
            "tool_call",
            "checkpoint.created",
            "diff.ready",
            "run.awaiting_review",
        ]
        # At minimum, expect "run.started" event and some others
        assert any("run.started" in e for e in events), "Missing run.started event"

        # Optionally check if any of the other typical events appear
        assert any(
            any(marker in e for marker in event_markers) for e in events
        ), "No expected SSE agent run events found"

    finally:
        if session_id:
            close_session(session_id)


test_post_v1_sessions_sessionid_agent_run_starts_agent_run()
