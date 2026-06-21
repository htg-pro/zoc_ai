from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from shared_schema.models import RunModelBenchmarkRequest
from zocai_gateway.app import create_app
from zocai_gateway.benchmark import BenchmarkStore, ModelBenchmarker
from zocai_gateway.model_runtime import StreamMetrics, _stream_metrics


class StepClock:
    def __init__(self) -> None:
        self.value = 0.0

    def __call__(self) -> float:
        self.value += 0.1
        return self.value


def make_benchmarker(path) -> ModelBenchmarker:
    def stream_generate(_request, *, on_token, on_metrics, **_kwargs):
        on_token("answer")
        on_metrics(StreamMetrics(completion_tokens=24, tokens_per_second=48.5))
        return "A correct, concise benchmark answer."

    def quality_generate(_request, **_kwargs):
        return '```json\n{"score": 84}\n```'

    return ModelBenchmarker(
        BenchmarkStore(path),
        stream_generate=stream_generate,
        quality_generate=quality_generate,
        clock=StepClock(),
        now=lambda: datetime(2026, 6, 21, tzinfo=timezone.utc),
    )


def test_benchmark_runs_five_prompts_and_persists_provider_metrics(tmp_path) -> None:
    history_path = tmp_path / "benchmarks.json"
    benchmarker = make_benchmarker(history_path)

    result = benchmarker.run(
        RunModelBenchmarkRequest(
            modelId="local-model",
            modelName="Local Model",
            baseUrl="http://127.0.0.1:8080",
        )
    )

    assert len(result.prompts) == 5
    assert result.average_tokens_per_second == 48.5
    assert result.average_quality_score == 84
    assert all(item.output_tokens == 24 for item in result.prompts)
    assert all(item.error is None for item in result.prompts)

    stored = json.loads(history_path.read_text(encoding="utf-8"))
    assert stored["models"]["local-model"][0]["id"] == result.id
    assert benchmarker.store.history("local-model").runs[0].id == result.id
    assert benchmarker.store.history("other-model").runs == []


def test_benchmark_rejects_non_loopback_model_server(tmp_path) -> None:
    benchmarker = make_benchmarker(tmp_path / "benchmarks.json")

    with pytest.raises(ValueError, match="loopback"):
        benchmarker.run(
            RunModelBenchmarkRequest(
                modelId="remote",
                modelName="Remote",
                baseUrl="https://example.com/v1",
            )
        )


def test_llama_stream_metrics_prefer_provider_timings() -> None:
    metrics = _stream_metrics(
        {
            "usage": {"completion_tokens": 31},
            "timings": {"predicted_n": 30, "predicted_per_second": 17.25},
        }
    )

    assert metrics == StreamMetrics(completion_tokens=31, tokens_per_second=17.25)


def test_benchmark_endpoints_use_camel_case_contract(tmp_path) -> None:
    benchmarker = make_benchmarker(tmp_path / "benchmarks.json")
    client = TestClient(create_app(benchmarker=benchmarker, drive=False))

    response = client.post(
        "/v1/model-benchmarks",
        json={
            "modelId": "local-model",
            "modelName": "Local Model",
            "baseUrl": "http://localhost:8080",
        },
    )

    assert response.status_code == 200
    assert response.json()["modelId"] == "local-model"
    assert response.json()["prompts"][0]["timeToFirstTokenMs"] == 100

    history = client.get("/v1/model-benchmarks", params={"modelId": "local-model"})
    assert history.status_code == 200
    assert history.json()["runs"][0]["id"] == response.json()["id"]
