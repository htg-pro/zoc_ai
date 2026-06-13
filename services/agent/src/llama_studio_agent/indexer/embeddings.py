"""Embedding adapters.

Two implementations:
  * `hash_embed` / `HashEmbedder` — deterministic, dependency-free; useful
    as an offline fallback and for tests. The embedding is a hashed-bag-of-
    tokens vector, L2-normalised. Quality is modest but stable.
  * `ProviderEmbedder` — delegates to an `LLMProvider.embed()` call (OpenAI,
    llama.cpp) for real semantic embeddings.

Default embedder selection
--------------------------
`resolve_embedder()` is the single entry point used by the running agent
to pick an embedder at startup. The policy is:

  1. If `Settings.embedding_provider` is set explicitly (e.g. ``openai``,
     ``llamacpp``, or ``hash``), honour it.
  2. Otherwise auto-detect a local embedding server. If a llama.cpp server
     is reachable at `Settings.llamacpp_base_url` and exposes an embedding
     model (``nomic-embed-text`` by preference), use it — this gives a
     fully offline, no-API-key default with real semantic quality.
  3. Otherwise, if `Settings.openai_api_key` is configured, use OpenAI's
     ``text-embedding-3-small`` (1536-dim, ~$0.02/M tokens), which is
     the cheapest production-quality cloud embedder we support.
  4. Otherwise fall back to the deterministic `HashEmbedder`. Search
     still works but quality is modest. A loud log line tells the
     operator how to enable a real model.

The returned embedder is wrapped in a `ResilientEmbedder` for cloud /
network-backed providers so a transient outage (auth failure, server
down) degrades to the hash fallback at runtime instead of crashing the
indexer; the indexer wires a callback that clears stale vectors when
that happens so cosine comparisons stay sane.

To force a fully local setup, start llama-server with an embedding model::

    llama-server -m nomic-embed-text.gguf --port 8080
    LLAMA_STUDIO_EMBEDDING_PROVIDER=llamacpp llama-studio-agent

`nomic-embed-text` (768-dim) is a strong, small, Apache-2.0 default for
local code embeddings.
"""

from __future__ import annotations

import abc
import hashlib
import logging
import math
import re
from collections.abc import Callable
from typing import TYPE_CHECKING

import httpx

from ..providers.base import LLMProvider, ProviderError

if TYPE_CHECKING:  # pragma: no cover
    from ..config import Settings
    from ..providers.registry import ProviderRegistry

_TOKEN_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]+|\d+")

_log = logging.getLogger(__name__)


# Sensible (model, dim) defaults per provider, used when the operator
# selects a provider but doesn't pin a model.
DEFAULT_EMBEDDING_MODELS: dict[str, tuple[str, int]] = {
    "openai": ("text-embedding-3-small", 1536),
    "llamacpp": ("nomic-embed-text", 768),
}


def hash_embed(text: str, dim: int = 256) -> list[float]:
    vec = [0.0] * dim
    for tok in _TOKEN_RE.findall(text.lower()):
        for n in (tok, tok[:4], tok[-4:]):
            h = int.from_bytes(hashlib.blake2b(n.encode("utf-8"), digest_size=8).digest(), "little")
            sign = 1.0 if (h & 1) else -1.0
            vec[(h >> 1) % dim] += sign
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]


class Embedder(abc.ABC):
    dim: int
    # Short identifier of the backing model family, e.g. "hash",
    # "openai", "llamacpp". Surfaced in IndexStatus so the UI can tell the
    # user whether semantic search is running on a real model or the
    # offline hash fallback.
    kind: str = "unknown"
    # Concrete model id, or None for the dependency-free hash embedder.
    model: str | None = None

    @abc.abstractmethod
    async def embed(self, texts: list[str]) -> list[list[float]]:
        ...

    @property
    def is_fallback(self) -> bool:
        """True when the active embedder is the deterministic hash stub,
        which gives much weaker semantic results than a real model."""

        return self.kind == "hash"

    @property
    def signature(self) -> str:
        """Stable identifier used to detect when the embedding space
        changed between agent runs (so the indexer can rebuild)."""

        return f"{type(self).__name__}:{self.dim}"


class HashEmbedder(Embedder):
    kind = "hash"
    model = None

    def __init__(self, dim: int = 256) -> None:
        self.dim = dim

    async def embed(self, texts: list[str]) -> list[list[float]]:
        return [hash_embed(t, self.dim) for t in texts]

    @property
    def signature(self) -> str:
        return f"hash:{self.dim}"


class ProviderEmbedder(Embedder):
    def __init__(self, provider: LLMProvider, model: str, dim: int) -> None:
        self.provider = provider
        self.model = model
        self.dim = dim
        self.kind = provider.kind

    async def embed(self, texts: list[str]) -> list[list[float]]:
        vectors = await self.provider.embed(texts, model=self.model)
        # Normalise — cosine similarity assumes unit vectors.
        out: list[list[float]] = []
        for v in vectors:
            norm = math.sqrt(sum(x * x for x in v)) or 1.0
            out.append([x / norm for x in v])
        return out

    @property
    def signature(self) -> str:
        return f"{self.provider.kind}:{self.model}:{self.dim}"


