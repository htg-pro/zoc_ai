"""Bring-your-own cloud provider routing for /agent/run.

A model selected from a configured cloud provider (OpenAI / Google AI Studio /
Groq / xAI / custom) is sent with its OpenAI-compatible base URL + key. The
endpoint must route the run through an ad-hoc OpenAIProvider built from those
values instead of the env-keyed registry.
"""

from __future__ import annotations


def test_agent_run_routes_bring_your_own_openai_compatible(client, session, monkeypatch):
    from llama_studio_agent.providers.base import ChatResponse
    from llama_studio_agent.providers.openai import OpenAIProvider

    captured: dict[str, object] = {}

    async def fake_chat(self, request):  # type: ignore[no-untyped-def]
        captured["model"] = request.model
        captured["base_url"] = self.base_url
        captured["api_key"] = self.api_key
        return ChatResponse(text="hello from groq", tool_calls=[])

    async def fake_stream(self, request):  # type: ignore[no-untyped-def]
        # Force the orchestrator onto the non-streaming chat() path.
        raise NotImplementedError

    monkeypatch.setattr(OpenAIProvider, "chat", fake_chat)
    monkeypatch.setattr(OpenAIProvider, "stream", fake_stream)

    resp = client.post(
        f"/v1/sessions/{session.id}/agent/run",
        json={
            "message": "hi",
            "workspacePath": session.workspace_root,
            "model": "llama-3.3-70b-versatile",
            "provider": "groq",
            "apiKey": "gsk_test_key",
            "baseUrl": "https://api.groq.com/openai/v1",
            "mode": "agent",
        },
    )

    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["final_text"] == "hello from groq"
    # The ad-hoc provider used exactly the request's model / base URL / key.
    assert captured["model"] == "llama-3.3-70b-versatile"
    assert captured["base_url"] == "https://api.groq.com/openai/v1"
    assert captured["api_key"] == "gsk_test_key"


def test_agent_run_without_byo_keys_uses_the_registry(client, session, monkeypatch):
    # No apiKey/baseUrl → falls back to the registry-resolved provider
    # (the session's "mock" provider), never constructing an OpenAIProvider.
    from llama_studio_agent.providers.openai import OpenAIProvider

    def boom(*args, **kwargs):  # type: ignore[no-untyped-def]
        raise AssertionError("OpenAIProvider must not be built without BYO keys")

    monkeypatch.setattr(OpenAIProvider, "__init__", boom)

    resp = client.post(
        f"/v1/sessions/{session.id}/agent/run",
        json={
            "message": "hi",
            "workspacePath": session.workspace_root,
            "model": "mock-1",
            "provider": "mock",
            "mode": "agent",
        },
    )

    assert resp.status_code == 200, resp.text


def test_discover_models_lists_live_provider_models(client, monkeypatch):
    # The endpoint fetches the provider's live `/models` list with the key,
    # so the Settings UI can replace its static catalogue with current models.
    from llama_studio_agent.providers.openai import OpenAIProvider

    async def fake_remote(self):  # type: ignore[no-untyped-def]
        # Returned out of order + with a dupe to exercise sort/dedupe.
        return ["llama-3.1-8b-instant", "llama-3.3-70b-versatile", "llama-3.1-8b-instant"]

    monkeypatch.setattr(OpenAIProvider, "list_remote_models", fake_remote)

    resp = client.post(
        "/v1/providers/discover-models",
        json={"base_url": "https://api.groq.com/openai/v1", "api_key": "gsk_test"},
    )
    assert resp.status_code == 200, resp.text
    ids = [m["id"] for m in resp.json()["models"]]
    assert ids == ["llama-3.1-8b-instant", "llama-3.3-70b-versatile"]  # sorted + deduped


def test_discover_models_surfaces_provider_errors_as_502(client, monkeypatch):
    from llama_studio_agent.providers.openai import OpenAIProvider

    async def boom(self):  # type: ignore[no-untyped-def]
        raise RuntimeError("401 Unauthorized")

    monkeypatch.setattr(OpenAIProvider, "list_remote_models", boom)

    resp = client.post(
        "/v1/providers/discover-models",
        json={"base_url": "https://api.example.com/v1", "api_key": "bad"},
    )
    assert resp.status_code == 502
    assert "Could not fetch models" in resp.json()["detail"]
