"""Small synchronous model runtime adapter for Gateway runs.

The agent pipeline is intentionally injectable for tests, but the desktop app
needs a real default path too: local llama.cpp exposes an OpenAI-compatible
chat endpoint, most configured cloud providers do the same, and Anthropic uses
its native Messages API. This module keeps those HTTP details out of the FSM
and never logs credentials.
"""

from __future__ import annotations

import json
import math
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from zocai_gateway.mode_router import AgentRunRequest

__all__ = [
    "PROVIDER_NATIVE_TOOLS",
    "ModelRuntimeError",
    "ModelToolResponse",
    "StreamMetrics",
    "ToolCall",
    "ToolSpec",
    "generate_text",
    "generate_text_stream",
    "generate_with_tools",
]

_DEFAULT_MAX_TOKENS = 512
_STREAM_DONE = object()


class ModelRuntimeError(RuntimeError):
    """Raised when a configured model endpoint cannot produce text."""


@dataclass(frozen=True)
class StreamMetrics:
    """Provider-reported completion metrics from a streaming response."""

    completion_tokens: int | None = None
    tokens_per_second: float | None = None


# ── Tool-calling surface (Req 8) ─────────────────────────────────────────────


@dataclass(frozen=True)
class ToolSpec:
    """A JSON-schema tool declaration sent to the provider (R8.2)."""

    name: str
    description: str
    parameters: Mapping[str, Any]  # JSON Schema for the tool arguments


@dataclass(frozen=True)
class ToolCall:
    """A model-requested invocation of a tool (R8.3)."""

    id: str
    name: str
    arguments: Mapping[str, Any]


@dataclass(frozen=True)
class ModelToolResponse:
    """Normalized tool-calling response across every provider (R8.1/8.3/8.4/8.8).

    The ReAct loop only ever sees this shape: ``text`` is any assistant prose,
    ``tool_calls`` is the ordered tuple of requested calls, and
    ``finish_reason`` is one of ``stop`` (done — execute no calls, R8.4),
    ``tool_calls`` (calls to execute, R8.3), ``length`` (truncated), or
    ``error``.
    """

    text: str
    tool_calls: tuple[ToolCall, ...]
    finish_reason: Literal["stop", "tool_calls", "length", "error"]


#: Whether each provider is *attempted* with a native tool-calling API. A
#: provider mapped to ``True`` is called natively first and falls back to the
#: prompted-tool protocol only on a :class:`ModelRuntimeError`; a provider
#: mapped to ``False`` (and every unknown provider) uses the prompted protocol
#: directly (R8.1/8.4/8.8). ``llamacpp`` is attempted natively because some
#: local builds expose OpenAI-style tools, then falls back when they do not.
PROVIDER_NATIVE_TOOLS: dict[str, bool] = {
    "anthropic": True,
    "openai": True,
    "edge": True,
    "cloud": True,
    "llamacpp": True,
}


def generate_text(
    request: AgentRunRequest,
    *,
    system_prompt: str | None = None,
    response_format: Mapping[str, Any] | None = None,
    timeout: float = 60.0,
) -> str | None:
    """Generate a response with the selected provider, or ``None`` if unset."""

    provider = (request.provider or "").strip()
    model = (request.model or "").strip()
    base_url = (request.base_url or "").strip().rstrip("/")
    api_key = (request.api_key or "").strip()

    if not provider or not model:
        return None
    if provider == "anthropic":
        return _anthropic_messages(
            request=request,
            prompt=request.prompt,
            model=model,
            api_key=api_key,
            base_url=base_url or "https://api.anthropic.com/v1",
            system_prompt=system_prompt,
            timeout=timeout,
        )
    if not base_url:
        return None
    return _openai_compatible_chat(
        request=request,
        prompt=request.prompt,
        provider=provider,
        model=model,
        api_key=api_key,
        base_url=base_url,
        system_prompt=system_prompt,
        response_format=response_format,
        timeout=timeout,
    )


