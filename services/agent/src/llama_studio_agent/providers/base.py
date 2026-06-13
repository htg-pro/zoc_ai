"""Unified LLM provider interface."""

from __future__ import annotations

import abc
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from shared_schema.models import ModelDescriptor


class ProviderError(RuntimeError):
    """Raised when a provider call fails (network, auth, schema mismatch...)."""


@dataclass(slots=True)
class ChatMessage:
    role: str  # "system" | "user" | "assistant" | "tool"
    content: str
    name: str | None = None
    tool_call_id: str | None = None
    tool_calls: list[ProviderToolCall] = field(default_factory=list)


@dataclass(slots=True)
class ProviderToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass(slots=True)
class ToolSchema:
    name: str
    description: str
    parameters: dict[str, Any]  # JSON schema


@dataclass(slots=True)
class ChatRequest:
    messages: list[ChatMessage]
    model: str
    tools: list[ToolSchema] = field(default_factory=list)
    temperature: float = 0.2
    top_p: float | None = None
    top_k: int | None = None
    repeat_penalty: float | None = None
    max_tokens: int | None = None
    stop: list[str] = field(default_factory=list)


@dataclass(slots=True)
class StreamChunk:
    delta_text: str = ""
    delta_tool_calls: list[ProviderToolCall] = field(default_factory=list)
    finish: bool = False


@dataclass(slots=True)
class ChatResponse:
    text: str
    tool_calls: list[ProviderToolCall] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)


class LLMProvider(abc.ABC):
    """Adapter base class. Concrete providers translate to vendor APIs."""

    kind: str = "base"

    def __init__(self, *, base_url: str | None = None, api_key: str | None = None) -> None:
        self.base_url = base_url
        self.api_key = api_key

    @abc.abstractmethod
    def models(self) -> list[ModelDescriptor]:
        """Static (or cached) model catalogue this provider exposes."""

    @abc.abstractmethod
    async def chat(self, request: ChatRequest) -> ChatResponse:
        """One-shot chat completion."""

    @abc.abstractmethod
    async def stream(self, request: ChatRequest) -> AsyncIterator[StreamChunk]:
        """Token/tool-call streaming."""

    async def embed(self, texts: list[str], *, model: str) -> list[list[float]]:
        """Optional. Default: not implemented."""

        raise ProviderError(f"{self.kind} provider does not support embeddings")
