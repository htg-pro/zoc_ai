"""Combined example test for FS-always / shell-agent-only / MCP trigger.

Task 8.13 (R8.3 + R8.6 + R8.9). One example-based suite that pins the three
context-bus capability rules together, the way the Orchestrator sees them:

* **FS read is always available** — the native FS read adapter serves reads
  regardless of whether Ask Mode or Agent Mode is active (R8.6).
* **Shell is Agent-Mode-only** — the subprocess shell spawner permits execution
  **if and only if** Agent Mode is active: it runs in Agent Mode and is refused
  in Ask Mode (R8.9).
* **MCP is knowledge-cutoff-triggered** — the Orchestrator invokes an
  ``MCP_Gateway`` tool call **only where a task requires data beyond the model's
  knowledge cutoff** (R8.3); a task answerable from the model alone makes no
  tool call.

The narrower per-adapter example tests live in ``test_shell_fs.py`` (R8.6/R8.9)
and ``test_mcp_gateway.py`` (R8.3/R8.4/R8.8); this suite asserts the three rules
hold *together* across both Ask and Agent contexts, with no real network call
(the web-search worker is an in-process stub).
"""

from __future__ import annotations

import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import pytest

from zocai_gateway.context.mcp_gateway import (
    WEB_SEARCH_TOOL,
    MCPGateway,
    RawDocument,
    WebSearchResult,
)
from zocai_gateway.context.shell_fs import (
    FSReadAdapter,
    ShellExecutionNotPermitted,
    ShellSpawner,
)
from zocai_gateway.mode_router import Mode


# --------------------------------------------------------------------------- #
# A stub web-search worker + a knowledge-cutoff trigger, modelling the
# Orchestrator's R8.3 decision without touching the network.
# --------------------------------------------------------------------------- #


class _StubWorker:
    """In-process :class:`WebSearchWorker` recording that it was used."""

    def __init__(self, documents: Sequence[RawDocument]) -> None:
        self._documents = tuple(documents)
        self.terminated = False

    def fetch(self, timeout: float) -> Sequence[RawDocument]:
        return self._documents

    def terminate(self) -> None:
        self.terminated = True


@dataclass(frozen=True)
class _Task:
    """A unit of work the Orchestrator routes (R8.3 modelling helper)."""

    query: str
    # True when answering needs data beyond the model's knowledge cutoff.
    requires_external_data: bool


def _orchestrate_mcp(task: _Task, gateway: MCPGateway) -> WebSearchResult | None:
    """Model the R8.3 trigger: invoke MCP iff the task needs external data.

    Returns the tool outcome when a call is made, or ``None`` when the task is
    answerable from the model alone and therefore makes no MCP tool call.
    """
    if not task.requires_external_data:
        return None
    return gateway.web_search(task.query)


# --------------------------------------------------------------------------- #
# FS read is available in BOTH modes (R8.6)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("mode", [Mode.ASK, Mode.AGENT])
def test_fs_read_works_in_both_modes(tmp_path: Path, mode: Mode) -> None:
    # The FS read adapter is mode-agnostic: the same read succeeds whether the
    # surrounding run is Ask Mode or Agent Mode (R8.6). ``mode`` is carried only
    # to make the "both contexts" coverage explicit.
    (tmp_path / "code.py").write_text("answer = 42\n", encoding="utf-8")
    adapter = FSReadAdapter(workspace_root=str(tmp_path))
    assert adapter.read_file("code.py") == "answer = 42\n"
    # Sanity: the FS adapter has no mode gate to begin with.
    assert not hasattr(adapter, "mode")


# --------------------------------------------------------------------------- #
# Shell is permitted in Agent Mode and refused in Ask Mode (R8.9)
# --------------------------------------------------------------------------- #


def test_shell_runs_in_agent_mode(tmp_path: Path) -> None:
    spawner = ShellSpawner(Mode.AGENT, workspace_root=str(tmp_path))
    assert spawner.shell_permitted is True
    result = spawner.run_shell([sys.executable, "-c", "print('ran')"])
    assert result.returncode == 0
    assert result.stdout.strip() == "ran"