def generate_text_stream(
    request: AgentRunRequest,
    *,
    system_prompt: str | None = None,
    timeout: float = 60.0,
    on_token: Callable[[str], None] | None = None,
    on_metrics: Callable[[StreamMetrics], None] | None = None,
    stop: Sequence[str] | None = None,
) -> str | None:
    """Generate text and emit OpenAI-compatible stream chunks as they arrive.

    ``stop`` is an optional list of stop sequences forwarded to the provider
    (OpenAI-compatible ``stop`` / Anthropic ``stop_sequences``); existing
    callers pass nothing and are unaffected (§3.3 R11.4).
    """

    provider = (request.provider or "").strip()
    model = (request.model or "").strip()
    base_url = (request.base_url or "").strip().rstrip("/")
    api_key = (request.api_key or "").strip()

    if not provider or not model:
        return None
    if provider == "anthropic":
        # Anthropic's native stream protocol is different; keep a bounded
        # non-streaming path so Ask still finishes visibly for that provider.
        return _anthropic_messages(
            request=request,
            prompt=request.prompt,
            model=model,
            api_key=api_key,
            base_url=base_url or "https://api.anthropic.com/v1",
            system_prompt=system_prompt,
            timeout=timeout,
            stop=stop,
        )
    if not base_url:
        return None
    return _openai_compatible_chat_stream(
        request=request,
        prompt=request.prompt,
        provider=provider,
        model=model,
        api_key=api_key,
        base_url=base_url,
        system_prompt=system_prompt,
        timeout=timeout,
        on_token=on_token,
        on_metrics=on_metrics,
        stop=stop,
    )


def generate_with_tools(
    request: AgentRunRequest,
    *,
    system_prompt: str | None,
    tools: Sequence[ToolSpec],
    tool_history: Sequence[Mapping[str, Any]] = (),
    timeout: float = 120.0,
) -> ModelToolResponse:
    """Drive one tool-calling turn, returning a normalized response (Req 8).

    Selects the provider path from :data:`PROVIDER_NATIVE_TOOLS`: an
    OpenAI-compatible ``tools`` payload for ``edge``/``cloud``/``llamacpp``
    (R8.3), Anthropic's native ``tools`` for ``anthropic`` (R8.3), or the
    prompted-tool JSON protocol for any provider without native tools or when
    a native attempt raises :class:`ModelRuntimeError` (R8.1/8.4/8.8). The loop
    only ever receives a normalized :class:`ModelToolResponse`; with no
    provider configured it receives a text-only ``stop`` so the loop ends.
    """
    provider = (request.provider or "").strip()
    provider_key = provider.lower()
    model = (request.model or "").strip()
    base_url = (request.base_url or "").strip().rstrip("/")
    api_key = (request.api_key or "").strip()

    if not provider or not model:
        # No provider/model: nothing can drive the loop, so signal completion.
        return ModelToolResponse(text="", tool_calls=(), finish_reason="stop")

    if PROVIDER_NATIVE_TOOLS.get(provider_key, False):
        try:
            if provider_key == "anthropic":
                return _anthropic_tools_messages(
                    request=request,
                    model=model,
                    api_key=api_key,
                    base_url=base_url or "https://api.anthropic.com/v1",
                    system_prompt=system_prompt,
                    tools=tools,
                    tool_history=tool_history,
                    timeout=timeout,
                )
            if base_url:
                return _openai_tools_chat(
                    request=request,
                    provider=provider_key,
                    model=model,
                    api_key=api_key,
                    base_url=base_url,
                    system_prompt=system_prompt,
                    tools=tools,
                    tool_history=tool_history,
                    timeout=timeout,
                )
        except ModelRuntimeError:
            # Capability probe failed → fall back to the prompted-tool protocol.
            pass
    return _prompted_tool_fallback(
        request=request,
        system_prompt=system_prompt,
        tools=tools,
        tool_history=tool_history,
        timeout=timeout,
    )


