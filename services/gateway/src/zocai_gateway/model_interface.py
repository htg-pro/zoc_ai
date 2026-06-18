"""The standardized ``Model_Interface`` contract (Requirement 1, R1.1).

This module defines the uniform request/response contract that every model
tier implements. The field set and structure of every object that flows
through the interface — :class:`ModelRequest`, :class:`ModelResponse`, and
:class:`TokenChunk` — are identical across the Local SLM, Edge, and Cloud
tiers, so callers never branch on tier (R1.1).

The :class:`ModelInterface` ``Protocol`` is the abstraction; the concrete
:class:`LocalSLM`, :class:`Edge`, and :class:`Cloud` stubs satisfy it
identically. Tier selection, window sizing, and fallback live in the
``Model_Allocator`` (task 3.4); this module only fixes the contract shape.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field
from enum import Enum
from typing import Protocol, runtime_checkable

__all__ = [
    "ModelTier",
    "ModelRequest",
    "ModelResponse",
    "TokenChunk",
    "ModelInterface",
    "LocalSLM",
    "Edge",
    "Cloud",
]


class ModelTier(str, Enum):
    """The three model-scale classes a run can be routed to (R1.1).

    Values match the ``modelTier`` discriminator carried on the first
    emitted event in the shared Event_Contract.
    """

    LOCAL_SLM = "local-slm"  # 1B-4B
    EDGE = "edge"  # 8B-70B
    CLOUD = "cloud"  # 500B-1T+


# Context-window bounds per tier (tokens), per R1.3-R1.5. Each tier's stub
# reports a window inside its own range so the contract stays tier-uniform
# while honoring the size constraints.
_TIER_CONTEXT_WINDOW: dict[ModelTier, int] = {
    ModelTier.LOCAL_SLM: 4_000,  # bounded to [2_000, 4_000]   (R1.3)
    ModelTier.EDGE: 128_000,  # bounded to [8_000, 128_000]    (R1.4)
    ModelTier.CLOUD: 1_000_000,  # >= 1_000_000                 (R1.5)
}


@dataclass(slots=True)
class ModelRequest:
    """A generation request. Identical in shape for every tier (R1.1)."""

    prompt: str
    context_window: int
    max_tokens: int | None = None
    temperature: float = 0.0
    stop: list[str] = field(default_factory=list)


@dataclass(slots=True)
class ModelResponse:
    """A completed generation. Identical in shape for every tier (R1.1)."""

    text: str
    tier: ModelTier
    prompt_tokens: int = 0
    completion_tokens: int = 0
    finish_reason: str = "stop"


@dataclass(slots=True)
class TokenChunk:
    """One streamed token chunk. Identical in shape for every tier (R1.1)."""

    text: str
    index: int = 0
    done: bool = False


@runtime_checkable
class ModelInterface(Protocol):
    """Uniform contract every model tier exposes (R1.1).

    The method signatures and the property set are identical across tiers;
    only the concrete behavior and the reported :attr:`tier` /
    :attr:`context_window` differ.
    """

    def generate(self, req: ModelRequest) -> ModelResponse:
        """Produce a complete response for ``req``."""
        ...

    def stream(self, req: ModelRequest) -> Iterator[TokenChunk]:
        """Produce an ordered stream of token chunks for ``req``."""
        ...

    @property
    def tier(self) -> ModelTier:
        """The tier this model belongs to."""
        ...

    @property
    def context_window(self) -> int:
        """The context window size, in tokens, this tier allocates."""
        ...


class _BaseStubModel:
    """Shared stub behavior so each tier satisfies the protocol identically.

    Concrete tiers differ only by the :class:`ModelTier` they report; the
    request/response/chunk shapes they produce are byte-for-byte structurally
    identical, which is exactly what cross-tier interface identity (Property 6,
    task 3.11) verifies.
    """

    _tier: ModelTier

    def __init__(self, tier: ModelTier) -> None:
        self._tier = tier

    def generate(self, req: ModelRequest) -> ModelResponse:
        return ModelResponse(
            text="",
            tier=self._tier,
            prompt_tokens=0,
            completion_tokens=0,
            finish_reason="stop",
        )

    def stream(self, req: ModelRequest) -> Iterator[TokenChunk]:
        yield TokenChunk(text="", index=0, done=True)

    @property
    def tier(self) -> ModelTier:
        return self._tier

    @property
    def context_window(self) -> int:
        return _TIER_CONTEXT_WINDOW[self._tier]


class LocalSLM(_BaseStubModel):
    """Local SLM (1B-4B) stub tier implementation (R1.1)."""

    def __init__(self) -> None:
        super().__init__(ModelTier.LOCAL_SLM)


class Edge(_BaseStubModel):
    """Edge (8B-70B) stub tier implementation (R1.1)."""

    def __init__(self) -> None:
        super().__init__(ModelTier.EDGE)


class Cloud(_BaseStubModel):
    """Cloud (500B-1T+) stub tier implementation (R1.1)."""

    def __init__(self) -> None:
        super().__init__(ModelTier.CLOUD)
