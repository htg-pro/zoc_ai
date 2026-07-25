"""Property + unit tests for the bundled docs MCP server (Part 4, R15).

All retrieval is driven through an injected fake ``httpx``-like client.
"""

from __future__ import annotations

import re
from typing import Any

from hypothesis import given, settings
from hypothesis import strategies as st
from mcp_servers import docs as docs_module
from mcp_servers.docs import fetch_docs, search_npm, search_pypi

_TAG_RE = re.compile(r"<[^>]+>")


class _FakeResponse:
    def __init__(self, *, json_data: object = None, text: str = "") -> None:
        self._json = json_data
        self._text = text

    @property
    def text(self) -> str:
        return self._text

    def json(self) -> Any:
        return self._json


class _FakeClient:
    """Returns one canned response for every ``get``; raises ``exc`` if set."""

    def __init__(
        self, *, json_data: object = None, text: str = "", exc: Exception | None = None
    ) -> None:
        self._response = _FakeResponse(json_data=json_data, text=text)
        self._exc = exc

    def get(self, url: str) -> _FakeResponse:
        if self._exc is not None:
            raise self._exc
        return self._response


# Printable ASCII, fuzzing tag-like and entity-like structures aggressively.
_page = st.text(
    alphabet=st.characters(min_codepoint=32, max_codepoint=126),
    max_size=160,
)


# Feature: mcp-host-and-servers, Property 28: docs HTML markup removal
@settings(max_examples=200)
@given(page=_page)
def test_fetch_docs_removes_html_markup(page: str) -> None:
    """Validates: Requirements 15.2."""
    client = _FakeClient(text=page)
    result = fetch_docs("https://docs.example/page", client)

    assert result["isError"] is False
    cleaned = result["text"]
    assert isinstance(cleaned, str)
    # When regex removal succeeds, no HTML tag markup survives.
    assert _TAG_RE.search(cleaned) is None


# Keys drawn from uppercase letters can never collide with the projected
# lowercase metadata field names, so "extra" fields must not leak through.
_extra = st.dictionaries(
    st.text(alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZ", min_size=1, max_size=6),
    st.text(max_size=8),
    max_size=4,
)
_ver = st.text(alphabet="abcdefghijklmnopqrstuvwxyz0123456789.-", min_size=1, max_size=10)
_free = st.text(max_size=20)


# Feature: mcp-host-and-servers, Property 29: package metadata exact projection
@settings(max_examples=200)
@given(
    npm_version=_ver,
    description=_free,
    readme=_free,
    pypi_version=_ver,
    summary=_free,
    extra=_extra,
)
def test_package_metadata_exact_projection(
    npm_version: str,
    description: str,
    readme: str,
    pypi_version: str,
    summary: str,
    extra: dict[str, str],
) -> None:
    """Validates: Requirements 15.5, 15.7."""
    npm_doc = {
        "dist-tags": {"latest": npm_version},
        "versions": {npm_version: {"description": description, "readme": readme, **extra}},
        "description": description,
        "readme": readme,
        **extra,
    }
    npm_result = search_npm("some-pkg", _FakeClient(json_data=npm_doc))
    assert npm_result["isError"] is False
    npm_metadata = npm_result["metadata"]
    # R15.5: exactly version/description/readme.
    assert set(npm_metadata) == {"version", "description", "readme"}
    assert npm_metadata["version"] == npm_version
    assert npm_metadata["description"] == description
    assert npm_metadata["readme"] == readme

    pypi_doc = {"info": {"version": pypi_version, "summary": summary, **extra}}
    pypi_result = search_pypi("some-pkg", _FakeClient(json_data=pypi_doc))
    assert pypi_result["isError"] is False
    pypi_metadata = pypi_result["metadata"]
    # R15.7: exactly version/description.
    assert set(pypi_metadata) == {"version", "description"}
    assert pypi_metadata["version"] == pypi_version
    assert pypi_metadata["description"] == summary


def test_fetch_docs_passthrough_when_regex_step_raises(monkeypatch: Any) -> None:
    """Validates: Requirements 15.3."""
    raw = "<html><body>Hello <b>World</b></body></html>"

    def boom(_text: str) -> str:
        raise RuntimeError("catastrophic backtracking")

    monkeypatch.setattr(docs_module, "_strip_html", boom)
    result = fetch_docs("https://x/y", _FakeClient(text=raw))

    assert result["isError"] is False
    assert result["text"] == raw  # R15.3: raw page text returned unchanged


def test_fetch_docs_retrieval_failure_names_resource() -> None:
    """Validates: Requirements 15.9."""
    result = fetch_docs("https://x/y", _FakeClient(exc=RuntimeError("boom")))
    assert result["isError"] is True
    assert "https://x/y" in result["content"][0]["text"]


def test_search_npm_absent_package_typed_failure() -> None:
    """Validates: Requirements 15.9."""
    result = search_npm("no-such-pkg-xyz", _FakeClient(json_data={"error": "Not found"}))
    assert result["isError"] is True
    assert "no-such-pkg-xyz" in result["content"][0]["text"]


def test_search_pypi_absent_package_typed_failure() -> None:
    """Validates: Requirements 15.9."""
    result = search_pypi("no-such-pkg-xyz", _FakeClient(exc=RuntimeError("404 not found")))
    assert result["isError"] is True
    assert "no-such-pkg-xyz" in result["content"][0]["text"]
