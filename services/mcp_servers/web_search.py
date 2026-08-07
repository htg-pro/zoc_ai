"""Bundled web-search MCP server (Part 4, §4.2, R14).

Exposes the ``web_search`` tool. Retrieval uses ``httpx`` (R14.7) through an
injected client seam so tests never touch the network, and never launches a
browser (R14.8). The DuckDuckGo Instant Answer JSON API is queried first
(R14.2); a result entry is *usable* only when ``title``, ``url``, and ``snippet``
are all non-empty strings (R14.3), and at most ``max_results`` usable entries are
returned (R14.5), each carrying exactly those three fields (R14.4). If the
Instant Answer path fails, cannot be parsed, or yields zero usable entries, the
DuckDuckGo HTML results page is retrieved and parsed with regular expressions as
the fallback source (R14.6). If the fallback also fails or yields nothing, a
typed tool failure identifying the query is returned (R14.9).
"""

from __future__ import annotations

import html
import os
import re
import sys
from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlencode

import httpx

from ._mcp import Server, error_result

__all__ = ["build_server", "main", "web_search"]

INSTANT_ANSWER_URL = "https://api.duckduckgo.com/"
HTML_RESULTS_URL = "https://html.duckduckgo.com/html/"
DEFAULT_MAX_RESULTS = 5
_TIMEOUT_SECONDS = 30.0

# DuckDuckGo HTML result markup: a `result__a` anchor carries the title + href,
# and a sibling `result__snippet` anchor carries the snippet text.
_RESULT_ANCHOR_RE = re.compile(
    r'<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*\bhref="([^"]*)"[^>]*>(.*?)</a>',
    re.IGNORECASE | re.DOTALL,
)
_RESULT_SNIPPET_RE = re.compile(
    r'<a\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>(.*?)</a>',
    re.IGNORECASE | re.DOTALL,
)
_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"\s+")


class HttpResponse(Protocol):
    """The response surface the web-search server needs from its client."""

    @property
    def text(self) -> str: ...

    def json(self) -> Any: ...


class HttpClient(Protocol):
    """An ``httpx``-like client seam (``get`` returning an :class:`HttpResponse`)."""

    def get(self, url: str) -> HttpResponse: ...


def _nonempty(value: object) -> bool:
    """True only for a string with non-whitespace content (R14.3)."""
    return isinstance(value, str) and bool(value.strip())


def _clean_fragment(fragment: str) -> str:
    """Strip HTML tags, unescape entities, and collapse whitespace in a fragment."""
    without_tags = _TAG_RE.sub(" ", fragment)
    unescaped = html.unescape(without_tags)
    return _WHITESPACE_RE.sub(" ", unescaped).strip()


def _iter_topics(data: Mapping[str, object]) -> Iterator[Mapping[str, object]]:
    """Yield the flattened Instant Answer ``Results`` / ``RelatedTopics`` entries."""
    for key in ("Results", "RelatedTopics"):
        section = data.get(key)
        if not isinstance(section, list):
            continue
        for item in section:
            if not isinstance(item, Mapping):
                continue
            nested = item.get("Topics")
            if isinstance(nested, list):
                for sub in nested:
                    if isinstance(sub, Mapping):
                        yield sub
            else:
                yield item


def _instant_answer(query: str, client: HttpClient) -> list[dict[str, str]]:
    """Query the DuckDuckGo Instant Answer API and project usable entries (R14.2)."""
    url = INSTANT_ANSWER_URL + "?" + urlencode({"q": query, "format": "json"})
    try:
        data = client.get(url).json()
    except Exception:
        return []
    if not isinstance(data, Mapping):
        return []

    entries: list[dict[str, str]] = []
    heading = data.get("Heading")
    abstract = data.get("AbstractText")
    abstract_url = data.get("AbstractURL")
    if _nonempty(heading) and _nonempty(abstract_url) and _nonempty(abstract):
        entries.append({"title": str(heading), "url": str(abstract_url), "snippet": str(abstract)})
    for topic in _iter_topics(data):
        text = topic.get("Text")
        first_url = topic.get("FirstURL")
        if _nonempty(text) and _nonempty(first_url):
            title = str(text).split(" - ", 1)[0].strip()
            if title:
                entries.append({"title": title, "url": str(first_url), "snippet": str(text)})
    return entries


