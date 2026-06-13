"""Google Gemini (`generativelanguage.googleapis.com`) adapter."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx
from shared_schema.models import ModelCapability, ModelDescriptor, ProviderKind

from .base import (
    ChatRequest,
    ChatResponse,
    LLMProvider,
    ProviderError,
    ProviderToolCall,
    StreamChunk,
)


def _to_contents(req: ChatRequest) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    contents: list[dict[str, Any]] = []
    system: dict[str, Any] | None = None
    for m in req.messages:
        if m.role == "system":
            system = {"parts": [{"text": m.content}]}
            continue
        role = "user" if m.role in {"user", "tool"} else "model"
        parts: list[dict[str, Any]] = []
        if m.role == "tool":
            parts.append(
                {
                    "functionResponse": {
                        "name": m.name or "",
                        "response": {"content": m.content},
                    }
                }
            )
        else:
            parts.append({"text": m.content})
            for tc in m.tool_calls:
                parts.append(
                    {"functionCall": {"name": tc.name, "args": tc.arguments}}
                )
        contents.append({"role": role, "parts": parts})
    return contents, system


class GeminiProvider(LLMProvider):
    kind = "gemini"

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str = "https://generativelanguage.googleapis.com/v1beta",
        catalog: list[ModelDescriptor] | None = None,
    ) -> None:
        super().__init__(base_url=base_url, api_key=api_key)
        self._catalog = catalog or [
            ModelDescriptor(
                provider=ProviderKind.gemini,
                model_id="gemini-1.5-pro",
                display_name="Gemini 1.5 Pro",
                capability=ModelCapability(
                    context_window=2_000_000, supports_tools=True, supports_vision=True
                ),
            ),
            ModelDescriptor(
                provider=ProviderKind.gemini,
                model_id="gemini-1.5-flash",
                display_name="Gemini 1.5 Flash",
                capability=ModelCapability(
                    context_window=1_000_000, supports_tools=True, supports_vision=True
                ),
            ),
        ]

    def models(self) -> list[ModelDescriptor]:
        return list(self._catalog)

    def _body(self, req: ChatRequest) -> dict[str, Any]:
        contents, system = _to_contents(req)
        body: dict[str, Any] = {
            "contents": contents,
            "generationConfig": {"temperature": req.temperature},
        }
        if req.max_tokens is not None:
            body["generationConfig"]["maxOutputTokens"] = req.max_tokens
        if system:
            body["systemInstruction"] = system
        if req.tools:
            body["tools"] = [
                {
                    "functionDeclarations": [
                        {
                            "name": t.name,
                            "description": t.description,
                            "parameters": t.parameters,
                        }
                        for t in req.tools
                    ]
                }
            ]
        return body

    def _url(self, model: str, *, stream: bool) -> str:
        verb = "streamGenerateContent" if stream else "generateContent"
        key = f"?key={self.api_key}" if self.api_key else ""
        return f"{self.base_url}/models/{model}:{verb}{key}"

    async def chat(self, request: ChatRequest) -> ChatResponse:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120)) as client:
            try:
                resp = await client.post(
                    self._url(request.model, stream=False),
                    json=self._body(request),
                )
                resp.raise_for_status()
            except httpx.HTTPError as exc:
                raise ProviderError(f"gemini chat failed: {exc}") from exc
        data = resp.json()
        return _parse_gemini_response(data)

    async def stream(self, request: ChatRequest) -> AsyncIterator[StreamChunk]:
        body = self._body(request)
        client = httpx.AsyncClient(timeout=httpx.Timeout(120))

        async def _gen() -> AsyncIterator[StreamChunk]:
            try:
                async with client.stream(
                    "POST",
                    self._url(request.model, stream=True) + ("&alt=sse" if self.api_key else "?alt=sse"),
                    json=body,
                ) as resp:
                    if resp.status_code >= 400:
                        text = await resp.aread()
                        raise ProviderError(
                            f"gemini stream failed {resp.status_code}: {text.decode(errors='replace')}"
                        )
                    async for line in resp.aiter_lines():
                        if not line or not line.startswith("data:"):
                            continue
                        try:
                            data = json.loads(line[5:].strip())
                        except json.JSONDecodeError:
                            continue
                        partial = _parse_gemini_response(data)
                        if partial.text:
                            yield StreamChunk(delta_text=partial.text)
                        if partial.tool_calls:
                            yield StreamChunk(delta_tool_calls=partial.tool_calls)
                    yield StreamChunk(finish=True)
            finally:
                await client.aclose()

        return _gen()


def _parse_gemini_response(data: dict[str, Any]) -> ChatResponse:
    text_parts: list[str] = []
    tool_calls: list[ProviderToolCall] = []
    for cand in data.get("candidates", []) or []:
        for part in cand.get("content", {}).get("parts", []) or []:
            if "text" in part:
                text_parts.append(part["text"])
            if "functionCall" in part:
                fc = part["functionCall"]
                tool_calls.append(
                    ProviderToolCall(
                        id=fc.get("name", "") + "-call",
                        name=fc.get("name", ""),
                        arguments=fc.get("args", {}) or {},
                    )
                )
    return ChatResponse(text="".join(text_parts), tool_calls=tool_calls, raw=data)
