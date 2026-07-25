"""Bundled documentation & package-metadata MCP server (Part 4, §4.2, R15).

Exposes three tools, all retrieving over ``httpx`` (R15.8) through an injected
client seam so tests never touch the network:

* ``fetch_docs`` — fetch a URL and return its text with HTML markup removed by
  regex (R15.2); if the regex removal step raises, the retrieved text is
  returned unchanged (R15.3).
* ``search_npm`` — return exactly ``version``/``description``/``readme`` for the
  latest release from the npm registry (R15.5).
* ``search_pypi`` — return exactly ``version``/``description`` from the PyPI JSON
  API (R15.7).

Any retrieval failure or absent package yields a typed tool failure identifying
the requested resource or package (R15.9).
"""

from __future__ import annotations

import html
import os
import re
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import quote

import httpx

from ._mcp import Server, error_result

__all__ = ["build_server", "fetch_docs", "main", "search_npm", "search_pypi"]

NPM_REGISTRY_URL = "https://registry.npmjs.org/"
PYPI_JSON_URL = "https://pypi.org/pypi/"
_TIMEOUT_SECONDS = 30.0

_SCRIPT_STYLE_RE = re.compile(r"<(script|style)\b[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL)
_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"\s+")


class HttpResponse(Protocol):
    """The response surface the docs server needs from its client."""

    @property
    def text(self) -> str: ...

    def json(self) -> Any: ...


class HttpClient(Protocol):
    """An ``httpx``-like client seam (``get`` returning an :class:`HttpResponse`)."""

    def get(self, url: str) -> HttpResponse: ...


def _nonempty(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _as_str(value: object) -> str:
    return value if isinstance(value, str) else ""


def _strip_html(text: str) -> str:
    """Remove HTML markup from ``text`` with regexes (R15.2).

    ``<script>``/``<style>`` blocks are dropped, entities are unescaped, and the
    remaining tags are stripped last so no ``<...>`` markup survives, then runs
    of whitespace are collapsed.
    """
    without_blocks = _SCRIPT_STYLE_RE.sub(" ", text)
    unescaped = html.unescape(without_blocks)
    without_tags = _TAG_RE.sub(" ", unescaped)
    return _WHITESPACE_RE.sub(" ", without_tags).strip()


def fetch_docs(url: str, client: HttpClient) -> dict[str, object]:
    """Fetch ``url`` and return its de-marked-up text (R15.2), else raw on regex
    failure (R15.3); a retrieval failure yields a typed failure naming ``url``
    (R15.9)."""
    try:
        body = client.get(url).text
    except Exception:
        return error_result(f"fetch_docs failed to retrieve {url!r}")
    try:
        cleaned = _strip_html(body)
    except Exception:
        cleaned = body  # R15.3: regex processing failed → return page text unchanged
    return {"content": [{"type": "text", "text": cleaned}], "isError": False, "text": cleaned}


def search_npm(package: str, client: HttpClient) -> dict[str, object]:
    """Return exactly ``version``/``description``/``readme`` for ``package`` (R15.5)."""
    url = NPM_REGISTRY_URL + quote(package, safe="")
    try:
        data = client.get(url).json()
    except Exception:
        return error_result(f"search_npm failed to retrieve package {package!r}")
    if not isinstance(data, Mapping):
        return error_result(f"search_npm found no package {package!r}")

    dist_tags = data.get("dist-tags")
    latest = dist_tags.get("latest") if isinstance(dist_tags, Mapping) else None
    if not _nonempty(latest):
        return error_result(f"search_npm found no package {package!r}")

    versions = data.get("versions")
    version_obj = versions.get(latest) if isinstance(versions, Mapping) else None
    description = ""
    readme = ""
    if isinstance(version_obj, Mapping):
        description = _as_str(version_obj.get("description"))
        readme = _as_str(version_obj.get("readme"))
    if not description:
        description = _as_str(data.get("description"))
    if not readme:
        readme = _as_str(data.get("readme"))

    metadata = {"version": str(latest), "description": description, "readme": readme}
    return {
        "content": [{"type": "text", "text": f"{package} {latest}"}],
        "isError": False,
        "metadata": metadata,
    }


def search_pypi(package: str, client: HttpClient) -> dict[str, object]:
    """Return exactly ``version``/``description`` for ``package`` (R15.7)."""
    url = PYPI_JSON_URL + quote(package, safe="") + "/json"
    try:
        data = client.get(url).json()
    except Exception:
        return error_result(f"search_pypi failed to retrieve package {package!r}")
    info = data.get("info") if isinstance(data, Mapping) else None
    if not isinstance(info, Mapping):
        return error_result(f"search_pypi found no package {package!r}")

    version = info.get("version")
    if not _nonempty(version):
        return error_result(f"search_pypi found no package {package!r}")

    description = _as_str(info.get("summary")) or _as_str(info.get("description"))
    metadata = {"version": str(version), "description": description}
    return {
        "content": [{"type": "text", "text": f"{package} {version}"}],
        "isError": False,
        "metadata": metadata,
    }


_FETCH_DOCS_SCHEMA: dict[str, object] = {
    "type": "object",
    "properties": {"url": {"type": "string", "description": "The documentation URL to fetch."}},
    "required": ["url"],
    "additionalProperties": False,
}
_PACKAGE_SCHEMA: dict[str, object] = {
    "type": "object",
    "properties": {"package": {"type": "string", "description": "The package name."}},
    "required": ["package"],
    "additionalProperties": False,
}


def _fetch_docs_handler(arguments: dict[str, object]) -> dict[str, object]:
    url = str(arguments.get("url", ""))
    with httpx.Client(timeout=_TIMEOUT_SECONDS, follow_redirects=True) as client:
        return fetch_docs(url, client)


def _search_npm_handler(arguments: dict[str, object]) -> dict[str, object]:
    package = str(arguments.get("package", ""))
    with httpx.Client(timeout=_TIMEOUT_SECONDS, follow_redirects=True) as client:
        return search_npm(package, client)


def _search_pypi_handler(arguments: dict[str, object]) -> dict[str, object]:
    package = str(arguments.get("package", ""))
    with httpx.Client(timeout=_TIMEOUT_SECONDS, follow_redirects=True) as client:
        return search_pypi(package, client)


def build_server() -> Server:
    """Build the docs :class:`Server` with fetch_docs/search_npm/search_pypi registered."""
    server = Server(name="zocai-docs", version="1.0.0")
    server.register(
        "fetch_docs",
        "Fetch a documentation page and return its text with HTML markup removed.",
        _FETCH_DOCS_SCHEMA,
        _fetch_docs_handler,
    )
    server.register(
        "search_npm",
        "Look up an npm package's latest version, description, and readme.",
        _PACKAGE_SCHEMA,
        _search_npm_handler,
    )
    server.register(
        "search_pypi",
        "Look up a PyPI package's version and description.",
        _PACKAGE_SCHEMA,
        _search_pypi_handler,
    )
    return server


def main() -> None:  # pragma: no cover - real stdio entry point
    workspace_root = Path(os.environ.get("ZOC_WORKSPACE_ROOT") or Path.cwd()).resolve()
    build_server().serve(sys.stdin.buffer, sys.stdout.buffer, workspace_root)


if __name__ == "__main__":  # pragma: no cover
    main()
