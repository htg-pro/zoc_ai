import requests
import json

BASE_URL = "http://127.0.0.1:36941"
TIMEOUT = 30
HEADERS = {
    "Content-Type": "application/json"
}

def test_post_v1_sessions_creates_new_session():
    url = f"{BASE_URL}/v1/sessions"
    # Send an empty JSON object as payload (empty body) with Content-Type header
    try:
        response = requests.post(url, headers=HEADERS, data=json.dumps({}), timeout=TIMEOUT)
    except requests.RequestException as e:
        assert False, f"Request to create session failed: {e}"
    assert response.status_code == 200, f"Expected status code 200, got {response.status_code}"
    json_resp = response.json()
    assert isinstance(json_resp, dict), f"Response JSON is not a dict: {json_resp}"
    assert "session_id" in json_resp, f"Response JSON missing 'session_id' field: {json_resp}"
    session_id = json_resp["session_id"]
    assert isinstance(session_id, str), f"'session_id' is not a string: {session_id}"
    assert len(session_id) > 0, "'session_id' is empty"

    # Additional validation: confirm the new session appears in the sessions list
    list_url = f"{BASE_URL}/v1/sessions"
    try:
        list_resp = requests.get(list_url, headers=HEADERS, timeout=TIMEOUT)
    except requests.RequestException as e:
        assert False, f"Request to list sessions failed: {e}"
    assert list_resp.status_code == 200, f"Expected 200 from sessions list, got {list_resp.status_code}"
    sessions_list = list_resp.json()
    assert isinstance(sessions_list, list), f"Sessions list response is not a list: {sessions_list}"
    session_ids = [s.get("session_id") or s.get("id") or s for s in sessions_list]
    assert session_id in session_ids, f"Newly created session_id not found in sessions list: {session_id}"

    # Cleanup: close the session to avoid leftover state
    close_url = f"{BASE_URL}/v1/sessions/{session_id}/close"
    try:
        close_resp = requests.post(close_url, headers=HEADERS, timeout=TIMEOUT)
        # Session close may succeed or fail depending on backend state; no assert on close response code
    except requests.RequestException:
        pass

test_post_v1_sessions_creates_new_session()