"""Mock LLM provider for tests and offline workflows.

Drives a deterministic, scripted set of responses keyed by either the next
user message or by an explicit `MockScript`. Records every request so tests
can assert against the conversation transcript.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field

from shared_schema.models import ModelCapability, ModelDescriptor, ProviderKind

from .base import (
    ChatRequest,
    ChatResponse,
    LLMProvider,
    ProviderToolCall,
    StreamChunk,
)


@dataclass(slots=True)
class MockResponse:
    text: str = ""
    tool_calls: list[ProviderToolCall] = field(default_factory=list)


class MockProvider(LLMProvider):
    kind = "mock"

    def __init__(self) -> None:
        super().__init__()
        self._script: list[MockResponse] = []
        self._idx: int = 0
        self.requests: list[ChatRequest] = []
        self._embedding_dim = 64

    # ── scripting ───────────────────────────────────────────────────────

    def queue(self, *responses: MockResponse | str) -> MockProvider:
        for r in responses:
            self._script.append(MockResponse(text=r) if isinstance(r, str) else r)
        return self

    def reset(self) -> None:
        self._script.clear()
        self.requests.clear()
        self._idx = 0

    def _next(self) -> MockResponse:
        if self._idx >= len(self._script):
            return MockResponse(text="(mock: out of scripted responses)")
        r = self._script[self._idx]
        self._idx += 1
        return r

    # ── LLMProvider impl ────────────────────────────────────────────────

    def models(self) -> list[ModelDescriptor]:
        return [
            ModelDescriptor(
                provider=ProviderKind.mock,
                model_id="mock-1",
                display_name="Mock 1",
                capability=ModelCapability(
                    context_window=8192,
                    supports_tools=True,
                    supports_streaming=True,
                    supports_embeddings=True,
                ),
            )
        ]

    async def chat(self, request: ChatRequest) -> ChatResponse:
        self.requests.append(request)
        r = self._next()
        return ChatResponse(text=r.text, tool_calls=list(r.tool_calls))

    async def stream(self, request: ChatRequest) -> AsyncIterator[StreamChunk]:
        self.requests.append(request)
        r = self._next()

        async def _gen() -> AsyncIterator[StreamChunk]:
            for ch in r.text:
                yield StreamChunk(delta_text=ch)
            if r.tool_calls:
                yield StreamChunk(delta_tool_calls=list(r.tool_calls))
            yield StreamChunk(finish=True)

        return _gen()

    async def embed(self, texts: list[str], *, model: str) -> list[list[float]]:
        # Stable hash-based embedding so tests can assert determinism without
        # pulling in heavy ML dependencies.
        from ..indexer.embeddings import hash_embed  # local import to avoid cycle

        return [hash_embed(t, self._embedding_dim) for t in texts]