class ResilientEmbedder(Embedder):
    """Wraps a primary embedder; on failure, permanently degrades to a
    hash fallback for the lifetime of the process.

    Mixing vectors from two embedding spaces in the same store would make
    cosine similarity meaningless, so on degradation we invoke
    `on_degrade(new_signature)` — the indexer uses that to wipe the
    existing vectors and reset `last_indexed_at` before any new vectors
    are written.
    """

    def __init__(
        self,
        primary: Embedder,
        fallback: Embedder,
        *,
        on_degrade: Callable[[str], None] | None = None,
    ) -> None:
        self.primary = primary
        self.fallback = fallback
        self.on_degrade = on_degrade
        self._degraded = False

    @property
    def dim(self) -> int:  # type: ignore[override]
        return self.fallback.dim if self._degraded else self.primary.dim

    @property
    def kind(self) -> str:  # type: ignore[override]
        return self.fallback.kind if self._degraded else self.primary.kind

    @property
    def model(self) -> str | None:  # type: ignore[override]
        return self.fallback.model if self._degraded else self.primary.model

    @property
    def signature(self) -> str:
        return self.fallback.signature if self._degraded else self.primary.signature

    @property
    def degraded(self) -> bool:
        return self._degraded

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not self._degraded:
            try:
                return await self.primary.embed(texts)
            except ProviderError as exc:
                _log.warning(
                    "indexer: embedder %s failed (%s); degrading to hash fallback for this session",
                    self.primary.signature,
                    exc,
                )
                self._degraded = True
                if self.on_degrade is not None:
                    try:
                        self.on_degrade(self.signature)
                    except Exception:
                        _log.exception("indexer: on_degrade callback failed")
        return await self.fallback.embed(texts)


# Substrings that mark a llama.cpp model as suitable for embeddings.
# Used by the local auto-detection path so we don't try to "embed" with
# a chat-only model when llama.cpp is running but no embedding model is
# loaded.
_LLAMACPP_EMBED_HINTS = ("embed", "bge", "minilm", "e5", "gte")


def _probe_llamacpp_embed_model(
    base_url: str,
    *,
    preferred: str = "nomic-embed-text",
    timeout: float = 0.75,
) -> str | None:
    """If a llama.cpp server is reachable and exposes an embedding model,
    return that model id. Otherwise return None.

    Synchronous on purpose — this runs once per indexer creation, on the
    fast path during agent startup. Network failures are swallowed.
    """

    url = base_url.rstrip("/") + "/v1/models"
    try:
        resp = httpx.get(url, timeout=timeout)
        resp.raise_for_status()
    except (httpx.HTTPError, OSError):
        return None
    try:
        data = resp.json()
        models = data.get("data") or []
    except ValueError:
        return None
    names: list[str] = []
    for m in models:
        model_id = m.get("id")
        if isinstance(model_id, str):
            names.append(model_id)
    if not names:
        return None
    # Prefer the canonical default if loaded.
    for n in names:
        if n == preferred or n.startswith(preferred + ":"):
            return preferred
    for n in names:
        low = n.lower()
        if any(h in low for h in _LLAMACPP_EMBED_HINTS):
            return n.split(":", 1)[0]
    return None


def resolve_embedder(
    settings: Settings,
    registry: ProviderRegistry,
) -> Embedder:
    """Return the embedder selected by current settings.

    See module docstring for the policy. Never raises: any configuration
    or registry issue is logged and the deterministic hash embedder is
    returned so the indexer always works.
    """

    explicit = (settings.embedding_provider or "").strip().lower() or None
    hash_dim = int(settings.embedding_dim) if settings.embedding_dim else 256
    fallback = HashEmbedder(hash_dim)

    if explicit in {None, "auto"}:
        # 1) Local llama.cpp with an embedding model loaded.
        if registry.has("llamacpp"):
            llamacpp_model = _probe_llamacpp_embed_model(settings.llamacpp_base_url)
            if llamacpp_model:
                _log.info(
                    "indexer: auto-detected local llama.cpp embedding model %r",
                    llamacpp_model,
                )
                primary = _build_provider_embedder(
                    registry, "llamacpp", llamacpp_model, hash_dim
                )
                return _wrap_resilient(primary, fallback)
        # 2) Cloud OpenAI if an API key is configured.
        if settings.openai_api_key and registry.has("openai"):
            primary = _build_provider_embedder(
                registry, "openai", settings.embedding_model, hash_dim
            )
            return _wrap_resilient(primary, fallback)
        # 3) Hash fallback.
        _log.warning(
            "indexer: no real embedding model available — falling back to "
            "the deterministic hash embedder. For full semantic search "
            "start llama-server with nomic-embed-text.gguf, or "
            "set LLAMA_STUDIO_OPENAI_API_KEY."
        )
        return fallback

    if explicit in {"hash", "none", "off"}:
        return fallback

    primary = _build_provider_embedder(
        registry, explicit, settings.embedding_model, hash_dim
    )
    return _wrap_resilient(primary, fallback)


def _wrap_resilient(primary: Embedder, fallback: Embedder) -> Embedder:
    """Wrap real-provider embedders in a ResilientEmbedder so a runtime
    failure degrades to hash instead of crashing the indexer. If the
    resolver already chose the hash embedder, return it directly."""

    if isinstance(primary, HashEmbedder):
        return primary
    return ResilientEmbedder(primary, fallback)


def _build_provider_embedder(
    registry: ProviderRegistry,
    provider_kind: str,
    model_override: str | None,
    hash_dim: int,
) -> Embedder:
    try:
        provider = registry.get(provider_kind)
    except ProviderError as exc:
        _log.warning(
            "indexer: embedding provider %r unavailable (%s); falling back to hash embedder",
            provider_kind,
            exc,
        )
        return HashEmbedder(hash_dim)

    default = DEFAULT_EMBEDDING_MODELS.get(provider_kind)
    if model_override:
        model = model_override
        dim = default[1] if default else hash_dim
    elif default:
        model, dim = default
    else:
        _log.warning(
            "indexer: provider %r has no default embedding model and none was "
            "configured; falling back to hash embedder. Set "
            "LLAMA_STUDIO_EMBEDDING_MODEL to enable semantic embeddings.",
            provider_kind,
        )
        return HashEmbedder(hash_dim)
    return ProviderEmbedder(provider, model, dim)
