"""Tests for SSE backpressure, idle handling and event replay (§9.2)."""

from __future__ import annotations

import asyncio
import json
import threading

import pytest
from fastapi.testclient import TestClient
from zocai_gateway.app import (
    DEFAULT_EVENT_REPLAY_BUFFER,
    DEFAULT_SSE_QUEUE_MAXSIZE,
    RunRegistry,
    _event_stream,
    _Run,
    create_app,
)
from zocai_gateway.mode_router import Mode
from zocai_gateway.settings import GatewaySettings


class _Path:
    """Minimal ExecutionPath stand-in (only ``mode`` is read by ``_Run``)."""

    mode = Mode.AGENT
    skip_planner = False
    toolset = None


def _frame(seq: int) -> dict[str, object]:
    return {"type": "token", "seq": seq, "runId": "r1", "text": f"chunk-{seq}"}


# ── bounded queue ────────────────────────────────────────────────────────────


def test_run_queue_is_bounded_by_default() -> None:
    run = _Run("r1", _Path())
    assert run.queue.maxsize == DEFAULT_SSE_QUEUE_MAXSIZE


def test_run_queue_maxsize_is_configurable() -> None:
    run = _Run("r1", _Path(), queue_maxsize=4)
    assert run.queue.maxsize == 4


def test_registry_propagates_queue_and_replay_sizes() -> None:
    registry = RunRegistry(queue_maxsize=7, replay_buffer_size=9)
    run = registry.create(_Path(), run_id="r1")
    assert run.queue.maxsize == 7
    for seq in range(20):
        run._put(_frame(seq))
    # The replay buffer is circular: it keeps the newest 9 frames.
    assert len(run.replay()) == 9


def test_settings_expose_the_backpressure_defaults() -> None:
    settings = GatewaySettings()
    assert settings.sse_queue_maxsize == 512
    assert settings.event_replay_buffer_size == 1024
    assert settings.sse_client_timeout_seconds == 60.0


def test_settings_read_backpressure_env_vars() -> None:
    settings = GatewaySettings.from_env(
        {
            "ZOC_STUDIO_GATEWAY_SSE_QUEUE_MAXSIZE": "16",
            "ZOC_STUDIO_GATEWAY_SSE_CLIENT_TIMEOUT_SECONDS": "5",
            "ZOC_STUDIO_GATEWAY_EVENT_REPLAY_BUFFER": "32",
            "ZOC_STUDIO_GATEWAY_MAX_CONCURRENT_RUNS": "2",
        }
    )
    assert settings.sse_queue_maxsize == 16
    assert settings.sse_client_timeout_seconds == 5.0
    assert settings.event_replay_buffer_size == 32
    assert settings.max_concurrent_runs == 2


@pytest.mark.asyncio
async def test_run_fans_out_each_frame_to_every_subscriber() -> None:
    run = _Run("r1", _Path())
    first = run.subscribe()
    second = run.subscribe()

    frame = _frame(1)
    run._put(frame)

    assert await asyncio.wait_for(first.get(), timeout=1) == frame
    assert await asyncio.wait_for(second.get(), timeout=1) == frame

    run.close()
    # `close()` now emits exactly one terminal frame ahead of the sentinel (the
    # guarantee that stops a closed run from looking "Running…" in the UI), and
    # fan-out applies to it like any other frame: both subscribers see the
    # terminal frame *and* the sentinel.
    first_terminal = await asyncio.wait_for(first.get(), timeout=1)
    second_terminal = await asyncio.wait_for(second.get(), timeout=1)
    assert first_terminal is not None
    assert first_terminal["type"] == "done"
    assert first_terminal == second_terminal

    assert await asyncio.wait_for(first.get(), timeout=1) is None
    assert await asyncio.wait_for(second.get(), timeout=1) is None
    run.unsubscribe(first)
    run.unsubscribe(second)


@pytest.mark.asyncio
async def test_producer_thread_blocks_until_the_consumer_drains() -> None:
    """A full queue must make the producing thread *wait*, not drop or grow.

    This is the backpressure contract: the worker thread is held at the queue
    boundary until the SSE consumer takes a frame.
    """
    run = _Run("r1", _Path(), queue_maxsize=2)
    started = threading.Event()
    finished = threading.Event()

    def produce() -> None:
        started.set()
        for seq in range(4):  # two more than the queue can hold
            run._put(_frame(seq))
        finished.set()

    worker = threading.Thread(target=produce, daemon=True)
    worker.start()
    started.wait(timeout=2)

    # Let the producer fill the queue and block on the third put.
    await asyncio.sleep(0.15)
    assert not finished.is_set(), "producer should be blocked on a full queue"
    assert run.queue.qsize() == 2

    # Draining unblocks it and every frame arrives, in order.
    received = []
    for _ in range(4):
        received.append(await asyncio.wait_for(run.queue.get(), timeout=2))
    await asyncio.to_thread(finished.wait, 2)

    assert finished.is_set()
    assert [f["seq"] for f in received] == [0, 1, 2, 3]


# ── replay buffer ────────────────────────────────────────────────────────────