def _openai_tools_chat(
    *,
    request: AgentRunRequest,
    provider: str,
    model: str,
    api_key: str,
    base_url: str,
    system_prompt: str | None,
    tools: Sequence[ToolSpec],
    tool_history: Sequence[Mapping[str, Any]],
    timeout: float,
) -> ModelToolResponse:
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    messages: list[dict[str, Any]] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": request.prompt})
    messages.extend(_openai_history_messages(tool_history))
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": False,
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": dict(tool.parameters),
                },
            }
            for tool in tools
        ],
        "tool_choice": "auto",
    }
    payload.update(_sampling_payload(request, provider))
    response = _post_json(_chat_completions_url(base_url, provider), headers, payload, timeout)
    choices = response.get("choices")
    if not isinstance(choices, list) or not choices:
        raise ModelRuntimeError("provider returned no choices")
    first = choices[0]
    if not isinstance(first, Mapping):
        raise ModelRuntimeError("provider returned an invalid choice")
    message = first.get("message")
    if not isinstance(message, Mapping):
        raise ModelRuntimeError("provider returned no message")
    tool_calls = _parse_openai_tool_calls(message.get("tool_calls"))
    text = _content_to_text(message.get("content"))
    finish = _map_openai_finish(first.get("finish_reason"), bool(tool_calls))
    return ModelToolResponse(text=text, tool_calls=tool_calls, finish_reason=finish)


def _anthropic_tools_messages(
    *,
    request: AgentRunRequest,
    model: str,
    api_key: str,
    base_url: str,
    system_prompt: str | None,
    tools: Sequence[ToolSpec],
    tool_history: Sequence[Mapping[str, Any]],
    timeout: float,
) -> ModelToolResponse:
    if not api_key:
        raise ModelRuntimeError("Anthropic provider requires an API key")
    headers = {
        "Content-Type": "application/json",
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
    }
    messages: list[dict[str, Any]] = [{"role": "user", "content": request.prompt}]
    messages.extend(_anthropic_history_messages(tool_history))
    payload: dict[str, Any] = {
        "model": model,
        "max_tokens": _positive_int(request.max_tokens, default=1024),
        "messages": messages,
        "tools": [
            {
                "name": tool.name,
                "description": tool.description,
                "input_schema": dict(tool.parameters),
            }
            for tool in tools
        ],
    }
    temperature = _float_in_range(request.temperature, default=None, min_value=0.0, max_value=1.0)
    if temperature is not None:
        payload["temperature"] = temperature
    if system_prompt:
        payload["system"] = system_prompt
    response = _post_json(f"{base_url}/messages", headers, payload, timeout)
    content = response.get("content")
    text_parts: list[str] = []
    tool_calls: list[ToolCall] = []
    if isinstance(content, list):
        for index, block in enumerate(content):
            if not isinstance(block, Mapping):
                continue
            block_type = block.get("type")
            if block_type == "text":
                text = block.get("text")
                if isinstance(text, str):
                    text_parts.append(text)
            elif block_type == "tool_use":
                name = block.get("name")
                if not isinstance(name, str) or not name:
                    continue
                block_id = block.get("id")
                arguments = block.get("input")
                tool_calls.append(
                    ToolCall(
                        id=block_id if isinstance(block_id, str) and block_id else f"call-{index}",
                        name=name,
                        arguments=dict(arguments) if isinstance(arguments, Mapping) else {},
                    )
                )
    finish = _map_anthropic_stop(response.get("stop_reason"), bool(tool_calls))
    return ModelToolResponse(
        text="".join(text_parts).strip(),
        tool_calls=tuple(tool_calls),
        finish_reason=finish,
    )


def _prompted_tool_fallback(
    *,
    request: AgentRunRequest,
    system_prompt: str | None,
    tools: Sequence[ToolSpec],
    tool_history: Sequence[Mapping[str, Any]],
    timeout: float,
) -> ModelToolResponse:
    """Prompted-tool protocol used when a provider lacks native tools (R8.1/8.4/8.8).

    The tool schemas and a single-JSON-object protocol are injected into the
    system prompt, prior tool activity is folded into the user prompt, and a
    single tool-call JSON object is parsed back out of the text. A text-only
    "done" (no parseable tool object) yields ``finish_reason="stop"``.
    """
    protocol_prompt = _tool_protocol_system_prompt(system_prompt, tools)
    history_text = _prompted_history_text(tool_history)
    prompt = request.prompt
    if history_text:
        prompt = f"{request.prompt}\n\nPrior tool activity:\n{history_text}"
    fallback_request = request.model_copy(update={"prompt": prompt})
    text = generate_text(fallback_request, system_prompt=protocol_prompt, timeout=timeout)
    if not text:
        return ModelToolResponse(text="", tool_calls=(), finish_reason="stop")
    tool_call = _parse_prompted_tool_call(text)
    if tool_call is None:
        return ModelToolResponse(text=text, tool_calls=(), finish_reason="stop")
    return ModelToolResponse(text=text, tool_calls=(tool_call,), finish_reason="tool_calls")


