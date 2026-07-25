"""Tests for hardware probing, model recommendation and the monitor (§13.1, §16.2)."""

from __future__ import annotations

import asyncio
import json

from fastapi.testclient import TestClient
from zocai_gateway import model_runtime
from zocai_gateway.app import (
    HARDWARE_STREAM_INTERVAL_SECONDS,
    _hardware_stream,
    create_app,
)
from zocai_gateway.hardware_probe import (
    HardwareProfile,
    HardwareSnapshot,
    recommend_model,
    snapshot,
)

# ── recommendation ───────────────────────────────────────────────────────────


def test_big_gpu_gets_the_largest_model() -> None:
    rec = recommend_model(HardwareProfile(gpu_memory_gb=24.0, system_memory_gb=64.0))
    assert "32B" in rec.model
    assert rec.gpu_layers > 0


def test_mid_gpu_gets_a_14b_model() -> None:
    rec = recommend_model(HardwareProfile(gpu_memory_gb=12.0, system_memory_gb=32.0))
    assert "14B" in rec.model


def test_small_gpu_gets_a_7b_model() -> None:
    rec = recommend_model(HardwareProfile(gpu_memory_gb=8.0, system_memory_gb=16.0))
    assert "7B" in rec.model
    assert rec.gpu_layers > 0


def test_tiny_gpu_offloads_only_part_of_the_model() -> None:
    rec = recommend_model(HardwareProfile(gpu_memory_gb=4.0, system_memory_gb=16.0))
    assert "7B" in rec.model
    # Partial offload: some layers on the GPU, not "all of them".
    assert 0 < rec.gpu_layers < 999


def test_cpu_only_host_gets_a_cpu_recommendation() -> None:
    rec = recommend_model(HardwareProfile(gpu_memory_gb=None, system_memory_gb=32.0))
    assert rec.gpu_layers == 0
    assert "CPU" in rec.reason


def test_low_memory_host_gets_the_smallest_model() -> None:
    rec = recommend_model(HardwareProfile(gpu_memory_gb=None, system_memory_gb=4.0))
    assert "1.5B" in rec.model
    assert rec.gpu_layers == 0


def test_undetectable_hardware_is_conservative() -> None:
    rec = recommend_model(None)
    assert "1.5B" in rec.model
    assert rec.approx_size_gb < 2.0


def test_every_recommendation_is_self_describing() -> None:
    for profile in (
        None,
        HardwareProfile(gpu_memory_gb=24.0, system_memory_gb=64.0),
        HardwareProfile(gpu_memory_gb=None, system_memory_gb=8.0),
    ):
        rec = recommend_model(profile)
        assert rec.model and rec.quantization and rec.reason
        assert rec.approx_size_gb > 0


# ── snapshot ─────────────────────────────────────────────────────────────────


def test_snapshot_returns_the_documented_shape() -> None:
    reading = snapshot()
    payload = reading.as_payload()
    assert set(payload) == {
        "cpu_percent",
        "ram_used_gb",
        "ram_total_gb",
        "gpu_vram_used_mb",
        "gpu_vram_total_mb",
        "llm_tokens_per_second",
        "llm_inference_active",
    }


def test_snapshot_carries_caller_supplied_llm_metrics() -> None:
    reading = snapshot(tokens_per_second=32.5, inference_active=True)
    assert reading.llm_tokens_per_second == 32.5
    assert reading.llm_inference_active is True


def test_snapshot_defaults_to_inactive_inference() -> None:
    assert snapshot().llm_inference_active is False


def test_snapshot_values_are_plausible_or_none() -> None:
    reading = snapshot()
    if reading.cpu_percent is not None:
        assert 0.0 <= reading.cpu_percent <= 100.0
    if reading.ram_total_gb is not None:
        assert reading.ram_total_gb > 0
    if reading.ram_used_gb is not None and reading.ram_total_gb is not None:
        # Used memory can never exceed the total (allow a small rounding margin).
        assert reading.ram_used_gb <= reading.ram_total_gb + 0.5


def test_empty_snapshot_serialises_nulls() -> None:
    payload = HardwareSnapshot().as_payload()
    assert payload["cpu_percent"] is None
    assert payload["gpu_vram_total_mb"] is None
    assert payload["llm_inference_active"] is False


# ── endpoints ────────────────────────────────────────────────────────────────


def test_hardware_endpoint_reports_profile_and_recommendation() -> None:
    client = TestClient(create_app(drive=False))

    body = client.get("/v1/hardware").json()

    assert "detected" in body
    assert set(body["recommendation"]) == {
        "model",
        "quantization",
        "approx_size_gb",
        "gpu_layers",
        "reason",
    }
    assert "snapshot" in body


def test_hardware_stream_emits_snapshot_events() -> None:
    """The generator emits one well-formed frame per tick and then stops."""
    frames = asyncio.run(_collect_stream(2))

    assert len(frames) == 2
    for frame in frames:
        assert frame["event"] == "hardware"
        payload = json.loads(frame["data"])
        assert "ram_total_gb" in payload
        assert "llm_inference_active" in payload


def test_hardware_stream_route_is_registered() -> None:
    app = create_app(drive=False)
    paths = {getattr(route, "path", None) for route in app.routes}
    assert "/v1/hardware/stream" in paths
    assert "/v1/hardware" in paths


async def _collect_stream(count: int) -> list[dict[str, str]]:
    return [frame async for frame in _hardware_stream(interval_seconds=0.001, max_events=count)]


def test_stream_interval_is_two_seconds() -> None:
    assert HARDWARE_STREAM_INTERVAL_SECONDS == 2.0


def test_hardware_stream_includes_live_model_metrics(monkeypatch) -> None:
    monkeypatch.setattr(
        "zocai_gateway.app.model_runtime.live_inference_metrics",
        lambda: model_runtime.LiveInferenceMetrics(
            tokens_per_second=41.5,
            inference_active=True,
        ),
    )

    frame = asyncio.run(_collect_stream(1))[0]
    payload = json.loads(frame["data"])
    assert payload["llm_tokens_per_second"] == 41.5
    assert payload["llm_inference_active"] is True


def test_live_inference_sampler_tracks_activity_and_tps() -> None:
    assert model_runtime.live_inference_metrics().inference_active is False
    with model_runtime._inference_scope():
        model_runtime._record_generated_chunk("one streamed token")
        reading = model_runtime.live_inference_metrics()
        assert reading.inference_active is True
        assert reading.tokens_per_second is not None
        assert reading.tokens_per_second > 0
    assert model_runtime.live_inference_metrics().inference_active is False