def test_shell_is_blocked_in_ask_mode(tmp_path: Path) -> None:
    spawner = ShellSpawner(Mode.ASK, workspace_root=str(tmp_path))
    assert spawner.shell_permitted is False
    marker = tmp_path / "ran.txt"
    with pytest.raises(ShellExecutionNotPermitted) as excinfo:
        spawner.run_shell([sys.executable, "-c", f"open({str(marker)!r}, 'w').close()"])
    # The refusal names the rejected operation and nothing was executed.
    assert excinfo.value.operation == "run_shell"
    assert not marker.exists()


# --------------------------------------------------------------------------- #
# MCP is invoked for a knowledge-cutoff task, and only then (R8.3)
# --------------------------------------------------------------------------- #


def test_mcp_tool_invoked_for_knowledge_cutoff_task() -> None:
    worker = _StubWorker(
        [RawDocument(url="https://news/x", title="X", html="<p>Fresh <b>data</b></p>")]
    )
    gateway = MCPGateway(web_search_spawner=lambda q, n: worker)

    # A task that needs data beyond the knowledge cutoff triggers an MCP call.
    task = _Task(query="latest release of the framework", requires_external_data=True)
    outcome = _orchestrate_mcp(task, gateway)

    assert isinstance(outcome, WebSearchResult)
    assert outcome.tool == WEB_SEARCH_TOOL
    assert [d.text for d in outcome.documents] == ["Fresh data"]
    # The worker was actually spawned and then released.
    assert worker.terminated is True


def test_mcp_tool_not_invoked_without_knowledge_cutoff() -> None:
    spawned: list[str] = []

    def spawner(query: str, max_documents: int) -> _StubWorker:
        spawned.append(query)
        return _StubWorker([])

    gateway = MCPGateway(web_search_spawner=spawner)

    # A task answerable from the model alone makes no MCP tool call (R8.3).
    task = _Task(query="explain a for-loop", requires_external_data=False)
    outcome = _orchestrate_mcp(task, gateway)

    assert outcome is None
    assert spawned == []


# --------------------------------------------------------------------------- #
# The three rules hold together within one Ask context and one Agent context
# --------------------------------------------------------------------------- #


def test_capabilities_compose_in_ask_context(tmp_path: Path) -> None:
    # In an Ask-Mode context: FS read works, shell is refused, and an MCP call
    # still fires for a knowledge-cutoff task (MCP is mode-independent, R8.3).
    (tmp_path / "f.txt").write_text("ok", encoding="utf-8")
    assert FSReadAdapter(workspace_root=str(tmp_path)).read_file("f.txt") == "ok"

    with pytest.raises(ShellExecutionNotPermitted):
        ShellSpawner(Mode.ASK, workspace_root=str(tmp_path)).run_shell(
            [sys.executable, "-c", "print('nope')"]
        )

    worker = _StubWorker([RawDocument(url="u", title="t", html="<p>x</p>")])
    gateway = MCPGateway(web_search_spawner=lambda q, n: worker)
    outcome = _orchestrate_mcp(_Task("cutoff?", requires_external_data=True), gateway)
    assert isinstance(outcome, WebSearchResult)


def test_capabilities_compose_in_agent_context(tmp_path: Path) -> None:
    # In an Agent-Mode context: FS read works, shell runs, and an MCP call fires
    # for a knowledge-cutoff task.
    (tmp_path / "f.txt").write_text("ok", encoding="utf-8")
    assert FSReadAdapter(workspace_root=str(tmp_path)).read_file("f.txt") == "ok"

    result = ShellSpawner(Mode.AGENT, workspace_root=str(tmp_path)).run_shell(
        [sys.executable, "-c", "print('go')"]
    )
    assert result.returncode == 0 and result.stdout.strip() == "go"

    worker = _StubWorker([RawDocument(url="u", title="t", html="<p>x</p>")])
    gateway = MCPGateway(web_search_spawner=lambda q, n: worker)
    outcome = _orchestrate_mcp(_Task("cutoff?", requires_external_data=True), gateway)
    assert isinstance(outcome, WebSearchResult)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-v"]))
