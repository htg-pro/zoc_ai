"""Unit tests for the ``Model_Interface`` contract (task 3.3, R1.1).

These example-based tests assert that the request/response contract is
identical in field set and structure across the Local SLM, Edge, and Cloud
tiers, and that each concrete tier stub satisfies the ``ModelInterface``
protocol. The exhaustive cross-input cross-tier identity check lives in the
dedicated property test (task 3.11, Property 6).
"""

from __future__ import annotations

from dataclasses import fields

import pytest

from zocai_gateway.model_interface import (
    Cloud,
    Edge,
    LocalSLM,
    ModelInterface,
    ModelRequest,
    ModelResponse,
    ModelTier,
    TokenChunk,
)

ALL_TIERS = [LocalSLM(), Edge(), Cloud()]


def test_model_tier_has_exactly_three_classes() -> None:
    assert [t.value for t in ModelTier] == ["local-slm", "edge", "cloud"]


@pytest.mark.parametrize("model", ALL_TIERS)
def test_every_tier_satisfies_the_protocol(model: ModelInterface) -> None:
    assert isinstance(model, ModelInterface)


@pytest.mark.parametrize("model", ALL_TIERS)
def test_tier_property_matches_concrete_class(model: ModelInterface) -> None:
    expected = {
        "LocalSLM": ModelTier.LOCAL_SLM,
        "Edge": ModelTier.EDGE,
        "Cloud": ModelTier.CLOUD,
    }[type(model).__name__]
    assert model.tier is expected


@pytest.mark.parametrize("model", ALL_TIERS)
def test_context_window_is_within_tier_bounds(model: ModelInterface) -> None:
    bounds = {
        ModelTier.LOCAL_SLM: (2_000, 4_000),  # R1.3
        ModelTier.EDGE: (8_000, 128_000),  # R1.4
        ModelTier.CLOUD: (1_000_000, None),  # R1.5 (>= 1_000_000)
    }[model.tier]
    low, high = bounds
    assert model.context_window >= low
    if high is not None:
        assert model.context_window <= high


@pytest.mark.parametrize("model", ALL_TIERS)
def test_generate_returns_identical_response_shape(model: ModelInterface) -> None:
    req = ModelRequest(prompt="hi", context_window=model.context_window)
    resp = model.generate(req)
    assert isinstance(resp, ModelResponse)
    assert {f.name for f in fields(resp)} == {
        "text",
        "tier",
        "prompt_tokens",
        "completion_tokens",
        "finish_reason",
    }
    assert resp.tier is model.tier


@pytest.mark.parametrize("model", ALL_TIERS)
def test_stream_yields_identical_chunk_shape(model: ModelInterface) -> None:
    req = ModelRequest(prompt="hi", context_window=model.context_window)
    chunks = list(model.stream(req))
    assert chunks, "stream must yield at least one chunk"
    for chunk in chunks:
        assert isinstance(chunk, TokenChunk)
        assert {f.name for f in fields(chunk)} == {"text", "index", "done"}


def test_request_shape_is_tier_independent() -> None:
    # A single request object is accepted unchanged by every tier (R1.1):
    # callers never construct a tier-specific request.
    assert {f.name for f in fields(ModelRequest)} == {
        "prompt",
        "context_window",
        "max_tokens",
        "temperature",
        "stop",
    }


def test_response_shape_is_identical_across_tiers() -> None:
    shapes = {
        frozenset(f.name for f in fields(m.generate(
            ModelRequest(prompt="x", context_window=m.context_window)
        )))
        for m in ALL_TIERS
    }
    assert len(shapes) == 1  # one common shape, no tier branching
