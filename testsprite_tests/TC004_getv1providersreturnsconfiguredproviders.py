import requests

BASE_URL = "http://127.0.0.1:36941"
TIMEOUT = 30

def test_get_v1_providers_returns_configured_providers():
    url = f"{BASE_URL}/v1/providers"
    try:
        response = requests.get(url, timeout=TIMEOUT)
        response.raise_for_status()
    except requests.RequestException as e:
        assert False, f"HTTP request to GET /v1/providers failed: {e}"

    assert response.status_code == 200, f"Expected status code 200, got {response.status_code}"

    try:
        json_data = response.json()
    except ValueError:
        assert False, "Response is not valid JSON"

    # Validate the response contains a list (or dict) of providers - expecting a JSON object or array
    # As schema not fully specified, just assert keys or type
    # For example, expecting a list or dict (configurable providers)
    assert isinstance(json_data, (list, dict)), f"Expected JSON response to be list or dict, got {type(json_data)}"
    # Further assertion if keys known
    if isinstance(json_data, dict):
        # Possibly expecting a 'providers' key or similar, but not specified in PRD
        # so just check it has at least one key or empty dict allowed
        pass
    elif isinstance(json_data, list):
        # Each item should be a dict presumably
        for item in json_data:
            assert isinstance(item, dict), f"Each provider entry should be a dict, got {type(item)}"

test_get_v1_providers_returns_configured_providers()