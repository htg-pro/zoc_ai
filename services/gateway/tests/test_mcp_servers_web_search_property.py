"""Property + unit tests for the bundled web-search MCP server (Part 4, R14).

All retrieval is driven through an injected fake ``httpx``-like client, so no
real network request is made and no browser is launched.
"""

from __future__ import annotations

from typing import Any

from hypothesis import given, settings
from hypothesis import strategies as st
from mcp_servers.web_search import web_search


class _FakeResponse:
    """A minimal ``httpx``-like response returning canned JSON / text."""

    def __init__(self, *, json_data: object = None, text: str = "") -> None:
        self._json = json_data
        self._text = text

    @property
    def text(self) -> str:
        return self._text

    def json(self) -> Any:
        return self._json


class _FakeClient:
    """Routes ``get`` by URL to a preconfigured Instant Answer / HTML response.

    A configured :class:`Exception` value is raised to simulate a retrieval
    failure on that path.
    """

    def __init__(self, *, instant: object = None, html: object = None) -> None:
        self._instant = instant
        self._html = html

    def get(self, url: str) -> _FakeResponse:
        target = self._instant if "api.duckduckgo.com" in url else self._html
        if isinstance(target, Exception):
            raise target
        assert isinstance(target, _FakeResponse)
        return target


# A topic whose Text / FirstURL are independently empty or non-empty, so the
# usability filter (non-empty title, url, snippet) is genuinely exercised.
_maybe = st.one_of(st.just(""), st.text(min_size=1, max_size=15))
_topic = st.builds(lambda text, url: {"Text": text, "FirstURL": url}, _maybe, _maybe)


# Feature: mcp-host-and-servers, Property 27: web search result validity and cap
@settings(max_examples=200)
@given(topics=st.lists(_topic, max_size=12), max_results=st.integers(min_value=1, max_value=10))
def test_web_search_result_validity_and_cap(
    topics: list[dict[str, str]], max_results: int
) -> None:
    """Validates: Requirements 14.3, 14.4, 14.5."""
    client = _FakeClient(
        instant=_FakeResponse(json_data={"RelatedTopics": topics}),
        html=_FakeResponse(text=""),
    )
    result = web_search("a query", max_results, client)

    entries = result.get("results", [])
    assert isinstance(entries, list)
    assert len(entries) <= max_results  # R14.5: never more than max_results
    for entry in entries:
        # R14.4: exactly the three string fields.
        assert set(entry) == {"title", "url", "snippet"}
        # R14.3: each field is a non-empty string.
        for field in ("title", "url", "snippet"):
            assert isinstance(entry[field], str)
            assert entry[field].strip() != ""


def test_web_search_uses_html_fallback_when_instant_answer_has_no_usable_entries() -> None:
    """Validates: Requirements 14.6."""
    instant = _FakeResponse(json_data={"RelatedTopics": []})  # zero usable entries
    html_body = (
        '<a class="result__a" href="https://ex.com/1">First <b>Title</b></a>'
        '<a class="result__snippet">Snippet one</a>'
        '<a class="result__a" href="https://ex.com/2">Second Title</a>'
        '<a class="result__snippet">Snippet two &amp; more</a>'
    )
    client = _FakeClient(instant=instant, html=_FakeResponse(text=html_body))

    result = web_search("query", 5, client)

    assert result["isError"] is False
    results = result["results"]
    assert results == [
        {"title": "First Title", "url": "https://ex.com/1", "snippet": "Snippet one"},
        {"title": "Second Title", "url": "https://ex.com/2", "snippet": "Snippet two & more"},
    ]


def test_web_search_html_fallback_respects_max_results() -> None:
    """Validates: Requirements 14.5, 14.6."""
    instant = _FakeResponse(json_data={})  # nothing usable → fallback
    blocks = "".join(
        f'<a class="result__a" href="https://ex.com/{i}">Title {i}</a>'
        f'<a class="result__snippet">Snippet {i}</a>'
        for i in range(6)
    )
    client = _FakeClient(instant=instant, html=_FakeResponse(text=blocks))

    result = web_search("query", 2, client)

    assert result["isError"] is False
    assert len(result["results"]) == 2


def test_web_search_typed_failure_when_both_paths_empty_names_query() -> None:
    """Validates: Requirements 14.9."""
    client = _FakeClient(
        instant=_FakeResponse(json_data={"RelatedTopics": []}),
        html=_FakeResponse(text="<html>nothing to parse here</html>"),
    )
    result = web_search("obscure-term-xyz", 5, client)

    assert result["isError"] is True
    assert "obscure-term-xyz" in result["content"][0]["text"]
    assert "results" not in result  # R14.9: no partial results on failure


def test_web_search_typed_failure_when_both_paths_raise_names_query() -> None:
    """Validates: Requirements 14.6, 14.9."""
    boom = RuntimeError("network down")
    client = _FakeClient(instant=boom, html=boom)
    result = web_search("boom-query", 3, client)

    assert result["isError"] is True
    assert "boom-query" in result["content"][0]["text"]


def test_web_search_rejects_empty_query() -> None:
    """Validates: Requirements 14.1."""
    client = _FakeClient(instant=_FakeResponse(json_data={}), html=_FakeResponse(text=""))
    result = web_search("   ", 5, client)
    assert result["isError"] is True
