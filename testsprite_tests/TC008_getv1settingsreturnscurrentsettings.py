import requests

BASE_URL = "http://127.0.0.1:36941"
TIMEOUT = 30

def test_get_v1_settings_returns_current_settings():
    url = f"{BASE_URL}/v1/settings"
    try:
        response = requests.get(url, timeout=TIMEOUT)
    except requests.RequestException as e:
        assert False, f"Request to {url} failed with exception: {e}"

    assert response.status_code == 200, f"Expected status 200 but got {response.status_code}"

    try:
        data = response.json()
    except ValueError:
        assert False, "Response is not valid JSON"

    assert isinstance(data, dict), "Response JSON should be a dictionary"
    assert data, "Response JSON should not be empty"


test_get_v1_settings_returns_current_settings()