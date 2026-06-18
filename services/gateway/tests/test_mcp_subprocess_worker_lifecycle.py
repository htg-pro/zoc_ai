"""Integration test for the MCP subprocess worker lifecycle (task 8.12, R8.4).

Unlike :mod:`tests.test_mcp_gateway`, which drives the gateway with an
in-process stub, these tests exercise the *production* subprocess seam end to
end: :func:`subprocess_web_search_spawner` launches a **real OS subprocess**
(a small ``python -c`` worker script) via the ``command_builder`` argv, the
gateway fetches its stdout, cleans the HTML, and reaps the process. We also
drive the failure paths (a hung worker and a non-zero-exit worker) to verify
the gateway terminates the worker and returns an error with no partial results
(R8.8).

The tests are fully hermetic: the worker scripts only emit canned JSON on
stdout and never touch the network.

Validates: Requirements 8.4
"""

from __future__ import annotations

import sys
from collections.abc import Sequence

import pytest
from zocai_gateway.context.mcp_gateway import (
    WEB_SEARCH_TOOL,
    MCPError,
    MCPErrorKind,
    MCPGateway,
    WebSearchResult,
    WebSearchWorker,
    subprocess_web_search_spawner,
)

# --------------------------------------------------------------------------- #
# Worker scripts run as a real OS subprocess via `python -c <script>`.
# Each receives the requested document count as argv[1] so we can confirm the
# gateway's bound flows all the way through the command_builder.
# --------------------------------------------------------------------------- #

# Emits a JSON array of {url,title,html} documents on stdout, one per requested
# slot. The HTML embeds <script>/<style> and entities so we can assert cleaning.
_SUCCESS_SCRIPT = r"""
import json, sys
n = int(sys.argv[1])
docs = [
    {
        "url": "https://example.test/doc/%d" % i,
        "title": "Doc %d" % i,
        "html": (
            "<html><head><style>b{color:red}</style></head>"
            "<body><script>track()</script>"
            "<h1>Heading %d</h1>   <p>Hello&nbsp;&amp; world</p></body></html>"
        ) % i,
    }
    for i in range(n)
]
sys.stdout.write(json.dumps(docs))
"""

# Never returns within the timeout: blocks forever so the gateway must kill it.
_HANG_SCRIPT = r"""
import time
while True:
    time.sleep(3600)
"""

# Exits non-zero with a diagnostic on stderr: a worker failure.
_FAIL_SCRIPT = r"""
import sys
sys.stderr.write("worker blew up")
sys.exit(7)
"""


class _CapturingSpawner:
    """Wraps a real spawner and records the workers it hands back.

    Lets the test reach through to the live ``subprocess.Popen`` handle so it
    can assert the OS process was actually reaped after the gateway finishes.
    """

    def __init__(self, script: str) -> None:
        def command_builder(query: str, max_documents: int) -> Sequence[str]:
            # A real argv (never a shell string): interpreter, -c, script, count.
            return [sys.executable, "-c", script, str(max_documents)]

        self._inner = subprocess_web_search_spawner(command_builder)
        self.workers: list[WebSearchWorker] = []

    def __call__(self, query: str, max_documents: int) -> WebSearchWorker:
        worker = self._inner(query, max_documents)
        self.workers.append(worker)
        return worker


def _process_of(worker: WebSearchWorker):
    """Reach the private Popen handle of a subprocess worker for inspection."""
    return worker._process  # type: ignore[attr-defined]


# --------------------------------------------------------------------------- #
# Success: a real subprocess is spawned, fetched, cleaned, and reaped.
# --------------------------------------------------------------------------- #


def test_real_subprocess_worker_spawns_fetches_cleans_and_reaps() -> None:
    spawner = _CapturingSpawner(_SUCCESS_SCRIPT)
    gateway = MCPGateway(web_search_spawner=spawner, timeout=30.0)

    outcome = gateway.web_search("zocai release notes", max_documents=3)

    assert isinstance(outcome, WebSearchResult)
    assert outcome.tool == WEB_SEARCH_TOOL
    # Three documents requested -> three structured, ranked documents returned.
    assert len(outcome.documents) == 3
    assert [d.rank for d in outcome.documents] == [0, 1, 2]

    first = outcome.documents[0]
    assert first.url == "https://example.test/doc/0"
    assert first.title == "Doc 0"
    # HTML was cleaned: tags + <script>/<style> stripped, entities unescaped,
    # whitespace collapsed.
    assert first.text == "Heading 0 Hello & world"
    assert "<" not in first.text and "track()" not in first.text

    # A single real subprocess was spawned and it has been reaped (poll() is a
    # concrete return code, not None -> the process is no longer running).
    assert len(spawner.workers) == 1
    assert _process_of(spawner.workers[0]).poll() is not None


# --------------------------------------------------------------------------- #
# Timeout: a hung worker is hard-terminated; an error is returned, no partials.
# --------------------------------------------------------------------------- #


def test_hung_worker_is_terminated_and_returns_timeout_error() -> None:
    spawner = _CapturingSpawner(_HANG_SCRIPT)
    # Tiny budget so the forever-sleeping worker trips the timeout immediately.
    gateway = MCPGateway(web_search_spawner=spawner, timeout=0.5)

    outcome = gateway.web_search("anything")

    assert isinstance(outcome, MCPError)
    assert outcome.tool == WEB_SEARCH_TOOL
    assert outcome.kind is MCPErrorKind.TIMEOUT
    # No partial results leaked through the error outcome.
    assert not hasattr(outcome, "documents")
    # The hung OS process was killed and reaped, not left running.
    assert _process_of(spawner.workers[0]).poll() is not None


# --------------------------------------------------------------------------- #
# Failure: a non-zero-exit worker yields a failure error and a reaped process.
# --------------------------------------------------------------------------- #


def test_nonzero_exit_worker_returns_failure_error() -> None:
    spawner = _CapturingSpawner(_FAIL_SCRIPT)
    gateway = MCPGateway(web_search_spawner=spawner, timeout=30.0)

    outcome = gateway.web_search("anything")

    assert isinstance(outcome, MCPError)
    assert outcome.tool == WEB_SEARCH_TOOL
    assert outcome.kind is MCPErrorKind.FAILURE
    # The worker's stderr/exit code is surfaced in the error reason.
    assert "7" in outcome.reason
    assert not hasattr(outcome, "documents")
    assert _process_of(spawner.workers[0]).poll() is not None


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-v"]))
