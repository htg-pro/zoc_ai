"""The ``MCP_Gateway`` (Layer 3, R8.3 + R8.4 + R8.8).

The Model Context Protocol gateway exposes external-data tools to the
Orchestrator, which invokes them **only where a task requires data beyond the
model's knowledge cutoff** (R8.3). Two tools are exposed:

* ``mcp::web::search`` (R8.4, R8.8) — spawns a **subprocess worker**, retrieves
  **at most 10** web documents within a **30-second** timeout, cleans the HTML
  out of each document, and returns the results as structured JSON-shaped data.
  If the worker fails or exceeds its timeout the gateway **terminates** the
  worker, returns an **error indication identifying the failed tool call**, and
  returns **no partial results** (R8.8).
* ``mcp::github`` — a second MCP tool surface for repository data.

All host/network interaction is abstracted behind injectable seams so tests
drive the gateway with an in-process stub worker and never make real network
calls:

* :data:`WebSearchSpawner` is the seam for spawning the web-search worker. The
  production path is :func:`subprocess_web_search_spawner`, which spawns a real
  OS subprocess and enforces the timeout with hard termination. Tests inject a
  spawner that returns a :class:`WebSearchWorker` stub.
* :data:`GitHubInvoker` is the seam for the ``mcp::github`` backend.

The gateway never raises for a tool failure: every invocation returns a typed
*outcome* — either a result payload or an :class:`MCPError` naming the failed
tool — so the Orchestrator can branch on the outcome without exception
handling.
"""

from __future__ import annotations

import contextlib
import html as _html
import json
import re
import subprocess
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from enum import Enum
from typing import Protocol, runtime_checkable

__all__ = [
    "GITHUB_TOOL",
    "MAX_WEB_DOCUMENTS",
    "WEB_SEARCH_TIMEOUT_SECONDS",
    "WEB_SEARCH_TOOL",
    "GitHubInvoker",
    "GitHubOutcome",
    "GitHubResult",
    "MCPError",
    "MCPErrorKind",
    "MCPGateway",
    "RawDocument",
    "WebDocument",
    "WebSearchOutcome",
    "WebSearchResult",
    "WebSearchSpawner",
    "WebSearchWorker",
    "WorkerFailure",
    "WorkerTimeout",
    "clean_html",
    "subprocess_web_search_spawner",
]

# Canonical MCP tool identifiers exposed by the gateway.
WEB_SEARCH_TOOL = "mcp::web::search"
GITHUB_TOOL = "mcp::github"

# Hard upper bound on the number of web documents a search returns (R8.4).
MAX_WEB_DOCUMENTS = 10

# Wall-clock timeout for an ``mcp::web::search`` worker, in seconds (R8.4/R8.8).
WEB_SEARCH_TIMEOUT_SECONDS = 30.0


# --------------------------------------------------------------------------- #
# Result / error payloads
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class RawDocument:
    """A document as returned by the subprocess worker, before cleaning.

    :attr:`html` is the raw retrieved content (typically HTML); the gateway
    cleans it into the structured :class:`WebDocument.text` (R8.4).
    """

    url: str
    title: str
    html: str


@dataclass(frozen=True, slots=True)
class WebDocument:
    """One cleaned, structured web document returned by ``mcp::web::search``.

    :attr:`text` is the HTML-stripped, whitespace-collapsed content;
    :attr:`rank` is the document's zero-based position in the result set.
    """

    url: str
    title: str
    text: str
    rank: int


@dataclass(frozen=True, slots=True)
class WebSearchResult:
    """A successful ``mcp::web::search`` outcome (R8.4).

    Holds at most :data:`MAX_WEB_DOCUMENTS` cleaned documents. ``tool`` always
    identifies the originating tool call so results and errors are uniformly
    attributable.
    """

    documents: tuple[WebDocument, ...]
    tool: str = WEB_SEARCH_TOOL


