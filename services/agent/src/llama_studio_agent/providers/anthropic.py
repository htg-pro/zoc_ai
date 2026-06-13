"""Anthropic Messages API adapter."""

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


def _split_system(messages: list) -> tuple[str, list[dict[str, Any]]]:
    system_parts: list[str] = []
    out: list[dict[str, Any]] = []
    for m in messages:
        if m.role == "system":
            system_parts.append(m.content)
            continue
        role = "user" if m.role == "tool" else m.role
        content: Any = m.content
        if m.role == "tool" and m.tool_call_id:
            content = [
                {
                    "type": "tool_result",
                    "tool_use_id": m.tool_call_id,
                    "content": m.content,
                }
            ]
        out.append({"role": role, "content": content})
    return "\n\n".join(system_parts), out


class AnthropicProvider(LLMProvider):
    kind = "anthropic"

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str = "https://api.anthropic.com/v1",
        catalog: list[ModelDescriptor] | None = None,
    ) -> None:
        super().__init__(base_url=base_url, api_key=api_key)
        self._catalog = catalog or [
            ModelDescriptor(
                provider=ProviderKind.anthropic,
                model_id="claude-3-5-sonnet-latest",
                display_name="Claude 3.5 Sonnet",
                capability=ModelCapability(
                    context_window=200_000, supports_tools=True, supports_vision=True
                ),
            ),
            ModelDescriptor(
                provider=ProviderKind.anthropic,
                model_id="claude-3-5-haiku-latest",
                display_name="Claude 3.5 Haiku",
                capability=ModelCapability(context_window=200_000, supports_tools=True),
            ),
        ]

    def models(self) -> list[ModelDescriptor]:
        return list(self._catalog)

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json", "anthropic-version": "2023-06-01"}
        if self.api_key:
            h["x-api-key"] = self.api_key
        return h

    def _body(self, req: ChatRequest, *, stream: bool) -> dict[str, Any]:
        system, msgs = _split_system(req.messages)
        body: dict[str, Any] = {
            "model": req.model,
            "messages": msgs,
            "max_tokens": req.max_tokens or 4096,
            "temperature": req.temperature,
            "stream": stream,
        }
        if system:
            body["system"] = system
        if req.tools:
            body["tools"] = [
                {"name": t.name, "description": t.description, "input_schema": t.parameters}
                for t in req.tools
            ]
        return body

    async def chat(self, request: ChatRequest) -> ChatResponse:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120)) as client:
            try:
                resp = await client.post(
                    f"{self.base_url}/messages",
                    headers=self._headers(),
                    json=self._body(request, stream=False),
                )
                resp.raise_for_status()
            except httpx.HTTPError as exc:
                raise ProviderError(f"anthropic chat failed: {exc}") from exc
        data = resp.json()
        text_parts: list[str] = []
        tool_calls: list[ProviderToolCall] = []
        for block in data.get("content", []):
            if block.get("type") == "text":
                text_parts.append(block.get("text", ""))
            elif block.get("type") == "tool_use":
                tool_calls.append(
                    ProviderToolCall(
                        id=block.get("id", ""),
                        name=block.get("name", ""),
                        arguments=block.get("input", {}) or {},
                    )
                )
        return ChatResponse(text="".join(text_parts), tool_calls=tool_calls, raw=data)

    async def stream(self, request: ChatRequest) -> AsyncIterator[StreamChunk]:
        body = self._body(request, stream=True)
        client = httpx.AsyncClient(timeout=httpx.Timeout(120))

        async def _gen() -> AsyncIterator[StreamChunk]:
            try:
                async with client.stream(
                    "POST",
                    f"{self.base_url}/messages",
                    headers=self._headers(),
                    json=body,
                ) as resp:
                    if resp.status_code >= 400:
                        text = await resp.aread()
                        raise ProviderError(
                            f"anthropic stream failed {resp.status_code}: {text.decode(errors='replace')}"
                        )
                    pending_tool: dict[str, Any] | None = None
                    tool_args_buf = ""
                    async for line in resp.aiter_lines():
                        if not line or not line.startswith("data:"):
                            continue
                        try:
                            ev = json.loads(line[5:].strip())
                        except json.JSONDecodeError:
                            continue
                        t = ev.get("type")
                        if t == "content_block_start":
                            blk = ev.get("content_block", {})
                            if blk.get("type") == "tool_use":
                                pending_tool = {"id": blk.get("id", ""), "name": blk.get("name", "")}
                                tool_args_buf = ""
                        elif t == "content_block_delta":
                            delta = ev.get("delta", {})
                            if delta.get("type") == "text_delta" and delta.get("text"):
                                yield StreamChunk(delta_text=delta["text"])
                            elif delta.get("type") == "input_json_delta":
                                tool_args_buf += delta.get("partial_json", "")
                        elif t == "content_block_stop" and pending_tool is not None:
                            try:
                                args = json.loads(tool_args_buf or "{}")
                            except json.JSONDecodeError:
                                args = {"_raw": tool_args_buf}
                            yield StreamChunk(
                                delta_tool_calls=[
                                    ProviderToolCall(
                                        id=pending_tool["id"],
                                        name=pending_tool["name"],
                                        arguments=args,
                                    )
                                ]
                            )
                            pending_tool = None
                            tool_args_buf = ""
                        elif t == "message_stop":
                            break
                    yield StreamChunk(finish=True)
            finally:
                await client.aclose()

        return _gen()
