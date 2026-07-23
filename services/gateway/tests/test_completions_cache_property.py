"""Feature: editor-diagnostics-completions, Property 15: The completion cache
returns fresh non-empty entries and never stores empties.

**Validates: Requirements 14.1, 14.2, 14.3, 14.4, 14.5**
"""

from __future__ import annotations

from hypothesis import example, given, settings
from hypothesis import strategies as st
from zocai_gateway.routes.completions import CACHE_TTL_SECONDS, CompletionCache

_key = st.tuples(st.text(max_size=40), st.text(max_size=40), st.text(max_size=20))


@settings(max_examples=200)
@given(
    key=_key,
    text=st.text(max_size=60),
    stored_at=st.floats(min_value=0.0, max_value=1e6, allow_nan=False, allow_infinity=False),
    age=st.floats(min_value=0.0, max_value=120.0, allow_nan=False, allow_infinity=False),
)
# Explicit boundary examples around the 30 s TTL (R14.3/R14.5).
@example(key=("a", "b", "m"), text="x", stored_at=100.0, age=29.999)
@example(key=("a", "b", "m"), text="x", stored_at=100.0, age=30.0)
@example(key=("a", "b", "m"), text="x", stored_at=100.0, age=30.001)
def test_completion_cache_freshness_and_empties(
    key: tuple[str, str, str],
    text: str,
    stored_at: float,
    age: float,
) -> None:
    cache = CompletionCache()
    cache.put(key, text, stored_at)
    read_at = stored_at + age

    if not text:
        # R14.2: an empty completion is never stored, so it never reads back.
        assert cache.get(key, read_at) is None
        return

    fresh = age < CACHE_TTL_SECONDS
    if fresh:
        # R14.3: a stored non-empty entry younger than 30 s is returned.
        assert cache.get(key, read_at) == text
        # R14.4: a read does not change the stored age — a second, still-fresh
        # read at the same instant still returns the entry.
        assert cache.get(key, read_at) == text
    else:
        # R14.5: an entry at/after the TTL is not returned (caller recomputes).
        assert cache.get(key, read_at) is None


@settings(max_examples=100)
@given(key=_key, text=st.text(min_size=1, max_size=40))
def test_read_does_not_refresh_age(key: tuple[str, str, str], text: str) -> None:
    # R14.4: reading at t=stored+20 must not let a later read at stored+40 hit.
    cache = CompletionCache()
    cache.put(key, text, 0.0)
    assert cache.get(key, 20.0) == text  # fresh
    assert cache.get(key, 40.0) is None  # aged out — the 20s read did not reset it
