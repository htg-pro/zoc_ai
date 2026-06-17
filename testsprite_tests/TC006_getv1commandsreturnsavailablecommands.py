import requests

BASE_URL = "http://127.0.0.1:36941"
TIMEOUT = 30

def test_get_v1_commands_returns_available_commands():
    url = f"{BASE_URL}/v1/commands"
    try:
        response = requests.get(url, timeout=TIMEOUT)
    except requests.RequestException as e:
        assert False, f"Request failed: {e}"

    assert response.status_code == 200, f"Expected status 200, got {response.status_code}"
    try:
        commands = response.json()
    except ValueError:
        assert False, "Response is not valid JSON"

    assert isinstance(commands, list), f"Expected a list of commands, got {type(commands)}"
    # Optionally check that each command is a dict with some expected keys
    if commands:
        assert all(isinstance(cmd, dict) for cmd in commands), "Each command should be a dict"
        # Could check presence of typical keys like "name" or "description" but not required here

test_get_v1_commands_returns_available_commands()