@dataclass(frozen=True, slots=True)
class GitHubResult:
    """A successful ``mcp::github`` outcome.

    :attr:`data` is the structured payload returned by the GitHub backend.
    """

    data: Mapping[str, object] = field(default_factory=dict)
    tool: str = GITHUB_TOOL


class MCPErrorKind(str, Enum):
    """Why an MCP tool call failed."""

    TIMEOUT = "timeout"  # exceeded the tool's wall-clock budget (R8.8)
    FAILURE = "failure"  # the worker/backend errored or produced bad output
    NOT_CONFIGURED = "not-configured"  # no backend wired for the tool


@dataclass(frozen=True, slots=True)
class MCPError:
    """An error indication identifying a failed MCP tool call (R8.8).

    The gateway returns this instead of any partial results: a failed or
    timed-out call yields **no** documents/data, only this error naming the
    :attr:`tool` that failed and :attr:`kind`/:attr:`reason` describing why.
    """

    tool: str
    kind: MCPErrorKind
    reason: str


# Typed outcome unions: every invocation returns a result or an error.
WebSearchOutcome = WebSearchResult | MCPError
GitHubOutcome = GitHubResult | MCPError


# --------------------------------------------------------------------------- #
# Worker abstraction (the injectable subprocess seam)
# --------------------------------------------------------------------------- #


class WorkerTimeout(Exception):
    """Raised by a worker's ``fetch`` when it exceeds the allotted timeout."""


class WorkerFailure(Exception):
    """Raised by a worker's ``fetch`` when it fails to produce results."""


@runtime_checkable
class WebSearchWorker(Protocol):
    """A spawned ``mcp::web::search`` subprocess worker handle (R8.4).

    The gateway owns the worker's lifecycle: it calls :meth:`fetch` with the
    timeout budget and, on any outcome that is not a clean success, calls
    :meth:`terminate` to kill the worker and release its resources (R8.8).
    """

    def fetch(self, timeout: float) -> Sequence[RawDocument]:
        """Block up to ``timeout`` seconds for the worker's documents.

        Returns the retrieved raw documents on success. Raises
        :class:`WorkerTimeout` if the budget is exceeded, or
        :class:`WorkerFailure` if the worker errors or returns bad output.
        """
        ...

    def terminate(self) -> None:
        """Terminate the worker process and release its resources.

        Must be idempotent: terminating an already-finished worker is a no-op.
        """
        ...


# Spawns a worker for ``(query, max_documents)``. The production binding is
# ``subprocess_web_search_spawner``; tests inject a stub returning a fake worker.
WebSearchSpawner = Callable[[str, int], WebSearchWorker]

# Invokes the ``mcp::github`` backend for ``(operation, params)`` and returns a
# structured payload, raising on failure. Injectable so tests avoid the network.
GitHubInvoker = Callable[[str, Mapping[str, str]], Mapping[str, object]]


# --------------------------------------------------------------------------- #
# HTML cleaning
# --------------------------------------------------------------------------- #

_SCRIPT_STYLE_RE = re.compile(
    r"<(script|style)\b[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL
)
_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"\s+")


def clean_html(raw: str) -> str:
    """Strip HTML from ``raw`` and collapse it to clean text (R8.4).

    ``<script>``/``<style>`` blocks are removed wholesale, remaining tags are
    stripped, HTML entities are unescaped, and runs of whitespace are collapsed
    to single spaces. The result is the structured ``text`` of a
    :class:`WebDocument`.
    """
    without_blocks = _SCRIPT_STYLE_RE.sub(" ", raw)
    without_tags = _TAG_RE.sub(" ", without_blocks)
    unescaped = _html.unescape(without_tags)
    return _WHITESPACE_RE.sub(" ", unescaped).strip()


# --------------------------------------------------------------------------- #
# The gateway
# --------------------------------------------------------------------------- #


