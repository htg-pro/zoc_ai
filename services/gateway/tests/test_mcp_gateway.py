"""Unit tests for the ``MCP_Gateway`` (task 8.3, R8.3 + R8.4 + R8.8).

These example-based tests drive the gateway with an in-process stub worker so
no real network call is ever made. They cover the behaviors the task calls
out: bounded (<=10) cleaned structured results for ``mcp::web::search``,
termination + error indication + no-partial-results on worker failure and on
timeout (R8.8), and the ``mcp::github`` tool surface. The exhaustive property
test (Property 37) and the subprocess-lifecycle integration test live in
tasks 8.11 and 8.12.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

import pytest
from zocai_gateway.context.mcp_gateway import (
    GITHUB_TOOL,
    MAX_WEB_DOCUMENTS,
    WEB_SEARCH_TOOL,
    GitHubResult,
    MCPError,
    MCPErrorKind,
    MCPGateway,
    RawDocument,
    WebSearchResult,
    WorkerFailure,
    WorkerTimeout,
    clean_html,
)


class _StubWorker:
    """A stub :class:`WebSearchWorker` that records termination.

    Configured with the documents to return, or an exception to raise from
    ``fetch`` to simulate a worker failure / timeout.
    """

    def __init__(
        self,
        documents: Sequence[RawDocument] = (),
        *,
        raises: Exception | None = None,
    ) -> None:
        self._documents = tuple(documents)
        self._raises = raises
        self.terminated = False
        self.fetch_calls = 0

    def fetch(self, timeout: float) -> Sequence[RawDocument]:
        self.fetch_calls += 1
        if self._raises is not None:
            raise self._raises
        return self._documents

    def terminate(self) -> None:
        self.terminated = True


def _docs(n: int) -> tuple[RawDocument, ...]:
    return tuple(
        RawDocument(url=f"https://e/{i}", title=f"t{i}", html=f"<p>body {i}</p>")
        for i in range(n)
    )


# -- clean_html --------------------------------------------------------------


def test_clean_html_strips_tags_scripts_and_collapses_whitespace() -> None:
    raw = "<html><head><style>x{}</style></head><body><script>bad()</script>"
    raw += "<h1>Title</h1>   <p>Hello&nbsp;&amp; world</p></body></html>"
    assert clean_html(raw) == "Title Hello & world"


# -- mcp::web::search success ------------------------------------------------


def test_web_search_returns_cleaned_structured_documents() -> None:
    worker = _StubWorker(
        [RawDocument(url="https://a", title="A", html="<p>Hi <b>there</b></p>")]
    )
    gateway = MCPGateway(web_search_spawner=lambda q, n: worker)

    outcome = gateway.web_search("anything")

    assert isinstance(outcome, WebSearchResult)
    assert outcome.tool == WEB_SEARCH_TOOL
    assert len(outcome.documents) == 1
    doc = outcome.documents[0]
    assert doc.url == "https://a"
    assert doc.title == "A"
    assert doc.text == "Hi there"
    assert doc.rank == 0
    # Worker is released even on the success path.
    assert worker.terminated is True


def test_web_search_caps_results_at_ten_documents() -> None:
    worker = _StubWorker(_docs(25))
    gateway = MCPGateway(web_search_spawner=lambda q, n: worker)

    outcome = gateway.web_search("q")

    assert isinstance(outcome, WebSearchResult)
    assert len(outcome.documents) == MAX_WEB_DOCUMENTS == 10
    assert [d.rank for d in outcome.documents] == list(range(10))


def test_web_search_spawner_is_asked_for_at_most_ten_documents() -> None:
    seen: dict[str, int] = {}

    def spawner(query: str, max_documents: int) -> _StubWorker:
        seen["max"] = max_documents
        return _StubWorker(_docs(3))

    MCPGateway(web_search_spawner=spawner).web_search("q", max_documents=999)

    assert seen["max"] == MAX_WEB_DOCUMENTS


# -- mcp::web::search failure / timeout (R8.8) -------------------------------


def test_web_search_timeout_terminates_and_returns_error_no_partial() -> None:
    worker = _StubWorker(raises=WorkerTimeout("hung"))
    gateway = MCPGateway(web_search_spawner=lambda q, n: worker)

    outcome = gateway.web_search("q")

    assert isinstance(outcome, MCPError)
    assert outcome.tool == WEB_SEARCH_TOOL
    assert outcome.kind is MCPErrorKind.TIMEOUT
    # The hung worker was terminated and NO partial results leaked.
    assert worker.terminated is True
    assert not hasattr(outcome, "documents")


def test_web_search_failure_terminates_and_returns_error() -> None:
    worker = _StubWorker(raises=WorkerFailure("boom"))
    gateway = MCPGateway(web_search_spawner=lambda q, n: worker)

    outcome = gateway.web_search("q")

    assert isinstance(outcome, MCPError)
    assert outcome.tool == WEB_SEARCH_TOOL
    assert outcome.kind is MCPErrorKind.FAILURE
    assert "boom" in outcome.reason
    assert worker.terminated is True


def test_web_search_unexpected_exception_is_reported_as_failure() -> None:
    worker = _StubWorker(raises=RuntimeError("unexpected"))
    gateway = MCPGateway(web_search_spawner=lambda q, n: worker)

    outcome = gateway.web_search("q")

    assert isinstance(outcome, MCPError)
    assert outcome.kind is MCPErrorKind.FAILURE
    assert worker.terminated is True


def test_web_search_without_spawner_returns_not_configured() -> None:
    outcome = MCPGateway().web_search("q")
    assert isinstance(outcome, MCPError)
    assert outcome.kind is MCPErrorKind.NOT_CONFIGURED
    assert outcome.tool == WEB_SEARCH_TOOL


# -- mcp::github -------------------------------------------------------------


def test_github_returns_structured_result() -> None:
    def invoker(operation: str, params: Mapping[str, str]) -> Mapping[str, object]:
        assert operation == "get_repo"
        assert params == {"name": "zocai"}
        return {"stars": 7}

    outcome = MCPGateway(github_invoker=invoker).github(
        "get_repo", {"name": "zocai"}
    )

    assert isinstance(outcome, GitHubResult)
    assert outcome.tool == GITHUB_TOOL
    assert outcome.data == {"stars": 7}


def test_github_failure_is_reported_as_error() -> None:
    def invoker(operation: str, params: Mapping[str, str]) -> Mapping[str, object]:
        raise RuntimeError("api down")

    outcome = MCPGateway(github_invoker=invoker).github("x")

    assert isinstance(outcome, MCPError)
    assert outcome.tool == GITHUB_TOOL
    assert outcome.kind is MCPErrorKind.FAILURE


def test_github_without_backend_returns_not_configured() -> None:
    outcome = MCPGateway().github("x")
    assert isinstance(outcome, MCPError)
    assert outcome.kind is MCPErrorKind.NOT_CONFIGURED


def test_available_tools_exposes_both_mcp_surfaces() -> None:
    assert MCPGateway().available_tools() == (WEB_SEARCH_TOOL, GITHUB_TOOL)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-v"]))
