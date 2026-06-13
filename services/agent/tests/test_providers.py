import pytest
from llama_studio_agent.providers import ProviderRegistry
from llama_studio_agent.providers.base import (
    ChatMessage,
    ChatRequest,
    ProviderError,
    ProviderToolCall,
)
from llama_studio_agent.providers.llamacpp import LlamaCppProvider
from llama_studio_agent.providers.mock import MockProvider, MockResponse
from llama_studio_agent.providers.openai import _request_body
from shared_schema.models import ProviderKind


@pytest.mark.asyncio
async def test_mock_chat_returns_scripted_text():
    p = MockProvider().queue("hello world")
    r = await p.chat(ChatRequest(messages=[ChatMessage(role="user", content="hi")], model="mock-1"))
    assert r.text == "hello world"
    assert p.requests[0].messages[0].content == "hi"


@pytest.mark.asyncio
async def test_mock_stream_yields_text_and_finish():
    p = MockProvider().queue("ab")
    gen = await p.stream(ChatRequest(messages=[], model="mock-1"))
    chunks = []
    async for c in gen:
        chunks.append(c)
    assert "".join(c.delta_text for c in chunks) == "ab"
    assert chunks[-1].finish


@pytest.mark.asyncio
async def test_mock_tool_calls_round_trip():
    tc = ProviderToolCall(id="t1", name="read_file", arguments={"path": "x"})
    p = MockProvider().queue(MockResponse(text="", tool_calls=[tc]))
    r = await p.chat(ChatRequest(messages=[], model="mock-1"))
    assert r.tool_calls and r.tool_calls[0].name == "read_file"


def test_registry_resolves_unknown_model_for_dynamic_provider(app_state):
    reg: ProviderRegistry = app_state.providers
    impl, desc = reg.resolve("llamacpp", "totally-new-model")
    assert desc.model_id == "totally-new-model"
    assert impl.kind == "llamacpp"


def test_registry_unknown_model_fails_for_strict_provider(app_state):
    with pytest.raises(ProviderError):
        app_state.providers.resolve("openai", "nope-model")


def test_llamacpp_provider_reads_runtime_state(tmp_path):
    state_path = tmp_path / "llamacpp-runtime.json"
    state_path.write_text(
        """
        {
          "running": true,
          "host": "127.0.0.1",
          "port": 9090,
          "base_url": "http://127.0.0.1:9090",
          "loaded_model_id": "local:test",
          "loaded_model_path": "/models/test-model.gguf",
          "n_ctx": 32768,
          "temperature": 0.4,
          "top_p": 0.8,
          "top_k": 32,
          "repeat_penalty": 1.05,
          "max_tokens": 2048
        }
        """,
        "utf-8",
    )
    provider = LlamaCppProvider(state_path=str(state_path))

    models = provider.models()
    assert provider.base_url == "http://127.0.0.1:9090/v1"
    assert models[0].model_id == "local:test"
    assert models[0].display_name == "test-model"
    assert models[0].capability.context_window == 32768

    req = ChatRequest(messages=[], model="local:test", temperature=0.2)
    out = provider._with_runtime_defaults(req)
    assert out.temperature == 0.4
    assert out.top_p == 0.8
    assert out.top_k == 32
    assert out.repeat_penalty == 1.05
    assert out.max_tokens == 2048


def test_openai_request_body_includes_llamacpp_sampling_extensions():
    req = ChatRequest(
        messages=[ChatMessage(role="user", content="hi")],
        model="local:test",
        top_p=0.8,
        top_k=32,
        repeat_penalty=1.05,
    )

    body = _request_body(req, stream=False)

    assert body["top_p"] == 0.8
    assert body["top_k"] == 32
    assert body["repeat_penalty"] == 1.05


def test_provider_list_has_five_kinds(app_state):
    kinds = {p.kind for p in app_state.providers.list()}
    assert kinds == {
        ProviderKind.mock,
        ProviderKind.llamacpp,
        ProviderKind.openai,
        ProviderKind.anthropic,
        ProviderKind.gemini,
    }
