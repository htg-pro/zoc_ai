"""OpenAI-compatible chat completions adapter (also covers llama.cpp's
`/v1/chat/completions` and many other OpenAI-API-compatible servers)."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx
from shared_schema.models import ModelCapability, ModelDescriptor, ProviderKind

from .base import (
    ChatMessage,
    ChatRequest,
    ChatResponse,
    LLMProvider,
    ProviderError,
    ProviderToolCall,
    StreamChunk,
)


def _msg_to_openai(m: ChatMessage) -> dict[str, Any]:
    out: dict[str, Any] = {"role": m.role, "content": m.content}
    if m.name:
        out["name"] = m.name
    if m.tool_call_id:
        out["tool_call_id"] = m.tool_call_id
    if m.tool_calls:
        out["tool_calls"] = [
            {
                "id": tc.id,
                "type": "function",
                "function": {"name": tc.name, "arguments": json.dumps(tc.arguments)},
            }
            for tc in m.tool_calls
        ]
    return out


def _request_body(req: ChatRequest, *, stream: bool) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": req.model,
        "messages": [_msg_to_openai(m) for m in req.messages],
        "temperature": req.temperature,
        "stream": stream,
    }
    if req.max_tokens is not None:
        body["max_tokens"] = req.max_tokens
    if req.top_p is not None:
        body["top_p"] = req.top_p
    if req.top_k is not None:
        # llama-server accepts this OpenAI-compatible extension. Cloud
        # providers never set it through the shared request path.
        body["top_k"] = req.top_k
    if req.repeat_penalty is not None:
        # llama-server accepts this OpenAI-compatible extension. Cloud
        # providers never set it through the shared request path.
        body["repeat_penalty"] = req.repeat_penalty
    if req.stop:
        body["stop"] = req.stop
    if req.tools:
        body["tools"] = [
            {
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                },
            }
            for t in req.tools
        ]
    return body


def _parse_tool_calls(raw: Any) -> list[ProviderToolCall]:
    out: list[ProviderToolCall] = []
    for tc in raw or []:
        fn = tc.get("function", {})
        args_raw = fn.get("arguments", "{}")
        try:
            args = json.loads(args_raw) if isinstance(args_raw, str) else args_raw
        except json.JSONDecodeError:
            args = {"_raw": args_raw}
        out.append(ProviderToolCall(id=tc.get("id", ""), name=fn.get("name", ""), arguments=args))
    return out


class OpenAIProvider(LLMProvider):
    kind = "openai"

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str = "https://api.openai.com/v1",
        catalog: list[ModelDescriptor] | None = None,
    ) -> None:
        super().__init__(base_url=base_url, api_key=api_key)
        self._catalog = catalog or [
            ModelDescriptor(
                provider=ProviderKind.openai,
                model_id="gpt-4o-mini",
                display_name="GPT-4o mini",
                capability=ModelCapability(context_window=128_000, supports_tools=True),
            ),
            ModelDescriptor(
                provider=ProviderKind.openai,
                model_id="gpt-4o",
                display_name="GPT-4o",
                capability=ModelCapability(
                    context_window=128_000, supports_tools=True, supports_vision=True
                ),
            ),
        ]

    def models(self) -> list[ModelDescriptor]:
        return list(self._catalog)

    async def list_remote_models(self) -> list[str]:
        """Fetch the provider's live model catalogue via the OpenAI-compatible
        `GET /models` endpoint. Works for OpenAI, Groq, xAI, and Google AI
        Studio's OpenAI bridge. Returns bare model ids."""
        async with httpx.AsyncClient(timeout=httpx.Timeout(30)) as client:
            resp = await client.get(f"{self.base_url}/models", headers=self._headers())
            resp.raise_for_status()
        data = resp.json()
        items = data.get("data") or data.get("models") or []
        ids: list[str] = []
        for item in items:
            if isinstance(item, dict):
                mid = item.get("id") or item.get("name")
                if mid:
                    ids.append(str(mid))
            elif isinstance(item, str):
                ids.append(item)
        return ids

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h

    async def chat(self, request: ChatRequest) -> ChatResponse:
        body = _request_body(request, stream=False)
        async with httpx.AsyncClient(timeout=httpx.Timeout(120)) as client:
            try:
                resp = await client.post(
                    f"{self.base_url}/chat/completions",
                    headers=self._headers(),
                    json=body,
                )
                resp.raise_for_status()
            except httpx.HTTPError as exc:
                raise ProviderError(f"{self.kind} chat failed: {exc}") from exc
        data = resp.json()
        choice = (data.get("choices") or [{}])[0]
        msg = choice.get("message", {})
        return ChatResponse(
            text=msg.get("content") or "",
            tool_calls=_parse_tool_calls(msg.get("tool_calls")),
            raw=data,
        )

    async def stream(self, request: ChatRequest) -> AsyncIterator[StreamChunk]:
        body = _request_body(request, stream=True)
        client = httpx.AsyncClient(timeout=httpx.Timeout(120))

        async def _gen() -> AsyncIterator[StreamChunk]:
            try:
                async with client.stream(
                    "POST",
                    f"{self.base_url}/chat/completions",
                    headers=self._headers(),
                    json=body,
                ) as resp:
                    if resp.status_code >= 400:
                        text = await resp.aread()
                        raise ProviderError(
                            f"{self.kind} stream failed {resp.status_code}: {text.decode(errors='replace')}"
                        )
                    pending_tools: dict[int, dict[str, Any]] = {}
                    async for line in resp.aiter_lines():
                        if not line or not line.startswith("data:"):
                            continue
                        payload = line[5:].strip()
                        if payload == "[DONE]":
                            break
                        try:
                            data = json.loads(payload)
                        except json.JSONDecodeError:
                            continue
                        delta = (data.get("choices") or [{}])[0].get("delta", {})
                        if isinstance(delta.get("content"), str) and delta["content"]:
                            yield StreamChunk(delta_text=delta["content"])
                        for tc in delta.get("tool_calls") or []:
                            idx = tc.get("index", 0)
                            slot = pending_tools.setdefault(
                                idx, {"id": "", "name": "", "arguments": ""}
                            )
                            if tc.get("id"):
                                slot["id"] = tc["id"]
                            fn = tc.get("function") or {}
                            if fn.get("name"):
                                slot["name"] = fn["name"]
                            if fn.get("arguments"):
                                slot["arguments"] += fn["arguments"]
                    finalized: list[ProviderToolCall] = []
                    for slot in pending_tools.values():
                        try:
                            args = json.loads(slot["arguments"] or "{}")
                        except json.JSONDecodeError:
                            args = {"_raw": slot["arguments"]}
                        finalized.append(
                            ProviderToolCall(
                                id=slot["id"], name=slot["name"], arguments=args
                            )
                        )
                    if finalized:
                        yield StreamChunk(delta_tool_calls=finalized)
                    yield StreamChunk(finish=True)
            finally:
                await client.aclose()

        return _gen()

    async def embed(self, texts: list[str], *, model: str) -> list[list[float]]:
        async with httpx.AsyncClient(timeout=httpx.Timeout(60)) as client:
            try:
                resp = await client.post(
                    f"{self.base_url}/embeddings",
                    headers=self._headers(),
                    json={"model": model, "input": texts},
                )
                resp.raise_for_status()
            except httpx.HTTPError as exc:
                raise ProviderError(f"{self.kind} embed failed: {exc}") from exc
        return [item["embedding"] for item in resp.json().get("data", [])]