def _openai_history_messages(
    tool_history: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Translate the normalized tool history into OpenAI assistant/tool turns."""
    messages: list[dict[str, Any]] = []
    for entry in tool_history:
        role = entry.get("role")
        if role == "assistant":
            calls = entry.get("tool_calls") or []
            messages.append(
                {
                    "role": "assistant",
                    "content": entry.get("content") or "",
                    "tool_calls": [
                        {
                            "id": call.get("id") or f"call-{index}",
                            "type": "function",
                            "function": {
                                "name": call.get("name") or "",
                                "arguments": json.dumps(dict(call.get("arguments") or {})),
                            },
                        }
                        for index, call in enumerate(calls)
                    ],
                }
            )
        elif role == "tool":
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": entry.get("tool_call_id") or "",
                    "content": entry.get("content") or "",
                }
            )
    return messages


def _anthropic_history_messages(
    tool_history: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Translate the normalized tool history into Anthropic tool_use/result turns."""
    messages: list[dict[str, Any]] = []
    for entry in tool_history:
        role = entry.get("role")
        if role == "assistant":
            content: list[dict[str, Any]] = []
            text = entry.get("content")
            if text:
                content.append({"type": "text", "text": text})
            for index, call in enumerate(entry.get("tool_calls") or []):
                content.append(
                    {
                        "type": "tool_use",
                        "id": call.get("id") or f"call-{index}",
                        "name": call.get("name") or "",
                        "input": dict(call.get("arguments") or {}),
                    }
                )
            messages.append({"role": "assistant", "content": content})
        elif role == "tool":
            messages.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": entry.get("tool_call_id") or "",
                            "content": entry.get("content") or "",
                        }
                    ],
                }
            )
    return messages


def _prompted_history_text(tool_history: Sequence[Mapping[str, Any]]) -> str:
    """Fold the normalized tool history into a compact text transcript."""
    lines: list[str] = []
    for entry in tool_history:
        role = entry.get("role")
        if role == "assistant":
            for call in entry.get("tool_calls") or []:
                arguments = json.dumps(dict(call.get("arguments") or {}))
                lines.append(f"Called {call.get('name') or ''}({arguments})")
        elif role == "tool":
            lines.append(f"Observation: {entry.get('content') or ''}")
    return "\n".join(lines)


_TOOL_PROTOCOL_INSTRUCTIONS = (
    "You can call one tool at a time. To call a tool, respond with a single "
    'JSON object of the form {"tool": "<name>", "arguments": {<args>}} and '
    "nothing else. When the task is complete, respond with plain text and no "
    "JSON tool object."
)


def _tool_protocol_system_prompt(
    system_prompt: str | None, tools: Sequence[ToolSpec]
) -> str:
    tool_lines = [
        f"- {tool.name}: {tool.description} "
        f"(arguments schema: {json.dumps(dict(tool.parameters))})"
        for tool in tools
    ]
    parts = [
        system_prompt or "",
        _TOOL_PROTOCOL_INSTRUCTIONS,
        "Available tools:\n" + "\n".join(tool_lines),
    ]
    return "\n\n".join(part for part in parts if part)


def _parse_prompted_tool_call(text: str) -> ToolCall | None:
    block = _extract_json_object(text)
    if block is None:
        return None
    try:
        parsed = json.loads(block)
    except ValueError:
        return None
    if not isinstance(parsed, dict):
        return None
    name = parsed.get("tool") or parsed.get("name")
    if not isinstance(name, str) or not name:
        return None
    arguments = parsed.get("arguments")
    return ToolCall(
        id="call-0",
        name=name,
        arguments=arguments if isinstance(arguments, dict) else {},
    )