def test_replay_defaults_to_the_full_buffer() -> None:
    run = _Run("r1", _Path())
    for seq in range(5):
        run._put(_frame(seq))
    assert [f["seq"] for f in run.replay()] == [0, 1, 2, 3, 4]


def test_replay_since_seq_returns_only_later_frames() -> None:
    run = _Run("r1", _Path())
    for seq in range(5):
        run._put(_frame(seq))
    assert [f["seq"] for f in run.replay(2)] == [3, 4]
    assert run.replay(4) == []


def test_replay_buffer_is_circular_at_1024_by_default() -> None:
    run = _Run("r1", _Path())
    for seq in range(DEFAULT_EVENT_REPLAY_BUFFER + 100):
        run._put(_frame(seq))
    frames = run.replay()
    assert len(frames) == DEFAULT_EVENT_REPLAY_BUFFER
    assert frames[0]["seq"] == 100  # oldest 100 were evicted


def test_close_sentinel_is_not_recorded_in_history() -> None:
    run = _Run("r1", _Path())
    run._put(_frame(0))
    run.close()
    assert all(frame is not None for frame in run.replay())


# ── stream behaviour ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_idle_stream_heartbeats_then_ends_without_closing_the_run() -> None:
    run = _Run("r1", _Path())
    frames = [
        frame
        async for frame in _event_stream(
            run,
            queue_timeout_seconds=5.0,
            heartbeat_seconds=0.01,
            client_timeout_seconds=0.05,
        )
    ]

    assert any(f["event"] == "ping" for f in frames), "expected heartbeats"
    assert frames[-1]["event"] == "error"
    payload = json.loads(frames[-1]["data"])
    assert "since_seq" in payload["message"]
    # The critical part: the run itself survives so the client can reconnect.
    assert run.is_closed is False


@pytest.mark.asyncio
async def test_stalled_stream_leaves_the_run_in_the_registry() -> None:
    registry = RunRegistry()
    run = registry.create(_Path(), run_id="r1")

    async for _ in _event_stream(
        run,
        registry=registry,
        queue_timeout_seconds=5.0,
        heartbeat_seconds=0.01,
        client_timeout_seconds=0.03,
    ):
        pass

    assert registry.get("r1") is run


@pytest.mark.asyncio
async def test_closed_run_is_forgotten_when_its_stream_ends() -> None:
    registry = RunRegistry()
    run = registry.create(_Path(), run_id="r1")
    run.close()

    async for _ in _event_stream(run, registry=registry, heartbeat_seconds=0.01):
        pass

    assert registry.get("r1") is None


@pytest.mark.asyncio
async def test_stream_replays_history_before_live_frames() -> None:
    run = _Run("r1", _Path())
    for seq in range(3):
        run._put(_frame(seq))
    # Drain the live queue so only the replay buffer holds those frames.
    while not run.queue.empty():
        run.queue.get_nowait()
    run._put(_frame(3))
    run.close()

    frames = [frame async for frame in _event_stream(run, heartbeat_seconds=0.01, since_seq=0)]
    seqs = [json.loads(f["data"])["seq"] for f in frames if f["event"] != "ping"]
    # 1 and 2 come from the buffer, 3 was still queued — and 3 must not be
    # delivered twice even though it is in both places.
    assert seqs == [1, 2, 3]


@pytest.mark.asyncio
async def test_resume_never_duplicates_a_sequence_number() -> None:
    run = _Run("r1", _Path())
    for seq in range(6):
        run._put(_frame(seq))
    run.close()

    frames = [frame async for frame in _event_stream(run, heartbeat_seconds=0.01, since_seq=2)]
    seqs = [json.loads(f["data"])["seq"] for f in frames if f["event"] != "ping"]

    assert seqs == sorted(set(seqs)), "resumed stream must be gap-free and unique"
    assert seqs == [3, 4, 5]


# ── replay endpoint ──────────────────────────────────────────────────────────


def test_replay_endpoint_returns_buffered_events() -> None:
    app = create_app(drive=False)
    client = TestClient(app)
    registry: RunRegistry = app.state.run_registry
    run = registry.create(_Path(), run_id="run-replay")
    for seq in range(4):
        run._put(_frame(seq))

    res = client.get("/v1/agent/runs/run-replay/events/replay", params={"since_seq": 1})

    assert res.status_code == 200
    body = res.json()
    assert body["runId"] == "run-replay"
    assert body["count"] == 2
    assert [e["seq"] for e in body["events"]] == [2, 3]
    assert body["lastSeq"] == 3
    assert body["closed"] is False


def test_replay_endpoint_without_cursor_returns_everything() -> None:
    app = create_app(drive=False)
    client = TestClient(app)
    run = app.state.run_registry.create(_Path(), run_id="run-all")
    run._put(_frame(0))

    body = client.get("/v1/agent/runs/run-all/events/replay").json()

    assert body["count"] == 1
    assert body["sinceSeq"] is None


def test_replay_endpoint_404s_for_unknown_run() -> None:
    client = TestClient(create_app(drive=False))
    assert client.get("/v1/agent/runs/nope/events/replay").status_code == 404
