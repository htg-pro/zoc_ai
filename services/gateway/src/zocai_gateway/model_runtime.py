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
from collections.abc import Callable, Iterator, Mapping
from typing import Any

from zocai_gateway.mode_router import AgentRunRequest

__all__ = ["ModelRuntimeError", "generate_text", "generate_text_stream"]

_DEFAULT_MAX_TOKENS = 512
_STREAM_DONE = object()


class ModelRuntimeError(RuntimeError):
    """Raised when a configured model endpoint cannot produce text."""


def generate_text(
    request: AgentRunRequest,
    *,
    system_prompt: str | None = None,
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
        timeout=timeout,
    )


def generate_text_stream(
    request: AgentRunRequest,
    *,
    system_prompt: str | None = None,
    timeout: float = 60.0,
    on_token: Callable[[str], None] | None = None,
) -> str | None:
    """Generate text and emit OpenAI-compatible stream chunks as they arrive."""

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
    )


def _openai_compatible_chat(
    *,
    request: AgentRunRequest,
    prompt: str,
    provider: str,
    model: str,
    api_key: str,
    base_url: str,
    system_prompt: str | None,
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

    chunks: list[str] = []
    saw_choice = False
    for frame in _stream_json_lines(
        _chat_completions_url(base_url, provider),
        headers,
        payload,
        timeout,
    ):
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
        with httpx.Client(timeout=_http_timeout(timeout)) as client:
            with client.stream(
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
