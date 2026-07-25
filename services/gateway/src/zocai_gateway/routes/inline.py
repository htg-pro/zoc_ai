"""POST /v1/agent/inline-edit — Cmd+K inline edit (Part 8.2).

Given a selected snippet + an instruction (and a little surrounding context),
stream ONLY the replacement code back over Server-Sent Events. Like
:mod:`zocai_gateway.routes.completions`, the core is FastAPI-free — a Pydantic
request, pure prompt/fence helpers, and an injectable model seam — so it is
unit-tested with a fake model. ``zocai_gateway.app.create_app`` registers the
route behind ``require_admission``.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import re
from collections.abc import AsyncIterator, Callable

from pydantic import BaseModel, ConfigDict, Field

from zocai_gateway.mode_router import AgentRunRequest, Mode
from zocai_gateway.model_runtime import ModelRuntimeError, generate_text_stream

__all__ = [
    "INLINE_EDIT_MAX_TOKENS",
    "INLINE_EDIT_SYSTEM",
    "INLINE_EDIT_TEMPERATURE",
    "GenerateStream",
    "InlineEditRequest",
    "build_inline_edit_prompt",
    "stream_inline_edit_events",
    "strip_code_fences",
]

#: Deterministic, bounded edit sampling (roadmap §8.2: max_tokens 512).
INLINE_EDIT_TEMPERATURE = 0.1
INLINE_EDIT_MAX_TOKENS = 512

INLINE_EDIT_SYSTEM = (
    "You are a code editor. The user selected code and gave an instruction. "
    "Return ONLY the replacement code — no markdown, no code fences, no explanation."
)


class InlineEditRequest(BaseModel):
    """One Cmd+K inline-edit request over the selected code + its context."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    instruction: str
    code: str = ""  # the selected code to transform
    prefix: str = ""  # up to ~200 chars before the selection
    suffix: str = ""  # up to ~200 chars after the selection
    language: str = ""
    file_path: str = Field(default="", alias="filePath")
    provider: str | None = None
    model: str | None = None
    api_key: str | None = Field(default=None, alias="apiKey")
    base_url: str | None = Field(default=None, alias="baseUrl")


def build_inline_edit_prompt(request: InlineEditRequest) -> str:
    """Build the replacement-only prompt from the selection + context (§8.2)."""
    parts = [INLINE_EDIT_SYSTEM, ""]
    if request.language:
        parts.append(f"Language: {request.language}")
    if request.prefix:
        parts.append(f"Context before:\n{request.prefix}")
    parts.append(f"Selected code:\n{request.code}")
    if request.suffix:
        parts.append(f"Context after:\n{request.suffix}")
    parts.append(f"Instruction: {request.instruction}")
    parts.append("Replacement code:")
    return "\n".join(parts)


_FENCE_RE = re.compile(r"^\s*```[^\n]*\n(.*?)\n?```\s*$", re.DOTALL)


def strip_code_fences(text: str) -> str:
    """Remove a wrapping ```lang … ``` fence if the model added one, else return
    the text unchanged (models sometimes wrap despite the instruction)."""
    match = _FENCE_RE.match(text)
    return match.group(1) if match else text


#: The model-call seam (injected in tests with a fake token generator / raiser).
GenerateStream = Callable[..., str | None]


def _token_event(chunk: str) -> dict[str, str]:
    return {"event": "token", "data": json.dumps({"text": chunk})}


def _done_event(text: str) -> dict[str, str]:
    """The distinct terminal SSE event, carrying the fence-stripped replacement."""
    return {"event": "done", "data": json.dumps({"text": text})}


async def stream_inline_edit_events(
    request: InlineEditRequest,
    *,
    generate_stream: GenerateStream = generate_text_stream,
) -> AsyncIterator[dict[str, str]]:
    """Yield SSE frames for one inline edit: one ``token`` per model chunk in
    order, then exactly one ``done`` carrying the fence-stripped full
    replacement. Fails quiet (any model outcome ends with a single ``done``, no
    error frame)."""
    run = AgentRunRequest(
        prompt=build_inline_edit_prompt(request),
        mode=Mode.ASK,  # irrelevant to generate_text_stream; satisfies the model shape.
        provider=request.provider,
        model=request.model,
        api_key=request.api_key,
        base_url=request.base_url,
        temperature=INLINE_EDIT_TEMPERATURE,
        max_tokens=INLINE_EDIT_MAX_TOKENS,
    )

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[object] = asyncio.Queue()
    done_sentinel = object()
    chunks: list[str] = []

    def on_token(chunk: str) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, chunk)

    def worker() -> str | None:
        return generate_stream(
            run,
            on_token=on_token,
            system_prompt=INLINE_EDIT_SYSTEM,
        )

    async def run_worker() -> None:
        try:
            await asyncio.to_thread(worker)
        except ModelRuntimeError:
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
            if chunk:
                chunks.append(chunk)
                yield _token_event(chunk)
        yield _done_event(strip_code_fences("".join(chunks)))
    finally:
        if not task.done():
            task.cancel()
        with contextlib.suppress(Exception):
            await task
