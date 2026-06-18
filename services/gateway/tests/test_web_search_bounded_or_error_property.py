"""Property test for bounded web-search results or a clean error (task 8.11).

Feature: zocai-ecosystem-rebuild, Property 37: Web search returns bounded,
structured results or a clean error.

**Validates: Requirements 8.4, 8.8**

Design Property 37 (verbatim intent): *For any* ``mcp::web::search``
invocation, a success returns at most 10 documents as structured JSON, and a
failure or timeout returns an error indication with no partial results.

Strategy
--------
The gateway's only host/network seam is the injected :data:`WebSearchSpawner`,
so every example drives :meth:`MCPGateway.web_search` with an in-process stub
worker and never makes a real network call. Two disjoint behaviors are covered
across the input space:

1. **Success (R8.4).** For an arbitrary list of raw documents, an arbitrary
   requested cap, and an arbitrary timeout budget, a successful worker yields a
   :class:`WebSearchResult` whose documents are:

   * **bounded** — never more than :data:`MAX_WEB_DOCUMENTS` (10) and never
     more than the effective cap;
   * **structured** — each a :class:`WebDocument` whose ``text`` is the
     HTML-cleaned content and whose ``rank`` is its zero-based position;
   * **attributable** — the result names :data:`WEB_SEARCH_TOOL`.

   The worker is always terminated (released) even on the success path.

2. **Failure / timeout (R8.8).** For an arbitrary worker fault —
   :class:`WorkerTimeout`, :class:`WorkerFailure`, or *any* other exception —
   the outcome is an :class:`MCPError` naming :data:`WEB_SEARCH_TOOL`, carries
   **no** partial results (no ``documents`` attribute), and the hung/failed
   worker is terminated.
"""

from __future__ import annotations

from collections.abc import Sequence

from hypothesis import given, settings
from hypothesis import strategies as st

from zocai_gateway.context.mcp_gateway import (
    MAX_WEB_DOCUMENTS,
    WEB_SEARCH_TOOL,
    MCPError,
    MCPGateway,
    RawDocument,
    WebDocument,
    WebSearchResult,
    WorkerFailure,
    WorkerTimeout,
    clean_html,
)


class _StubWorker:
    """An in-process :class:`WebSearchWorker` for tests.

    Returns ``documents`` from ``fetch`` on the success path, or raises
    ``raises`` to simulate a worker fault / timeout. Records whether the
    gateway terminated it.
    """

    def __init__(
        self,
        documents: Sequence[RawDocument] = (),
        *,
        raises: BaseException | None = None,
    ) -> None:
        self._documents = tuple(documents)
        self._raises = raises
        self.terminated = False

    def fetch(self, timeout: float) -> Sequence[RawDocument]:
        if self._raises is not None:
            raise self._raises
        return self._documents

    def terminate(self) -> None:
        self.terminated = True


# A generator for one raw document. ``html`` mixes tags, script/style blocks,
# entities, and whitespace so the cleaning contract is exercised, not bypassed.
_raw_documents = st.builds(
    RawDocument,
    url=st.text(max_size=40),
    title=st.text(max_size=40),
    html=st.lists(
        st.sampled_from(
            ["<p>", "</p>", "<script>x()</script>", "<b>", "</b>",
             "&amp;", "&nbsp;", " ", "\t", "\n", "hello", "world", "123"]
        ),
        max_size=12,
    ).map("".join),
)


@given(
    raw=st.lists(_raw_documents, max_size=25),
    # Requested cap spans below, at, and above the hard 10-document bound.
    requested_cap=st.integers(min_value=0, max_value=20),
    timeout=st.floats(min_value=0.0, max_value=120.0),
    query=st.text(max_size=50),
)
@settings(max_examples=200)
def test_web_search_success_is_bounded_and_structured(
    raw: list[RawDocument],
    requested_cap: int,
    timeout: float,
    query: str,
) -> None:
    """Property 37 (R8.4): a success returns <=10 cleaned, structured docs.

    Feature: zocai-ecosystem-rebuild, Property 37

    **Validates: Requirements 8.4**
    """
    worker = _StubWorker(raw)
    gateway = MCPGateway(web_search_spawner=lambda q, n: worker)

    outcome = gateway.web_search(
        query, max_documents=requested_cap, timeout=timeout
    )

    # A successful invocation yields a structured result naming the tool.
    assert isinstance(outcome, WebSearchResult)
    assert outcome.tool == WEB_SEARCH_TOOL

    # Bounded: never more than the hard cap, the effective cap, or what the
    # worker produced.
    effective_cap = max(0, min(requested_cap, MAX_WEB_DOCUMENTS))
    assert len(outcome.documents) <= MAX_WEB_DOCUMENTS
    assert len(outcome.documents) <= effective_cap
    assert len(outcome.documents) == min(len(raw), effective_cap)

    # Structured: each kept document is cleaned and ranked by position.
    for index, doc in enumerate(outcome.documents):
        assert isinstance(doc, WebDocument)
        assert doc.rank == index
        assert doc.url == raw[index].url
        assert doc.title == raw[index].title
        assert doc.text == clean_html(raw[index].html)
        # Cleaned text never carries residual markup.
        assert "<" not in doc.text and ">" not in doc.text

    # The worker is released even on the clean success path.
    assert worker.terminated is True


@given(
    fault=st.one_of(
        st.builds(WorkerTimeout, st.text(max_size=30)),
        st.builds(WorkerFailure, st.text(max_size=30)),
        st.builds(RuntimeError, st.text(max_size=30)),
        st.builds(ValueError, st.text(max_size=30)),
    ),
    timeout=st.floats(min_value=0.0, max_value=120.0),
    query=st.text(max_size=50),
)
@settings(max_examples=200)
def test_web_search_fault_returns_clean_error_no_partial_results(
    fault: BaseException,
    timeout: float,
    query: str,
) -> None:
    """Property 37 (R8.8): a fault terminates the worker, no partial results.

    Feature: zocai-ecosystem-rebuild, Property 37

    **Validates: Requirements 8.8**

    For any worker fault — timeout, failure, or any other exception — the
    outcome is an ``MCPError`` naming the failed tool, the worker is
    terminated, and no partial results leak.
    """
    worker = _StubWorker(raises=fault)
    gateway = MCPGateway(web_search_spawner=lambda q, n: worker)

    outcome = gateway.web_search(query, timeout=timeout)

    # A clean, attributable error — never a crash, never a partial result.
    assert isinstance(outcome, MCPError)
    assert outcome.tool == WEB_SEARCH_TOOL
    # No partial results: the error carries no documents whatsoever (R8.8).
    assert not hasattr(outcome, "documents")
    # The hung/failed worker was terminated and released (R8.8).
    assert worker.terminated is True
