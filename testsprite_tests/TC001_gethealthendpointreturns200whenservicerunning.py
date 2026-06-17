import requests

def test_get_health_returns_200_when_service_running():
    base_url = "http://127.0.0.1:36941"
    url = f"{base_url}/health"
    try:
        response = requests.get(url, timeout=30)
        response.raise_for_status()
        assert response.status_code == 200, f"Expected status 200, got {response.status_code}"
    except requests.exceptions.RequestException as e:
        assert False, f"Request to /health failed: {e}"

test_get_health_returns_200_when_service_running()