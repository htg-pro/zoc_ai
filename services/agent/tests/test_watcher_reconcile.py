"""Resume file watchers across an agent restart.

The "watch for changes" preference is persisted per session in its index
store meta, but the live watcher is an in-memory asyncio task that dies when
the agent process restarts. Startup reconciliation must re-arm watchers for
any session whose persisted preference is on, so the saved choice keeps
taking effect without the user re-saving Indexer settings.
"""

from __future__ import annotations

import asyncio
import contextlib
import shutil
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from llama_studio_agent.hotpath import stream_watch as _real_stream_watch
from llama_studio_agent.reconcile import reconcile_active_watchers
from shared_schema.models import Session


def _hotpath_bin() -> str | None:
    """Resolve the real hotpath binary, or None when it isn't built.

    Mirrors ``config._default_hotpath_bin`` so the end-to-end watcher test can
    skip cleanly in environments where the Rust CLI hasn't been compiled, like
    the other binary-dependent tests in this suite.
    """

    import os

    explicit = os.environ.get("LLAMA_STUDIO_HOTPATH_BIN")
    if explicit and Path(explicit).exists():
        return explicit
    found = shutil.which("llama-studio-hotpath")
    if found:
        return found
    repo_root = Path(__file__).resolve().parents[3]
    for candidate in (
        repo_root / "target" / "release" / "llama-studio-hotpath",
        repo_root / "target" / "debug" / "llama-studio-hotpath",
    ):
        if candidate.exists():
            return str(candidate)
    return None


async def _never_ending_watch(path, settings=None):
    """A stand-in for hotpath.stream_watch that stays alive without a binary.

    The real watcher shells out to the hotpath CLI, which may not be built in
    the test environment; that would make the watcher task die immediately and
    the ``watching`` flag racy. This keeps the task alive so we can assert the
    watcher was actually re-armed.
    """

    await asyncio.Event().wait()
    yield {}  # pragma: no cover - never reached


@pytest.fixture(autouse=True)
def _stub_watch(monkeypatch):
    import llama_studio_agent.indexer.service as svc

    monkeypatch.setattr(svc.hotpath, "stream_watch", _never_ending_watch)