def _extract_json_object(text: str) -> str | None:
    """Return the first balanced JSON object carrying a ``tool``/``name`` key."""
    depth = 0
    start = -1
    in_string = False
    escape = False
    for index, char in enumerate(text):
        if in_string:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            if depth == 0:
                start = index
            depth += 1
        elif char == "}" and depth > 0:
            depth -= 1
            if depth == 0 and start != -1:
                candidate = text[start : index + 1]
                try:
                    parsed = json.loads(candidate)
                except ValueError:
                    start = -1
                    continue
                if isinstance(parsed, dict) and ("tool" in parsed or "name" in parsed):
                    return candidate
                start = -1
    return None


def _parse_openai_tool_calls(raw: object) -> tuple[ToolCall, ...]:
    if not isinstance(raw, list):
        return ()
    calls: list[ToolCall] = []
    for index, item in enumerate(raw):
        if not isinstance(item, Mapping):
            continue
        function = item.get("function")
        if not isinstance(function, Mapping):
            continue
        name = function.get("name")
        if not isinstance(name, str) or not name:
            continue
        call_id = item.get("id")
        calls.append(
            ToolCall(
                id=call_id if isinstance(call_id, str) and call_id else f"call-{index}",
                name=name,
                arguments=_safe_json_object(function.get("arguments")),
            )
        )
    return tuple(calls)


def _safe_json_object(raw: object) -> dict[str, Any]:
    if isinstance(raw, Mapping):
        return dict(raw)
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
        except ValueError:
            return {}
        if isinstance(parsed, dict):
            return parsed
    return {}


def _map_openai_finish(raw: object, has_tool_calls: bool) -> Literal["stop", "tool_calls", "length", "error"]:
    if raw in ("stop", "tool_calls", "length"):
        return raw
    if has_tool_calls:
        return "tool_calls"
    return "stop"


def _map_anthropic_stop(raw: object, has_tool_calls: bool) -> Literal["stop", "tool_calls", "length", "error"]:
    if raw == "tool_use":
        return "tool_calls"
    if raw == "max_tokens":
        return "length"
    if raw == "end_turn":
        return "stop"
    if has_tool_calls:
        return "tool_calls"
    return "stop"


def _openai_compatible_chat(
    *,
    request: AgentRunRequest,
    prompt: str,
    provider: str,
    model: str,
    api_key: str,
    base_url: str,
    system_prompt: str | None,
    response_format: Mapping[str, Any] | None,
    timeout: float,
) -> str:
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    messages: list[dict[str, str]] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": prompt})
    payload = {
        "model": model,
        "messages": messages,
        "stream": False,
    }
    payload.update(_sampling_payload(request, provider))
    if response_format is not None:
        payload["response_format"] = dict(response_format)
    response = _post_json(_chat_completions_url(base_url, provider), headers, payload, timeout)
    choices = response.get("choices")
    if not isinstance(choices, list) or not choices:
        raise ModelRuntimeError("provider returned no choices")
    first = choices[0]
    if not isinstance(first, Mapping):
        raise ModelRuntimeError("provider returned an invalid choice")
    message = first.get("message")
    if not isinstance(message, Mapping):
        raise ModelRuntimeError("provider returned no message")
    content = message.get("content")
    text = _content_to_text(content)
    if not text:
        text = _content_to_text(message.get("reasoning_content"))
    if not text:
        text = _content_to_text(message.get("reasoning"))
    if not text:
        raise ModelRuntimeError("provider returned an empty message")
    return text


def _openai_compatible_chat_stream(
    *,
    request: AgentRunRequest,
    prompt: str,
    provider: str,
    model: str,
    api_key: str,
    base_url: str,
    system_prompt: str | None,
    timeout: float,
    on_token: Callable[[str], None] | None,
    on_metrics: Callable[[StreamMetrics], None] | None,
    stop: Sequence[str] | None = None,
) -> str:
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    messages: list[dict[str, str]] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": prompt})
    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
    }
    payload.update(_sampling_payload(request, provider))
    if stop:
        payload["stop"] = list(stop)

    chunks: list[str] = []
    saw_choice = False
    for frame in _stream_json_lines(
        _chat_completions_url(base_url, provider),
        headers,
        payload,
        timeout,
    ):
        metrics = _stream_metrics(frame)
        if metrics is not None and on_metrics is not None:
            on_metrics(metrics)
        choices = frame.get("choices")
        if not isinstance(choices, list) or not choices:
            continue
        first = choices[0]
        if not isinstance(first, Mapping):
            continue
        saw_choice = True
        token = _choice_text_delta(first)
        if token:
            chunks.append(token)
            if on_token is not None:
                on_token(token)

    text = "".join(chunks).strip()
    if not text:
        if saw_choice:
            raise ModelRuntimeError("provider returned an empty streamed message")
        raise ModelRuntimeError("provider returned no streamed choices")
    return text