class MCPGateway:
    """Exposes ``mcp::web::search`` and ``mcp::github`` to the Orchestrator.

    The Orchestrator invokes these tools only for tasks that require data
    beyond the model knowledge cutoff (R8.3). All backends are injected so the
    gateway is fully testable without touching the network.
    """

    def __init__(
        self,
        *,
        web_search_spawner: WebSearchSpawner | None = None,
        github_invoker: GitHubInvoker | None = None,
        max_documents: int = MAX_WEB_DOCUMENTS,
        timeout: float = WEB_SEARCH_TIMEOUT_SECONDS,
    ) -> None:
        """Create a gateway.

        :param web_search_spawner: Seam that spawns the web-search subprocess
            worker. When ``None`` a ``mcp::web::search`` call returns a clean
            :class:`MCPError` (``NOT_CONFIGURED``) rather than failing hard.
        :param github_invoker: Seam that invokes the GitHub backend. When
            ``None`` a ``mcp::github`` call returns ``NOT_CONFIGURED``.
        :param max_documents: Upper bound on returned web documents; clamped to
            never exceed :data:`MAX_WEB_DOCUMENTS` (R8.4).
        :param timeout: Web-search wall-clock budget in seconds (R8.4/R8.8).
        """
        self._spawn = web_search_spawner
        self._github = github_invoker
        # Never allow the configured cap to exceed the hard R8.4 bound of 10.
        self._max_documents = max(0, min(max_documents, MAX_WEB_DOCUMENTS))
        self._timeout = timeout

    def available_tools(self) -> tuple[str, ...]:
        """The MCP tool identifiers this gateway exposes."""
        return (WEB_SEARCH_TOOL, GITHUB_TOOL)

    # -- mcp::web::search -------------------------------------------------

    def web_search(
        self,
        query: str,
        *,
        max_documents: int | None = None,
        timeout: float | None = None,
    ) -> WebSearchOutcome:
        """Run an ``mcp::web::search`` tool call (R8.4, R8.8).

        Spawns a subprocess worker for ``query``, waits up to the timeout for
        at most ``max_documents`` (never more than :data:`MAX_WEB_DOCUMENTS`)
        documents, cleans each document's HTML, and returns a
        :class:`WebSearchResult`.

        On worker failure or timeout the worker is terminated and an
        :class:`MCPError` naming :data:`WEB_SEARCH_TOOL` is returned with **no**
        partial results (R8.8).
        """
        cap = self._max_documents if max_documents is None else max_documents
        cap = max(0, min(cap, MAX_WEB_DOCUMENTS))
        budget = self._timeout if timeout is None else timeout

        if self._spawn is None:
            return MCPError(
                tool=WEB_SEARCH_TOOL,
                kind=MCPErrorKind.NOT_CONFIGURED,
                reason="no web search worker is configured",
            )

        worker = self._spawn(query, cap)
        try:
            raw_documents = worker.fetch(budget)
        except WorkerTimeout as exc:
            # Hard-terminate the hung worker; return only the error (R8.8).
            worker.terminate()
            return MCPError(
                tool=WEB_SEARCH_TOOL,
                kind=MCPErrorKind.TIMEOUT,
                reason=str(exc) or f"worker exceeded the {budget:g}s timeout",
            )
        except WorkerFailure as exc:
            worker.terminate()
            return MCPError(
                tool=WEB_SEARCH_TOOL,
                kind=MCPErrorKind.FAILURE,
                reason=str(exc) or "worker failed",
            )
        except Exception as exc:  # any worker fault is a clean error, never a crash
            # An unexpected fault is still a failed tool call, never a crash and
            # never partial results: terminate and report (R8.8).
            worker.terminate()
            return MCPError(
                tool=WEB_SEARCH_TOOL,
                kind=MCPErrorKind.FAILURE,
                reason=f"worker raised {type(exc).__name__}: {exc}",
            )

        # Clean success: release the worker and shape the structured result.
        worker.terminate()
        documents = tuple(
            WebDocument(
                url=raw.url,
                title=raw.title,
                text=clean_html(raw.html),
                rank=index,
            )
            for index, raw in enumerate(raw_documents[:cap])
        )
        return WebSearchResult(documents=documents)

    # -- mcp::github ------------------------------------------------------

    def github(
        self, operation: str, params: Mapping[str, str] | None = None
    ) -> GitHubOutcome:
        """Run an ``mcp::github`` tool call.

        Delegates ``operation``/``params`` to the injected GitHub backend and
        returns its structured payload as a :class:`GitHubResult`. Any backend
        failure is converted to an :class:`MCPError` naming
        :data:`GITHUB_TOOL`, mirroring the web-search error contract.
        """
        if self._github is None:
            return MCPError(
                tool=GITHUB_TOOL,
                kind=MCPErrorKind.NOT_CONFIGURED,
                reason="no github backend is configured",
            )
        try:
            data = self._github(operation, dict(params or {}))
        except Exception as exc:  # report any backend fault as a clean error
            return MCPError(
                tool=GITHUB_TOOL,
                kind=MCPErrorKind.FAILURE,
                reason=f"github invoke failed: {type(exc).__name__}: {exc}",
            )
        return GitHubResult(data=dict(data))


