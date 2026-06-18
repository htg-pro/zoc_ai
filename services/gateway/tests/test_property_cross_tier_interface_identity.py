"""Property test for cross-tier interface identity (task 3.11).

Feature: zocai-ecosystem-rebuild, Property 6: Model_Interface contract is
identical across tiers.

**Validates: Requirements 1.1**

Design Property 6 (verbatim intent): *For any* ``ModelRequest``, the
``Model_Interface`` exposed by the Local SLM, Edge, and Cloud tiers is
structurally identical — ``generate()`` returns a ``ModelResponse`` and
``stream()`` yields ``TokenChunk`` objects whose field sets and structure are
the same across every tier. Only tier-discriminating data (the reported
``tier`` and ``context_window``) is permitted to differ.

Strategy
--------
We synthesize arbitrary :class:`ModelRequest` values (the full caller-facing
input space) and feed the *same* request to all three concrete tier stubs.
For each drawn request we assert:

* every tier satisfies the :class:`ModelInterface` protocol,
* ``generate()`` returns a :class:`ModelResponse` whose field-name set is the
  one common contract shape (identical across tiers),
* ``stream()`` yields :class:`TokenChunk` objects whose field-name set is the
  one common contract shape (identical across tiers),
* the only response field that legitimately varies across tiers is ``tier``;
  every other response field is byte-for-byte identical for an identical
  request,
* the streamed chunk structure (field set, ordering keys) is identical across
  tiers,
* the request object itself is accepted unchanged by every tier (callers never
  build a tier-specific request).
"""

from __future__ import annotations

from dataclasses import fields

from hypothesis import given, settings
from hypothesis import strategies as st

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

# The three concrete tier classes under test. Instantiated fresh per example
# so no state can leak between tiers.
_TIER_CLASSES = (LocalSLM, Edge, Cloud)

# The single canonical contract shapes (R1.1). These are derived from the
# dataclasses themselves so the test tracks the contract, not a hand-copy.
_RESPONSE_FIELDS = frozenset(f.name for f in fields(ModelResponse))
_CHUNK_FIELDS = frozenset(f.name for f in fields(TokenChunk))

# Response fields that are permitted to differ across tiers: only the tier
# discriminator. (``context_window`` lives on the model, not the response.)
_TIER_VARIANT_RESPONSE_FIELDS = frozenset({"tier"})


@st.composite
def _model_requests(draw: st.DrawFn) -> ModelRequest:
    """An arbitrary, well-formed :class:`ModelRequest` (R1.1 input space)."""
    return ModelRequest(
        prompt=draw(st.text(max_size=200)),
        context_window=draw(st.integers(min_value=1, max_value=2_000_000)),
        max_tokens=draw(st.none() | st.integers(min_value=1, max_value=1_000_000)),
        temperature=draw(
            st.floats(min_value=0.0, max_value=2.0, allow_nan=False, allow_infinity=False)
        ),
        stop=draw(st.lists(st.text(max_size=8), max_size=4)),
    )


@settings(max_examples=200)
@given(req=_model_requests())
def test_model_interface_contract_identical_across_tiers(req: ModelRequest) -> None:
    """Property 6: the interface contract is identical across all three tiers.

    Feature: zocai-ecosystem-rebuild, Property 6

    **Validates: Requirements 1.1**
    """
    models: list[ModelInterface] = [cls() for cls in _TIER_CLASSES]

    response_shapes: set[frozenset[str]] = set()
    chunk_shapes: set[frozenset[str]] = set()
    # Maps a non-tier-variant response field name -> the set of values seen
    # across tiers. For an identical request these must each collapse to one.
    invariant_response_values: dict[str, set[object]] = {
        name: set() for name in (_RESPONSE_FIELDS - _TIER_VARIANT_RESPONSE_FIELDS)
    }

    for model in models:
        # Every tier satisfies the uniform protocol (R1.1).
        assert isinstance(model, ModelInterface)

        # generate() returns the one common response shape.
        resp = model.generate(req)
        assert isinstance(resp, ModelResponse)
        resp_shape = frozenset(f.name for f in fields(resp))
        assert resp_shape == _RESPONSE_FIELDS
        response_shapes.add(resp_shape)

        # The tier discriminator on the response matches the model's tier...
        assert resp.tier is model.tier
        assert isinstance(resp.tier, ModelTier)
        # ...and every non-discriminator field is recorded for cross-tier
        # identity comparison below.
        for name in invariant_response_values:
            invariant_response_values[name].add(getattr(resp, name))

        # stream() yields the one common chunk shape, for every chunk.
        chunks = list(model.stream(req))
        assert chunks, "stream must yield at least one chunk"
        for chunk in chunks:
            assert isinstance(chunk, TokenChunk)
            chunk_shape = frozenset(f.name for f in fields(chunk))
            assert chunk_shape == _CHUNK_FIELDS
            chunk_shapes.add(chunk_shape)

    # Field sets/structure collapse to a single shape across all tiers (R1.1).
    assert len(response_shapes) == 1
    assert len(chunk_shapes) == 1

    # Only ``tier`` differs: every other response field is identical given an
    # identical request, so each invariant field has exactly one value.
    for name, seen in invariant_response_values.items():
        assert len(seen) == 1, f"response field {name!r} differs across tiers: {seen!r}"