def _stream_metrics(frame: Mapping[str, Any]) -> StreamMetrics | None:
    """Read OpenAI usage or llama.cpp timing fields from a stream frame."""

    completion_tokens: int | None = None
    tokens_per_second: float | None = None

    usage = frame.get("usage")
    if isinstance(usage, Mapping):
        value = usage.get("completion_tokens")
        if isinstance(value, int) and value >= 0:
            completion_tokens = value

    timings = frame.get("timings")
    if isinstance(timings, Mapping):
        predicted_n = timings.get("predicted_n")
        if completion_tokens is None and isinstance(predicted_n, int) and predicted_n >= 0:
            completion_tokens = predicted_n
        predicted_per_second = timings.get("predicted_per_second")
        if isinstance(predicted_per_second, (int, float)):
            parsed = float(predicted_per_second)
            if math.isfinite(parsed) and parsed >= 0:
                tokens_per_second = parsed

    if completion_tokens is None and tokens_per_second is None:
        return None
    return StreamMetrics(
        completion_tokens=completion_tokens,
        tokens_per_second=tokens_per_second,
    )


def _sampling_payload(request: AgentRunRequest, provider: str) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "max_tokens": _positive_int(request.max_tokens, default=_DEFAULT_MAX_TOKENS),
        "temperature": _float_in_range(
            request.temperature,
            default=0.2,
            min_value=0.0,
            max_value=5.0,
        ),
    }
    top_p = _float_in_range(request.top_p, default=None, min_value=0.0, max_value=1.0)
    if top_p is not None:
        payload["top_p"] = top_p
    if provider == "llamacpp":
        top_k = _nonnegative_int(request.top_k)
        if top_k is not None:
            payload["top_k"] = top_k
        repeat_penalty = _float_in_range(
            request.repeat_penalty,
            default=None,
            min_value=0.0,
            max_value=10.0,
        )
        if repeat_penalty is not None:
            payload["repeat_penalty"] = repeat_penalty
    return payload


def _anthropic_messages(
    *,
    request: AgentRunRequest,
    prompt: str,
    model: str,
    api_key: str,
    base_url: str,
    system_prompt: str | None,
    timeout: float,
    stop: Sequence[str] | None = None,
) -> str:
    if not api_key:
        raise ModelRuntimeError("Anthropic provider requires an API key")
    headers = {
        "Content-Type": "application/json",
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
    }
    payload: dict[str, Any] = {
        "model": model,
        "max_tokens": _positive_int(request.max_tokens, default=1024),
        "messages": [{"role": "user", "content": prompt}],
    }
    if stop:
        payload["stop_sequences"] = list(stop)
    temperature = _float_in_range(request.temperature, default=None, min_value=0.0, max_value=1.0)
    if temperature is not None:
        payload["temperature"] = temperature
    top_p = _float_in_range(request.top_p, default=None, min_value=0.0, max_value=1.0)
    if top_p is not None:
        payload["top_p"] = top_p
    if system_prompt:
        payload["system"] = system_prompt
    response = _post_json(f"{base_url}/messages", headers, payload, timeout)
    text = _content_to_text(response.get("content"))
    if not text:
        raise ModelRuntimeError("Anthropic returned an empty message")
    return text


def _positive_int(value: int | None, *, default: int) -> int:
    if value is None:
        return default
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def _nonnegative_int(value: int | None) -> int | None:
    if value is None:
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def _float_in_range(
    value: float | None,
    *,
    default: float | None,
    min_value: float,
    max_value: float,
) -> float | None:
    if value is None:
        return default
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(parsed):
        return default
    if parsed < min_value or parsed > max_value:
        return default
    return parsed