def _make_state(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("LLAMA_STUDIO_DATA_DIR", str(tmp_path / "data"))
    from llama_studio_agent.config import get_settings, reset_settings_cache
    from llama_studio_agent.state import build_app_state

    reset_settings_cache()
    return build_app_state(get_settings())


@pytest.mark.asyncio
async def test_resumes_watcher_for_enabled_session(tmp_path, monkeypatch):
    state = _make_state(tmp_path, monkeypatch)
    sess = Session(title="t", workspace_root=str(tmp_path), provider="mock", model="mock-1")
    state.repo.create_session(sess)
    # Persist the preference the way saving Indexer settings would.
    indexer = state.indexer_for(sess.id, sess.workspace_root)
    await indexer.start_watcher()
    assert indexer.watch_preference is True
    # Drop the live task to simulate a process restart leaving only meta behind.
    indexer._watcher_task = None

    n = await reconcile_active_watchers(state)
    assert n == 1
    assert indexer.status().watching is True
    await indexer.stop_watcher()


@pytest.mark.asyncio
async def test_skips_session_without_watch_preference(tmp_path, monkeypatch):
    state = _make_state(tmp_path, monkeypatch)
    sess = Session(title="t", workspace_root=str(tmp_path), provider="mock", model="mock-1")
    state.repo.create_session(sess)
    indexer = state.indexer_for(sess.id, sess.workspace_root)
    assert indexer.watch_preference is False

    n = await reconcile_active_watchers(state)
    assert n == 0
    assert indexer.status().watching is False


@pytest.mark.asyncio
async def test_skips_and_clears_watcher_for_missing_workspace(tmp_path, monkeypatch):
    state = _make_state(tmp_path, monkeypatch)
    workspace = tmp_path / "gone"
    workspace.mkdir()
    sess = Session(
        title="t", workspace_root=str(workspace), provider="mock", model="mock-1"
    )
    state.repo.create_session(sess)
    indexer = state.indexer_for(sess.id, sess.workspace_root)
    await indexer.start_watcher()
    assert indexer.watch_preference is True
    indexer._watcher_task = None
    # The workspace folder disappears (e.g. the session/folder was deleted).
    workspace.rmdir()

    n = await reconcile_active_watchers(state)
    assert n == 0
    assert indexer.status().watching is False
    # The persisted preference is cleared so future restarts don't retry.
    assert indexer.watch_preference is False


def test_startup_resumes_persisted_watchers(tmp_path, monkeypatch):
    # First process: enable watching so the preference is persisted, then drop
    # the in-memory state to simulate a restart leaving only the meta behind.
    import asyncio

    s1 = _make_state(tmp_path, monkeypatch)
    sess = Session(title="t", workspace_root=str(tmp_path), provider="mock", model="mock-1")
    s1.repo.create_session(sess)
    idx1 = s1.indexer_for(sess.id, sess.workspace_root)
    asyncio.run(idx1.start_watcher())
    assert idx1.watch_preference is True
    del s1

    # Second process boots against the same data dir; lifespan re-arms watchers.
    s2 = _make_state(tmp_path, monkeypatch)
    from llama_studio_agent.app import create_app

    app = create_app(s2.settings, state=s2)
    with TestClient(app):
        idx2 = s2.indexer_for(sess.id, sess.workspace_root)
        assert idx2.watch_preference is True
        assert idx2.status().watching is True


@pytest.mark.skipif(
    _hotpath_bin() is None,
    reason="hotpath binary not built; end-to-end watcher test needs the real CLI",
)
@pytest.mark.asyncio
async def test_resumed_watcher_reindexes_live_edit(tmp_path, monkeypatch):
    """End-to-end: a watcher resumed by startup reconciliation re-indexes a
    file that changes on disk afterwards.

    Unlike the other tests in this module (which stub ``stream_watch`` with a
    long-lived generator), this drives the *real* hotpath watch binary so we
    prove actual filesystem edits flow through the resumed watcher — not just
    that the asyncio task was re-armed.
    """

    import llama_studio_agent.indexer.service as svc

    # Undo the autouse stub so this test uses the real hotpath watcher.
    monkeypatch.setattr(svc.hotpath, "stream_watch", _real_stream_watch)
    # Point the indexer at the freshly-built binary regardless of PATH.
    monkeypatch.setenv("LLAMA_STUDIO_HOTPATH_BIN", _hotpath_bin())

    state = _make_state(tmp_path, monkeypatch)
    workspace = tmp_path / "ws"
    workspace.mkdir()
    target = workspace / "greet.py"
    target.write_text("def greet():\n    return 'hi'\n", encoding="utf-8")

    sess = Session(
        title="t", workspace_root=str(workspace), provider="mock", model="mock-1"
    )
    state.repo.create_session(sess)

    indexer = state.indexer_for(sess.id, sess.workspace_root)
    # Baseline index of the workspace before any live edits.
    await indexer.reindex()
    assert not await _query_has(indexer, "farewell")

    # Persist the watch preference the way saving Indexer settings would, then
    # tear down the live task to simulate a process restart leaving only the
    # persisted meta behind. We must actually CANCEL the original task (not just
    # drop the reference) so no orphan watcher is left running to service the
    # edit — otherwise the test could pass without reconciliation doing anything.
    await indexer.start_watcher()
    assert indexer.watch_preference is True
    orphan = indexer._watcher_task
    assert orphan is not None
    orphan.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await orphan
    indexer._watcher_task = None
    assert indexer.status().watching is False  # no live watcher post-"restart"

    # Startup reconciliation re-arms the watcher purely from the persisted
    # preference; this is the only watcher that can pick up the live edit below.
    n = await reconcile_active_watchers(state)
    assert n == 1
    resumed = indexer._watcher_task
    assert resumed is not None and resumed is not orphan
    assert indexer.status().watching is True

    try:
        # Give the watcher subprocess a moment to start watching the tree.
        await asyncio.sleep(0.75)
        # Change the file on disk; the resumed watcher should re-index it.
        target.write_text(
            "def greet():\n    return 'hello'\n\n"
            "def farewell():\n    return 'goodbye'\n",
            encoding="utf-8",
        )
        # Poll until the new content is searchable in the index. The resumed
        # watcher must stay alive the whole time, proving it (not a stale
        # fallback) is what serviced the edit.
        deadline = time.monotonic() + 15.0
        reindexed = False
        while time.monotonic() < deadline:
            assert not resumed.done(), "resumed watcher task died before re-indexing"
            if await _query_has(indexer, "farewell"):
                reindexed = True
                break
            await asyncio.sleep(0.25)
        assert reindexed, "resumed watcher did not re-index the live edit"
    finally:
        await indexer.stop_watcher()


async def _query_has(indexer, needle: str) -> bool:
    """True when any indexed chunk's text contains ``needle``."""

    hits = await indexer.query(needle, top_k=16)
    return any(needle in hit.chunk.text for hit in hits)
