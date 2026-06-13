"""Provider + model registry.

Holds initialised provider adapters keyed by `ProviderKind` and lets callers
resolve `(provider, model)` pairs to the underlying adapter and descriptor.
"""

from __future__ import annotations

from dataclasses import dataclass

from shared_schema.models import (
    ModelDescriptor,
    ProviderDescriptor,
    ProviderKind,
)

from ..config import Settings
from .anthropic import AnthropicProvider
from .base import LLMProvider, ProviderError
from .gemini import GeminiProvider
from .llamacpp import LlamaCppProvider
from .mock import MockProvider
from .openai import OpenAIProvider


@dataclass(slots=True)
class ProviderEntry:
    descriptor: ProviderDescriptor
    impl: LLMProvider


class ProviderRegistry:
    def __init__(self) -> None:
        self._entries: dict[ProviderKind, ProviderEntry] = {}

    def register(self, kind: ProviderKind, provider: LLMProvider, *, display_name: str) -> None:
        descriptor = ProviderDescriptor(
            kind=kind,
            display_name=display_name,
            base_url=provider.base_url,
            requires_api_key=provider.api_key is None and kind in {
                ProviderKind.openai,
                ProviderKind.anthropic,
                ProviderKind.gemini,
            },
            models=provider.models(),
        )
        self._entries[kind] = ProviderEntry(descriptor=descriptor, impl=provider)

    def list(self) -> list[ProviderDescriptor]:
        descriptors: list[ProviderDescriptor] = []
        for e in self._entries.values():
            descriptors.append(
                ProviderDescriptor(
                    kind=e.descriptor.kind,
                    display_name=e.descriptor.display_name,
                    base_url=e.impl.base_url,
                    requires_api_key=e.descriptor.requires_api_key,
                    models=e.impl.models(),
                )
            )
        return descriptors

    def has(self, kind: ProviderKind | str) -> bool:
        return self._coerce(kind) in self._entries

    def get(self, kind: ProviderKind | str) -> LLMProvider:
        k = self._coerce(kind)
        if k not in self._entries:
            raise ProviderError(f"provider not registered: {k.value}")
        return self._entries[k].impl

    def resolve(self, provider: str | None, model: str | None) -> tuple[LLMProvider, ModelDescriptor]:
        if not provider:
            raise ProviderError("provider is required")
        impl = self.get(provider)
        catalog = impl.models()
        if not catalog:
            raise ProviderError(f"provider {provider} exposes no models")
        if model is None:
            return impl, catalog[0]
        for m in catalog:
            if m.model_id == model:
                return impl, m
        # Allow unknown models on providers with dynamic catalogues (llama.cpp).
        # Fall back to a synthetic descriptor.
        if impl.kind in {"llamacpp"}:
            from shared_schema.models import ModelCapability  # local

            return impl, ModelDescriptor(
                provider=ProviderKind(impl.kind),
                model_id=model,
                display_name=model,
                capability=ModelCapability(context_window=8192, supports_tools=True),
            )
        raise ProviderError(f"model {model} not found on provider {provider}")

    @staticmethod
    def _coerce(kind: ProviderKind | str) -> ProviderKind:
        return kind if isinstance(kind, ProviderKind) else ProviderKind(kind)


def build_default_registry(settings: Settings) -> ProviderRegistry:
    reg = ProviderRegistry()
    reg.register(ProviderKind.mock, MockProvider(), display_name="Mock")
    reg.register(
        ProviderKind.llamacpp,
        LlamaCppProvider(
            base_url=settings.llamacpp_base_url,
            state_path=settings.llamacpp_state_path,
        ),
        display_name="llama.cpp",
    )

    reg.register(
        ProviderKind.openai,
        OpenAIProvider(api_key=settings.openai_api_key),
        display_name="OpenAI",
    )
    reg.register(
        ProviderKind.anthropic,
        AnthropicProvider(api_key=settings.anthropic_api_key),
        display_name="Anthropic",
    )
    reg.register(
        ProviderKind.gemini,
        GeminiProvider(api_key=settings.gemini_api_key),
        display_name="Gemini",
    )
    return reg