# --------------------------------------------------------------------------- #
# Production subprocess worker
# --------------------------------------------------------------------------- #


class _SubprocessWebSearchWorker:
    """A :class:`WebSearchWorker` backed by a real OS subprocess (R8.4).

    The subprocess is expected to emit, on stdout, a JSON array of objects with
    ``url``, ``title``, and ``html`` keys. The timeout is enforced by
    :meth:`subprocess.Popen.communicate`; on timeout the process is killed so a
    hung worker cannot leak (R8.8).
    """

    def __init__(self, process: subprocess.Popen[str]) -> None:
        self._process = process

    def fetch(self, timeout: float) -> Sequence[RawDocument]:
        try:
            stdout, stderr = self._process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            raise WorkerTimeout(
                f"web search worker exceeded the {timeout:g}s timeout"
            ) from exc

        if self._process.returncode != 0:
            detail = (stderr or "").strip()
            raise WorkerFailure(
                f"web search worker exited with code "
                f"{self._process.returncode}: {detail}"
            )

        try:
            payload = json.loads(stdout)
        except json.JSONDecodeError as exc:
            raise WorkerFailure(
                f"web search worker emitted invalid JSON: {exc}"
            ) from exc

        if not isinstance(payload, list):
            raise WorkerFailure(
                "web search worker JSON must be a list of documents"
            )

        documents: list[RawDocument] = []
        for entry in payload:
            if not isinstance(entry, Mapping):
                raise WorkerFailure("each web search document must be an object")
            documents.append(
                RawDocument(
                    url=str(entry.get("url", "")),
                    title=str(entry.get("title", "")),
                    html=str(entry.get("html", "")),
                )
            )
        return documents

    def terminate(self) -> None:
        if self._process.poll() is None:
            self._process.kill()
            # Reap the killed process; a stuck reap must not block the gateway.
            with contextlib.suppress(subprocess.TimeoutExpired):  # pragma: no cover
                self._process.wait(timeout=5)


def subprocess_web_search_spawner(
    command_builder: Callable[[str, int], Sequence[str]],
) -> WebSearchSpawner:
    """Build the production :data:`WebSearchSpawner` (subprocess worker, R8.4).

    ``command_builder`` maps ``(query, max_documents)`` to the argument vector
    of the worker process (an argv list, never a shell string, so there is no
    shell-injection surface). Each spawn launches that process with stdout/err
    captured as text; the returned :class:`_SubprocessWebSearchWorker` enforces
    the timeout and termination contract (R8.8).
    """

    def spawn(query: str, max_documents: int) -> WebSearchWorker:
        argv = list(command_builder(query, max_documents))
        process = subprocess.Popen(  # argv is a list, never a shell string
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        return _SubprocessWebSearchWorker(process)

    return spawn
