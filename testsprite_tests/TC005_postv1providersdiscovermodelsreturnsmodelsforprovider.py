import requests

BASE_URL = "http://127.0.0.1:36941"
TIMEOUT = 30

def test_post_v1_providers_discover_models_returns_models_for_provider():
    # Step 1: Get the list of configured providers
    providers_url = f"{BASE_URL}/v1/providers"
    try:
        resp = requests.get(providers_url, timeout=TIMEOUT)
        resp.raise_for_status()
    except requests.RequestException as e:
        assert False, f"Failed to GET /v1/providers: {e}"
    providers_data = resp.json()
    assert isinstance(providers_data, list), f"Expected list of providers, got {type(providers_data)}"
    assert len(providers_data) > 0, "No providers returned from /v1/providers"

    # Validate provider objects and get the first valid provider name
    provider_name = None
    for provider in providers_data:
        assert isinstance(provider, dict), f"Each provider should be a dict, got {type(provider)}"
        name = provider.get("name")
        if isinstance(name, str):
            provider_name = name
            break
    assert provider_name is not None, "No provider with a valid 'name' string found"

    # Step 2: POST to /v1/providers/discover-models with the provider
    discover_url = f"{BASE_URL}/v1/providers/discover-models"
    headers = {"Content-Type": "application/json"}
    payload = {"provider": provider_name}

    try:
        resp = requests.post(discover_url, json=payload, headers=headers, timeout=TIMEOUT)
        resp.raise_for_status()
    except requests.RequestException as e:
        assert False, f"Failed to POST /v1/providers/discover-models: {e}"

    # Step 3: Validate the response
    models_data = resp.json()
    # Expected: 200 OK with available models for that provider (should be a list)
    assert isinstance(models_data, list), f"Expected list of models, got {type(models_data)}"
    assert len(models_data) > 0, f"No models returned for provider '{provider_name}'"


test_post_v1_providers_discover_models_returns_models_for_provider()