def _chat_completions_url(base_url: str, provider: str) -> str:
    clean = base_url.rstrip("/")
    if clean.endswith("/chat/completions"):
        return clean
    if provider == "llamacpp" and not clean.endswith("/v1"):
        return f"{clean}/v1/chat/completions"
    return f"{clean}/chat/completions"


def _post_json(
    url: str,
    headers: Mapping[str, str],
    payload: Mapping[str, Any],
    timeout: float,
) -> dict[str, Any]:
    httpx = _import_httpx()

    try:
        with httpx.Client(timeout=_http_timeout(timeout)) as client:
            response = client.post(url, headers=dict(headers), json=dict(payload))
    except httpx.HTTPError as exc:
        raise ModelRuntimeError(str(exc)) from exc
    if response.status_code >= 400:
        detail = response.text.strip().replace("\n", " ")[:500]
        raise ModelRuntimeError(f"http {response.status_code}: {detail}")
    try:
        parsed = response.json()
    except ValueError as exc:
        raise ModelRuntimeError("provider returned invalid JSON") from exc
    if not isinstance(parsed, dict):
        raise ModelRuntimeError("provider returned a non-object JSON response")
    return parsed


def _stream_json_lines(
    url: str,
    headers: Mapping[str, str],
    payload: Mapping[str, Any],
    timeout: float,
) -> Iterator[dict[str, Any]]:
    httpx = _import_httpx()
    try:
        with httpx.Client(timeout=_http_timeout(timeout)) as client, client.stream(
            "POST",
            url,
            headers=dict(headers),
            json=dict(payload),
        ) as response:
            if response.status_code >= 400:
                detail = response.read().decode(errors="replace").strip()
                detail = detail.replace("\n", " ")[:500]
                raise ModelRuntimeError(f"http {response.status_code}: {detail}")
            for line in response.iter_lines():
                frame = _parse_stream_line(line)
                if frame is _STREAM_DONE:
                    break
                if frame is None:
                    continue
                yield frame
    except httpx.HTTPError as exc:
        raise ModelRuntimeError(str(exc)) from exc


def _parse_stream_line(line: str) -> dict[str, Any] | object | None:
    clean = line.strip()
    if not clean or clean.startswith(":"):
        return None
    if clean.startswith("data:"):
        clean = clean[len("data:") :].strip()
    elif not clean.startswith("{"):
        return None
    if clean == "[DONE]":
        return _STREAM_DONE
    try:
        parsed = json.loads(clean)
    except ValueError as exc:
        raise ModelRuntimeError("provider returned invalid streamed JSON") from exc
    if not isinstance(parsed, dict):
        raise ModelRuntimeError("provider returned a non-object streamed JSON response")
    return parsed


def _choice_text_delta(choice: Mapping[str, Any]) -> str:
    delta = choice.get("delta")
    if isinstance(delta, Mapping):
        text = _content_to_text(delta.get("content"), strip=False)
        if text:
            return text
        text = _content_to_text(delta.get("reasoning_content"), strip=False)
        if text:
            return text
        text = _content_to_text(delta.get("reasoning"), strip=False)
        if text:
            return text
    message = choice.get("message")
    if isinstance(message, Mapping):
        text = _content_to_text(message.get("content"), strip=False)
        if text:
            return text
        text = _content_to_text(message.get("reasoning_content"), strip=False)
        if text:
            return text
        text = _content_to_text(message.get("reasoning"), strip=False)
        if text:
            return text
    return ""


def _import_httpx() -> Any:
    try:
        import httpx
    except ModuleNotFoundError as exc:
        raise ModelRuntimeError(
            "Gateway model runtime is missing the httpx dependency. "
            "Rebuild the sidecar after installing gateway runtime dependencies."
        ) from exc
    return httpx


def _http_timeout(timeout: float) -> Any:
    httpx = _import_httpx()
    bounded = max(1.0, float(timeout))
    return httpx.Timeout(bounded, connect=10.0, read=bounded, write=10.0, pool=10.0)


def _content_to_text(content: object, *, strip: bool = True) -> str:
    if isinstance(content, str):
        return content.strip() if strip else content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, Mapping):
                text = item.get("text")
                if isinstance(text, str):
                    parts.append(text)
        joined = "".join(parts)
        return joined.strip() if strip else joined
    return ""
