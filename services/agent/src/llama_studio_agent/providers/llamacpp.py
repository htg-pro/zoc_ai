"""llama.cpp server adapter.

`llama-server` exposes an OpenAI-compatible `/v1/chat/completions` endpoint,
so we reuse `OpenAIProvider` with a different default base URL.

Lifecycle note: the **desktop shell** (apps/desktop/src/llama_server.rs) owns
the `llama-server` subprocess. It's the only thing that decides which `.gguf`
is loaded into VRAM at any given moment. This Python adapter is intentionally
unaware of the loaded model and forwards whatever `model_id` the client picked
to llama-server — llama-server doesn't validate the `model` field because it
only ever has one model in memory, so this is safe.

We still expose a one-entry catalogue (`model_id="local"`) because the
provider registry at services/agent/src/llama_studio_agent/providers/registry.py
rejects providers whose `models()` returns an empty list. The registry's
`resolve()` already short-circuits unknown llamacpp model ids into a synthetic
descriptor, so the user's actual selection is passed through transparently.
"""

from __future__ import annotations

import json
import os
from collections.abc import AsyncIterator
from dataclasses import replace
from pathlib import Path
from typing import Any

import httpx
from shared_schema.models import ModelCapability, ModelDescriptor, ProviderKind

from .base import ChatRequest, ChatResponse, StreamChunk
from .openai import OpenAIProvider

RUNTIME_STATE_FILENAME = "llamacpp-runtime.json"


def _as_v1_url(base_url: str) -> str:
    root = base_url.rstrip("/")
    return root if root.endswith("/v1") else f"{root}/v1"


def _root_url(v1_url: str) -> str:
    root = v1_url.rstrip("/")
    if root.endswith("/v1"):
        root = root[: -len("/v1")]
    return root


def _default_state_path() -> Path:
    explicit = os.environ.get("LLAMA_STUDIO_LLAMACPP_STATE_PATH")
    if explicit:
        return Path(explicit)
    data_dir = os.environ.get("LLAMA_STUDIO_DATA_DIR")
    if data_dir:
        return Path(data_dir) / RUNTIME_STATE_FILENAME
    return Path.home() / ".llama-studio" / RUNTIME_STATE_FILENAME


class LlamaCppProvider(OpenAIProvider):
    kind = "llamacpp"

    def __init__(
        self,
        *,
        base_url: str = "http://127.0.0.1:8080",
        state_path: str | None = None,
    ) -> None:
        self.state_path = Path(state_path) if state_path else _default_state_path()
        super().__init__(
            base_url=_as_v1_url(base_url),
            api_key=None,
            catalog=[
                ModelDescriptor(
                    provider=ProviderKind.llamacpp,
                    model_id="local",
                    # Honest naming: this entry is a placeholder. The real
                    # model is whatever the desktop shell's
                    # LlamaServerSupervisor most recently loaded. The
                    # frontend shows the actual id via the llamacpp://status
                    # event, not this string.
                    display_name="llama.cpp (currently loaded)",
                    capability=ModelCapability(
                        context_window=8192,
                        supports_tools=True,
                        supports_streaming=True,
                    ),
                )
            ],
        )

    def _read_state(self) -> dict[str, Any]:
        try:
            raw = json.loads(self.state_path.read_text("utf-8"))
        except (OSError, ValueError):
            return {}
        return raw if isinstance(raw, dict) else {}

    def _refresh_base_url(self) -> dict[str, Any]:
        state = self._read_state()
        root = state.get("base_url")
        if not isinstance(root, str) or not root.strip():
            host = state.get("host")
            port = state.get("port")
            if isinstance(host, str) and isinstance(port, int):
                root = f"http://{host}:{port}"
        if isinstance(root, str) and root.strip():
            self.base_url = _as_v1_url(root)
        return state

    def _with_runtime_defaults(self, request: ChatRequest) -> ChatRequest:
        state = self._refresh_base_url()
        updates: dict[str, object] = {}
        if isinstance(state.get("temperature"), int | float):
            updates["temperature"] = float(state["temperature"])
        if isinstance(state.get("top_p"), int | float):
            updates["top_p"] = float(state["top_p"])
        if isinstance(state.get("top_k"), int | float):
            updates["top_k"] = int(state["top_k"])
        if isinstance(state.get("repeat_penalty"), int | float):
            updates["repeat_penalty"] = float(state["repeat_penalty"])
        if isinstance(state.get("max_tokens"), int):
            updates["max_tokens"] = int(state["max_tokens"])
        return replace(request, **updates) if updates else request

    def models(self) -> list[ModelDescriptor]:
        state = self._refresh_base_url()
        context_window = int(state.get("n_ctx") or 8192)
        try:
            resp = httpx.get(f"{self.base_url}/models", timeout=0.75)
            resp.raise_for_status()
            data = resp.json()
        except (httpx.HTTPError, OSError, ValueError):
            data = {}
        if not isinstance(data, dict):
            data = {}

        out: list[ModelDescriptor] = []
        for item in data.get("data") or []:
            model_id = item.get("id") if isinstance(item, dict) else None
            if not isinstance(model_id, str) or not model_id:
                continue
            out.append(
                ModelDescriptor(
                    provider=ProviderKind.llamacpp,
                    model_id=model_id,
                    display_name=model_id,
                    capability=ModelCapability(
                        context_window=context_window,
                        supports_tools=True,
                        supports_streaming=True,
                    ),
                )
            )
        if out:
            return out

        loaded_id = state.get("loaded_model_id")
        loaded_path = state.get("loaded_model_path")
        model_id = loaded_id if isinstance(loaded_id, str) and loaded_id else "local"
        display_name = model_id
        if isinstance(loaded_path, str) and loaded_path:
            display_name = Path(loaded_path).stem or model_id
        return [
            ModelDescriptor(
                provider=ProviderKind.llamacpp,
                model_id=model_id,
                display_name=display_name,
                capability=ModelCapability(
                    context_window=context_window,
                    supports_tools=True,
                    supports_streaming=True,
                ),
            )
        ]

    async def chat(self, request: ChatRequest) -> ChatResponse:
        return await super().chat(self._with_runtime_defaults(request))

    async def stream(self, request: ChatRequest) -> AsyncIterator[StreamChunk]:
        return await super().stream(self._with_runtime_defaults(request))

    async def embed(self, texts: list[str], *, model: str) -> list[list[float]]:
        self._refresh_base_url()
        return await super().embed(texts, model=model)

    async def health(self) -> bool:
        """Probe llama-server's `/health` endpoint.

        Returns True only if the server responds with 2xx within the timeout.
        Used by the registry / status surfaces to gate sends when nothing is
        loaded yet (the desktop shell may not have spawned llama-server, or
        the user may have explicitly unloaded).
        """
        self._refresh_base_url()
        # llama-server mounts /health at the root, not under /v1.
        root = _root_url(self.base_url)
        url = f"{root}/health"
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                resp = await client.get(url)
                return resp.is_success
        except (httpx.HTTPError, OSError):
            return False
