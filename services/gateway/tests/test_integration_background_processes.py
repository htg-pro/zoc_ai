"""Integration test for the background-process inventory (task 9.8).

Feature: zoc-agent-ecosystem-merge.

**Validates: Requirements 9.1, 9.4, 9.5, 6.6**

This test pins down the *background-process inventory* of the merged Gateway by
driving its real FastAPI lifespan **in process** with a
:class:`~fastapi.testclient.TestClient` context manager. Entering the context
runs startup and exiting it runs shutdown synchronously, so the worker
start/stop transitions are observed deterministically without ever spawning a
real server, subprocess, or polling loop.

It asserts the merged app's background model:

* **Startup inventory (R9.1, R9.4, R6.6).** When the app is created against a
  workspace, exactly one Tier 1 ``Diary_Worker`` and exactly one Tier 3
  Hermes-Evolution idle loop are started — and nothing else. There are not two
  workers covering the same concern, and no legacy ``services/agent``
  watcher/reconciler/run task exists to wire at startup.
* **Clean shutdown (R9.5).** Exiting the lifespan stops both workers cleanly:
  their threads are joined and no worker thread is left alive (no orphan).
* **Single sidecar backend (R6.6).** The desktop manifest declares the Gateway
  exactly once as the ``zoc-studio-agent`` sidecar, so the supervisor spawns a
  single agent backend.

All assertions inspect the real ``create_app`` / ``DiaryWorker`` /
``HermesEvolution`` objects and the in-process thread table — never the OS
process table.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path

from fastapi.testclient import TestClient

from zocai_gateway.app import create_app
from zocai_gateway.memory.diary_worker import DiaryWorker
from zocai_gateway.memory.hermes_evolution import HermesEvolution

# Thread names assigned by the two background workers (see their ``start``).
DIARY_THREAD_NAME = "zocai-diary-worker"
HERMES_THREAD_NAME = "zocai-hermes-evolution"

# Names that would betray a surviving legacy background concern (R9.2/R9.4):
# a second worker watching/reconciling/running the agent alongside the Gateway.
_LEGACY_THREAD_MARKERS = ("watcher", "reconcil", "agent-run", "run-loop", "runner")


def _live_threads_named(name: str) -> list[threading.Thread]:
    """Return the currently-alive threads whose name equals ``name``."""
    return [t for t in threading.enumerate() if t.name == name and t.is_alive()]


def _find_workspace_root() -> Path:
    """Walk upward from this test file to the monorepo root.

    The root is identified by the co-location of the three top-level build
    manifests that anchor the multi-language workspace (pnpm + Cargo + uv).
    """
    markers = ("pnpm-workspace.yaml", "Cargo.toml", "pyproject.toml")
    for candidate in (Path(__file__).resolve(), *Path(__file__).resolve().parents):
        if candidate.is_dir() and all((candidate / m).is_file() for m in markers):
            return candidate
    raise RuntimeError("could not locate the monorepo workspace root")


WORKSPACE_ROOT = _find_workspace_root()


# ---------------------------------------------------------------------------
# R9.1 / R9.4 / R6.6 -- startup starts exactly the expected workers
# ---------------------------------------------------------------------------


def test_startup_starts_single_diary_worker_and_idle_loop(tmp_path: Path) -> None:
    """Exactly one Diary_Worker and one idle evolution loop run after startup.

    Drives the real lifespan in process: with a workspace configured, the app
    starts a single Tier 1 ``DiaryWorker`` (R9.1) and a single Tier 3
    Hermes-Evolution idle loop, each on its own live daemon thread, and no two
    workers cover the same concern (R9.4).

    **Validates: Requirements 9.1, 9.4, 6.6**
    """
    app = create_app(workspace_root=tmp_path)
    with TestClient(app):
        diary_worker = app.state.diary_worker
        hermes = app.state.hermes

        # The single diary process is a real, started, running Diary_Worker.
        assert isinstance(diary_worker, DiaryWorker)
        assert diary_worker._started is True
        assert diary_worker._stopped is False
        assert diary_worker._thread is not None
        assert diary_worker._thread.is_alive()

        # The single idle evolution loop is a real, started HermesEvolution.
        assert isinstance(hermes, HermesEvolution)
        assert hermes._started is True
        assert hermes._thread is not None
        assert hermes._thread.is_alive()

        # Exactly one thread per concern -- not two workers doing the same job.
        assert len(_live_threads_named(DIARY_THREAD_NAME)) == 1
        assert len(_live_threads_named(HERMES_THREAD_NAME)) == 1

        # The diary worker and the evolution loop are distinct concerns running
        # on distinct threads (no overlap / duplication).
        assert diary_worker._thread is not hermes._thread


# ---------------------------------------------------------------------------
# R6.6 / R9.4 -- no legacy watcher/reconciler/run task is wired at startup
# ---------------------------------------------------------------------------


def test_no_legacy_background_watcher_or_run_task(tmp_path: Path) -> None:
    """No superseded legacy background watcher/reconciler/run task exists.

    The legacy ``services/agent`` backend is removed, so there is no legacy
    watcher/reconciler/run task to start at startup, and no background thread
    bearing a legacy-concern name runs alongside the Gateway workers (R6.6,
    R9.4).

    **Validates: Requirements 6.6, 9.4**
    """
    # The legacy agent backend no longer exists on disk -- nothing to wire.
    assert not (WORKSPACE_ROOT / "services" / "agent").exists()

    app = create_app(workspace_root=tmp_path)
    with TestClient(app):
        live_names = [t.name.lower() for t in threading.enumerate() if t.is_alive()]
        for name in live_names:
            for marker in _LEGACY_THREAD_MARKERS:
                assert marker not in name, (
                    f"a legacy background thread is running: {name!r} "
                    f"(matched marker {marker!r})"
                )

        # Only one of each Gateway worker concern is present (no duplicate
        # implementation competing for the same job).
        assert len(_live_threads_named(DIARY_THREAD_NAME)) == 1
        assert len(_live_threads_named(HERMES_THREAD_NAME)) == 1


# ---------------------------------------------------------------------------
# R9.5 -- shutdown stops every worker cleanly with no orphan left running
# ---------------------------------------------------------------------------


def test_shutdown_stops_workers_cleanly_without_orphans(tmp_path: Path) -> None:
    """Exiting the lifespan stops both workers with no lingering thread.

    Captures the worker objects and their threads inside the lifespan, then
    asserts that after the ``TestClient`` context exits (shutdown) both workers
    report stopped and their threads are joined / no longer alive, leaving no
    orphaned background process (R9.5).

    **Validates: Requirements 9.5**
    """
    app = create_app(workspace_root=tmp_path)
    with TestClient(app):
        diary_worker = app.state.diary_worker
        hermes = app.state.hermes
        # Hold direct references to the running threads so we can assert on
        # their liveness after the workers null out their own handles on stop.
        diary_thread = diary_worker._thread
        hermes_thread = hermes._thread
        assert diary_thread is not None and diary_thread.is_alive()
        assert hermes_thread is not None and hermes_thread.is_alive()

    # Shutdown ran on context exit: workers are stopped and joined.
    assert diary_worker._stopped is True
    assert diary_worker._thread is None
    assert diary_thread is not None and not diary_thread.is_alive()

    assert hermes._started is False
    assert hermes._thread is None
    assert hermes_thread is not None and not hermes_thread.is_alive()

    # No orphaned worker thread of either concern survives the shutdown.
    assert _live_threads_named(DIARY_THREAD_NAME) == []
    assert _live_threads_named(HERMES_THREAD_NAME) == []


# ---------------------------------------------------------------------------
# R6.6 -- the supervisor spawns exactly one sidecar backend
# ---------------------------------------------------------------------------


def test_supervisor_declares_single_sidecar_backend() -> None:
    """The desktop manifest declares the Gateway sidecar exactly once.

    The Tauri supervisor spawns one agent backend: the ``externalBin`` list
    declares ``binaries/zoc-studio-agent`` exactly once, so a single Gateway
    sidecar is launched (R6.6).

    **Validates: Requirements 6.6**
    """
    manifest = WORKSPACE_ROOT / "apps" / "desktop" / "tauri.conf.json"
    assert manifest.is_file(), f"missing Tauri manifest: {manifest}"

    data = json.loads(manifest.read_text(encoding="utf-8"))
    external_bin = data.get("bundle", {}).get("externalBin", [])
    sidecar_entries = [b for b in external_bin if b == "binaries/zoc-studio-agent"]
    assert len(sidecar_entries) == 1, (
        f"expected exactly one zoc-studio-agent sidecar entry, "
        f"found {sidecar_entries!r} in externalBin {external_bin!r}"
    )
