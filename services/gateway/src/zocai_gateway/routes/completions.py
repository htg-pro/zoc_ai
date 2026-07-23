"""Inline AI completions endpoint core (Part 3, §3.3).

A browser Monaco `InlineCompletionsProvider` posts the code around the cursor to
``POST /v1/completions``; this module builds a fill-in-the-middle (or fallback)
prompt, calls the active model through the **existing** ``model_runtime``, and
streams the completion back over Server-Sent Events.

Like ``routes/lsp.py`` this core is deliberately free of any FastAPI import: the
request model is a plain Pydantic model, the prompt/cache helpers are pure, and
the model call is a narrow injectable seam, so the whole surface is unit- and
property-tested with a fake ``model_runtime`` (no real model required).
:func:`zocai_gateway.app.create_app` registers the route behind the shared
``require_admission`` dependency and supplies the process-wide cache.

Security posture (R15): the endpoint reuses the Gateway's loopback bind and
shared-token admission — it introduces no new listening interface and is
provably unable to call the model when a request is not admitted (the
dependency rejects it before the handler body) or when its parameters are
invalid (Pydantic validation runs before any model call).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field

from pydantic import BaseModel, ConfigDict, Field

from zocai_gateway.mode_router import AgentRunRequest, Mode
from zocai_gateway.model_runtime import ModelRuntimeError, generate_text_stream

__all__ = [
    "CACHE_TTL_SECONDS",
    "COMPLETION_MAX_TOKENS",
    "COMPLETION_TEMPERATURE",
    "CompletionCache",
    "CompletionRequest",
    "GenerateStream",
    "build_fallback_prompt",
    "build_fim_prompt",
    "completion_stop_sequences",
    "model_supports_fim",
    "stream_completion_events",
]

#: Fixed completion sampling parameters, applied on both the FIM and the
#: fallback paths (R11.4, R13.2).
COMPLETION_TEMPERATURE = 0.1
COMPLETION_MAX_TOKENS = 128

#: Completion_Cache freshness window in seconds (R14.3/R14.5).
CACHE_TTL_SECONDS = 30.0

#: Conservative, case-insensitive markers of model ids that support
#: fill-in-the-middle. Unknown/omitted ids are treated as non-FIM (R13.1), so
#: the confirmed fallback prompt is used unless a model is known to do FIM.
_FIM_MODEL_MARKERS: tuple[str, ...] = (
    "codellama",
    "starcoder",
    "deepseek-coder",
    "codegemma",
    "codestral",
    "stable-code",
    "granite-code",
)


class CompletionRequest(BaseModel):
    """A ``POST /v1/completions`` request body (R11.1).

    The required parameters are the prefix, the suffix, the Language_Id, and the
    file path, each a string (the prefix and suffix may be empty). The optional
    model-selection fields mirror :class:`AgentRunRequest` so the active model
    is called without inventing a second transport shape; when they are absent
    the model call yields an empty completion (R16.1). Pydantic rejects a
    missing or non-string required parameter before any model call (R11.2).
    """

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    prefix: str
    suffix: str
    language: str
    file_path: str = Field(alias="filePath")
    provider: str | None = None
    model: str | None = None
    api_key: str | None = Field(default=None, alias="apiKey")
    base_url: str | None = Field(default=None, alias="baseUrl")


def model_supports_fim(provider: str | None, model: str | None) -> bool:
    """R11.3/R13.1: whether the active model supports fill-in-the-middle.

    A pure predicate over a conservative, case-insensitive model-id allowlist;
    an unknown or omitted model id returns ``False`` (→ the fallback prompt).
    No network probe is performed.
    """
    if not model:
        return False
    identifier = model.lower()
    if any(marker in identifier for marker in _FIM_MODEL_MARKERS):
        return True
    # Qwen coder variants (e.g. "qwen2.5-coder") support FIM.
    return "qwen" in identifier and "coder" in identifier


def build_fim_prompt(prefix: str, suffix: str) -> str:
    """R11.3: the fill-in-the-middle prompt ``<PRE>{prefix}<SUF>{suffix}<MID>``."""
    return f"<PRE>{prefix}<SUF>{suffix}<MID>"


def build_fallback_prompt(prefix: str, suffix: str, language: str) -> str:
    """R13.1: a "complete this code" prompt for a model without FIM support.

    Embeds the language and the before/after-cursor code and asks the model for
    only the gap text between them, so a non-FIM (e.g. cloud chat) model still
    produces an inline completion.
    """
    lang = language or "code"
    return (
        f"You are a code completion engine for {lang}. "
        "Complete the code at the cursor marked <CURSOR>. "
        "Reply with ONLY the code that should be inserted at the cursor — "
        "no explanation, no markdown fences, no repetition of the surrounding code.\n\n"
        f"{prefix}<CURSOR>{suffix}"
    )


def completion_stop_sequences(language: str) -> list[str]:
    """R11.4: at least one stop sequence for the completion call.

    A double newline ends the completion at a blank line and a code fence stops
    a chat model from wrapping the snippet in markdown. ``language`` is accepted
    for future per-language tuning; the contract only requires ≥1 sequence.
    """
    _ = language
    return ["\n\n", "```"]


CacheKey = tuple[str, str, str]


@dataclass
class CompletionCache:
    """In-process, per-``(prefix, suffix, model)`` completion cache (R14).

    Stores only non-empty completions (R14.2); a read returns a stored entry
    only while it is younger than :data:`CACHE_TTL_SECONDS` (R14.3) and never
    rewrites the stored timestamp (R14.4); an entry at or past the TTL is not
    returned, so the caller recomputes (R14.5).
    """

    _entries: dict[CacheKey, tuple[str, float]] = field(default_factory=dict)

    def get(self, key: CacheKey, now: float) -> str | None:
        entry = self._entries.get(key)
        if entry is None:
            return None
        text, stored = entry
        if now - stored >= CACHE_TTL_SECONDS:  # R14.5: aged out → recompute.
            return None
        return text  # R14.4: age left unchanged (no rewrite on read).

    def put(self, key: CacheKey, text: str, now: float) -> None:
        if not text:  # R14.2: never store an empty completion.
            return
        self._entries[key] = (text, now)


#: The model-call seam (injected in tests with a fake token generator / raiser).
GenerateStream = Callable[..., str | None]


def _token_event(chunk: str) -> dict[str, str]:
    """One token SSE event carrying a JSON-wrapped chunk (R12.1)."""
    return {"event": "token", "data": json.dumps({"text": chunk})}


def _done_event() -> dict[str, str]:
    """The distinct terminal SSE event (R12.3)."""
    return {"event": "done", "data": "{}"}


async def stream_completion_events(
    request: CompletionRequest,
    *,
    cache: CompletionCache,
    generate_stream: GenerateStream = generate_text_stream,
    now: Callable[[], float] = time.monotonic,
) -> AsyncIterator[dict[str, str]]:
    """Yield the SSE frames for one completion request (R12, R13.3, R14, R16).

    Emits one ``token`` event per model chunk in emission order, then exactly
    one distinct ``done`` terminal. A fresh non-empty cache hit is streamed with
    no model call; otherwise the model is called in a worker thread whose
    ``on_token`` pushes chunks onto a queue drained here. Every failure mode —
    no provider/model, an error before or after the first token — terminates
    with a single ``done`` and no error event (fails quiet).
    """
    model = (request.model or "").strip()
    key: CacheKey = (request.prefix, request.suffix, model)

    cached = cache.get(key, now())
    if cached is not None:
        # R14.3/R14.4: fresh non-empty cache hit — stream it, no model call.
        yield _token_event(cached)
        yield _done_event()
        return

    prompt = (
        build_fim_prompt(request.prefix, request.suffix)
        if model_supports_fim(request.provider, model)
        else build_fallback_prompt(request.prefix, request.suffix, request.language)
    )
    run = AgentRunRequest(
        prompt=prompt,
        mode=Mode.ASK,  # irrelevant to generate_text_stream; satisfies the model.
        provider=request.provider,
        model=request.model,
        api_key=request.api_key,
        base_url=request.base_url,
        temperature=COMPLETION_TEMPERATURE,  # R11.4/R13.2
        max_tokens=COMPLETION_MAX_TOKENS,  # R11.4/R13.2
    )

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[object] = asyncio.Queue()
    done_sentinel = object()
    chunks: list[str] = []

    def on_token(chunk: str) -> None:
        # Producer runs on the worker thread; hand chunks to the loop safely
        # (the app.py `_Run._put` pattern).
        loop.call_soon_threadsafe(queue.put_nowait, chunk)

    def worker() -> str | None:
        return generate_stream(
            run,
            on_token=on_token,
            stop=completion_stop_sequences(request.language),
        )

    async def run_worker() -> None:
        try:
            await asyncio.to_thread(worker)
        except ModelRuntimeError:
            # R16.2/R16.5: fail quiet — any tokens already emitted stay; no
            # error frame is sent to the client.
            pass
        except Exception:  # pragma: no cover - defensive boundary
            pass
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, done_sentinel)

    task = asyncio.create_task(run_worker())
    try:
        while True:
            item = await queue.get()
            if item is done_sentinel:
                break
            chunk = item if isinstance(item, str) else ""
            if chunk:  # R12.1/R12.2: one event per non-empty chunk, in order.
                chunks.append(chunk)
                yield _token_event(chunk)
        full = "".join(chunks)
        if full:
            cache.put(key, full, now())  # R14.1: store iff non-empty.
        # R12.3/R12.4/R16: exactly one terminal, no error event, even when empty.
        yield _done_event()
    finally:
        if not task.done():
            task.cancel()
        with contextlib.suppress(Exception):
            await task