def _html_fallback(query: str, client: HttpClient) -> list[dict[str, str]]:
    """Retrieve and regex-parse the DuckDuckGo HTML results page (R14.6)."""
    url = HTML_RESULTS_URL + "?" + urlencode({"q": query})
    try:
        body = client.get(url).text
    except Exception:
        return []
    if not isinstance(body, str):
        return []

    anchors = _RESULT_ANCHOR_RE.findall(body)
    snippets = _RESULT_SNIPPET_RE.findall(body)
    entries: list[dict[str, str]] = []
    for (raw_url, raw_title), raw_snippet in zip(anchors, snippets, strict=False):
        title = _clean_fragment(raw_title)
        url_value = _clean_fragment(raw_url)
        snippet = _clean_fragment(raw_snippet)
        if title and url_value and snippet:
            entries.append({"title": title, "url": url_value, "snippet": snippet})
    return entries


def web_search(query: str, max_results: int, client: HttpClient) -> dict[str, object]:
    """Run a ``web_search`` tool call over the injected ``client`` (R14).

    Tries the Instant Answer API, falls back to the HTML results page, and caps
    the usable entries at ``max_results``. Returns a normal tool result whose
    ``results`` list holds entries of exactly ``title``/``url``/``snippet``, or a
    typed failure identifying the query when neither path yields a usable entry.
    """
    if not _nonempty(query):
        return error_result(f"web_search requires a non-empty query; received {query!r}")
    if max_results < 1:
        return error_result(f"web_search requires max_results >= 1; received {max_results!r}")

    entries = _instant_answer(query, client)
    if not entries:
        entries = _html_fallback(query, client)
    if not entries:
        return error_result(f"web_search found no usable results for query {query!r}")

    capped = entries[:max_results]
    summary = "\n".join(f"{entry['title']} — {entry['url']}" for entry in capped)
    return {
        "content": [{"type": "text", "text": summary}],
        "isError": False,
        "results": [
            {"title": entry["title"], "url": entry["url"], "snippet": entry["snippet"]}
            for entry in capped
        ],
    }


_INPUT_SCHEMA: dict[str, object] = {
    "type": "object",
    "properties": {
        "query": {"type": "string", "minLength": 1, "description": "The search query."},
        "max_results": {
            "type": "integer",
            "minimum": 1,
            "default": DEFAULT_MAX_RESULTS,
            "description": "Maximum number of results to return.",
        },
    },
    "required": ["query"],
    "additionalProperties": False,
}


def _web_search_handler(arguments: dict[str, object]) -> dict[str, object]:
    query = arguments.get("query", "")
    raw_max = arguments.get("max_results", DEFAULT_MAX_RESULTS)
    max_results = (
        raw_max
        if isinstance(raw_max, int) and not isinstance(raw_max, bool)
        else DEFAULT_MAX_RESULTS
    )
    with httpx.Client(timeout=_TIMEOUT_SECONDS, follow_redirects=True) as client:
        return web_search(str(query), max_results, client)


def build_server() -> Server:
    """Build the web-search :class:`Server` with the ``web_search`` tool registered."""
    server = Server(name="zocai-web-search", version="1.0.0")
    server.register(
        "web_search",
        "Search the public web via DuckDuckGo and return titled results with snippets.",
        _INPUT_SCHEMA,
        _web_search_handler,
    )
    return server


def main() -> None:  # pragma: no cover - real stdio entry point
    workspace_root = Path(os.environ.get("ZOC_WORKSPACE_ROOT") or Path.cwd()).resolve()
    build_server().serve(sys.stdin.buffer, sys.stdout.buffer, workspace_root)


if __name__ == "__main__":  # pragma: no cover
    main()
