"""Tests for parallel agent runs and per-file write locks (§12.3)."""

from __future__ import annotations

import threading
from time import monotonic

from fastapi.testclient import TestClient
from zocai_gateway.app import RunRegistry, create_app
from zocai_gateway.file_locks import (
    DEFAULT_LOCK_TIMEOUT_SECONDS,
    FileLockRegistry,
    normalize_lock_path,
)
from zocai_gateway.mode_router import Mode
from zocai_gateway.settings import GatewaySettings


class _Path:
    mode = Mode.AGENT
    skip_planner = False
    toolset = None


# ── lock keys ────────────────────────────────────────────────────────────────


def test_lock_paths_are_normalised() -> None:
    for raw in ("src/app.py", "src\\app.py", "./src/app.py", " src/app.py ", "/src/app.py"):
        assert normalize_lock_path(raw) == "src/app.py"


def test_windows_and_posix_spellings_share_one_lock() -> None:
    locks = FileLockRegistry()
    assert locks.acquire("run-a", ["src/app.py"]).acquired is True
    # The same file spelled with backslashes must be recognised as taken.
    result = locks.acquire("run-b", ["src\\app.py"], timeout=0)
    assert result.acquired is False


# ── acquisition semantics ────────────────────────────────────────────────────


def test_disjoint_files_never_contend() -> None:
    locks = FileLockRegistry()
    assert locks.acquire("run-a", ["a.py", "b.py"]).acquired is True
    assert locks.acquire("run-b", ["c.py"], timeout=0).acquired is True
    assert set(locks.held_paths()) == {"a.py", "b.py", "c.py"}


def test_second_run_is_blocked_and_told_who_holds_the_file() -> None:
    locks = FileLockRegistry()
    locks.acquire("run-a", ["shared.py"])

    result = locks.acquire("run-b", ["shared.py", "other.py"], timeout=0)

    assert result.acquired is False
    assert result.blocked_paths == ("shared.py",)
    assert result.blocked_by == ("run-a",)
    # All-or-nothing: the uncontended file must NOT have been taken.
    assert locks.holder("other.py") is None


def test_release_unblocks_a_waiter() -> None:
    locks = FileLockRegistry()
    locks.acquire("run-a", ["shared.py"])
    acquired = threading.Event()

    def waiter() -> None:
        if locks.acquire("run-b", ["shared.py"], timeout=5).acquired:
            acquired.set()

    thread = threading.Thread(target=waiter, daemon=True)
    thread.start()
    assert not acquired.wait(timeout=0.2), "must block while held"

    locks.release("run-a", ["shared.py"])

    assert acquired.wait(timeout=5) is True
    assert locks.holder("shared.py") == "run-b"


def test_acquisition_respects_the_timeout_budget() -> None:
    locks = FileLockRegistry()
    locks.acquire("run-a", ["shared.py"])

    started = monotonic()
    result = locks.acquire("run-b", ["shared.py"], timeout=0.3)
    elapsed = monotonic() - started

    assert result.acquired is False
    assert 0.25 <= elapsed < 3.0, f"waited {elapsed:.2f}s"


def test_default_timeout_is_ten_seconds() -> None:
    assert DEFAULT_LOCK_TIMEOUT_SECONDS == 10.0


def test_acquisition_is_reentrant_for_the_same_run() -> None:
    locks = FileLockRegistry()
    assert locks.acquire("run-a", ["a.py"]).acquired is True
    assert locks.acquire("run-a", ["a.py"]).acquired is True
    # Two acquisitions need two releases.
    locks.release("run-a", ["a.py"])
    assert locks.holder("a.py") == "run-a"
    locks.release("run-a", ["a.py"])
    assert locks.holder("a.py") is None


def test_release_run_drops_everything_a_crashed_run_held() -> None:
    locks = FileLockRegistry()
    locks.acquire("run-a", ["a.py", "b.py"])
    locks.release_run("run-a")
    assert locks.held_paths() == ()


def test_release_ignores_paths_held_by_another_run() -> None:
    locks = FileLockRegistry()
    locks.acquire("run-a", ["a.py"])
    locks.release("run-b", ["a.py"])
    assert locks.holder("a.py") == "run-a"


def test_empty_path_set_acquires_trivially() -> None:
    locks = FileLockRegistry()
    result = locks.acquire("run-a", [])
    assert result.acquired is True
    assert locks.held_paths() == ()


def test_hold_releases_even_when_the_body_raises() -> None:
    locks = FileLockRegistry()
    try:
        with locks.hold("run-a", ["a.py"]) as acquisition:
            assert acquisition.acquired is True
            raise RuntimeError("apply blew up")
    except RuntimeError:
        pass
    assert locks.held_paths() == ()


def test_ordered_acquisition_prevents_deadlock() -> None:
    """Two runs grabbing the same pair in opposite orders must both finish.

    The registry sorts paths before locking, so the classic AB/BA deadlock
    cannot form.
    """
    locks = FileLockRegistry()
    done = []
    barrier = threading.Barrier(2)

    def worker(run_id: str, paths: list[str]) -> None:
        barrier.wait()
        for _ in range(20):
            result = locks.acquire(run_id, paths, timeout=2)
            if result.acquired:
                locks.release(run_id, result.paths)
                done.append(run_id)
                return

    threads = [
        threading.Thread(target=worker, args=("run-a", ["a.py", "b.py"]), daemon=True),
        threading.Thread(target=worker, args=("run-b", ["b.py", "a.py"]), daemon=True),
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)

    assert sorted(done) == ["run-a", "run-b"]
    assert locks.held_paths() == ()


# ── concurrency cap ──────────────────────────────────────────────────────────


def test_registry_reports_capacity() -> None:
    registry = RunRegistry(max_concurrent_runs=2)
    assert registry.at_capacity() is False
    registry.create(_Path(), run_id="r1")
    registry.create(_Path(), run_id="r2")
    assert registry.active_count() == 2
    assert registry.at_capacity() is True


def test_closed_runs_free_capacity() -> None:
    registry = RunRegistry(max_concurrent_runs=1)
    run = registry.create(_Path(), run_id="r1")
    assert registry.at_capacity() is True
    run.close()
    assert registry.at_capacity() is False
    assert registry.active_count() == 0


def test_default_cap_is_three_runs() -> None:
    assert GatewaySettings().max_concurrent_runs == 3
    assert RunRegistry().max_concurrent_runs == 3


def test_run_endpoint_rejects_beyond_the_cap() -> None:
    app = create_app(
        drive=False, settings=GatewaySettings(max_concurrent_runs=1)
    )
    client = TestClient(app)

    first = client.post("/v1/agent/run", json={"prompt": "one", "mode": "agent"})
    assert first.status_code == 200

    second = client.post("/v1/agent/run", json={"prompt": "two", "mode": "agent"})
    assert second.status_code == 429
    assert "limit 1" in second.json()["detail"]


def test_runtime_endpoint_reports_concurrency_state() -> None:
    app = create_app(drive=False, settings=GatewaySettings(max_concurrent_runs=2))
    client = TestClient(app)
    client.post("/v1/agent/run", json={"prompt": "one", "mode": "agent"})

    body = client.get("/v1/agent/runtime").json()

    assert body["max_concurrent_runs"] == 2
    assert body["running"] == 1
    assert len(body["run_ids"]) == 1
    assert body["locked_files"] == []
