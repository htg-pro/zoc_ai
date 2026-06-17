import requests

BASE_URL = "http://127.0.0.1:36941"
TIMEOUT = 30


def test_post_v1_terminal_opens_session_and_returns_id():
    url = f"{BASE_URL}/v1/terminal"
    try:
        response = requests.post(url, timeout=TIMEOUT)
        response.raise_for_status()

        json_data = response.json()
        assert "terminal_id" in json_data, "Response JSON does not contain terminal_id"
        terminal_id = json_data["terminal_id"]
        assert isinstance(terminal_id, str) and terminal_id, "terminal_id should be a non-empty string"

    except requests.RequestException as e:
        assert False, f"Request failed: {e}"


test_post_v1_terminal_opens_session_and_returns_id()
