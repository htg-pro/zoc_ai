"""Timing check for Ask Mode first-chunk latency (R2.2).

R2.2 requires that, while Ask Mode is active, the Gateway streams the response
as markdown text token chunks and emits **the first chunk within 5 seconds of
request acceptance**. This is a non-functional performance bound, so per the
design Testing Strategy ("Performance / Timing Checks") it is verified with a
targeted measurement rather than a property.

We drive the real Ask path end to end through :class:`RunPipeline` (the
``mode = "ask"`` branch routes to :class:`AskPath` and streams onto the
text-only Ask channel, R6.6). "Request acceptance" is the moment the pipeline
begins running the accepted request; we start a monotonic clock there and stop
it the instant the first chunk reaches the text sink.

The model ``generate`` step is injected behind :class:`AgentBrain`, so we use a
fast deterministic stub: the measured latency reflects *gateway overhead*
(routing, steering compilation, RAG extraction, channel emission), not model
inference time. Gateway overhead is in-process work with no real model I/O, so
it finishes far under the 5 s ceiling; we assert against a conservative
fraction of the budget so a loaded CI host still passes while a genuine
regression toward 5 s is caught.

Validates: Requirements 2.2
"""

from __future__ import annotations

import time
from pathlib import Path

from zocai_gateway.emit_gate import EmitGate
from zocai_gateway.mode_router import AgentRunRequest, AskContext, Mode
from zocai_gateway.run_pipeline import DefaultAgentBrain, RunPipeline

# R2.2's hard ceiling, in seconds.
_BUDGET_S = 5.0
# Conservative pass threshold: with a fast deterministic generate stub the
# first chunk is produced by pure in-process gateway work and should land
# orders of magnitude under the ceiling. Asserting at a small fraction of the
# budget leaves generous headroom for a loaded CI host while still flagging a
# regression that creeps toward 5 s.
_THRESHOLD_S = _BUDGET_S / 10.0  # 500 ms


class _FastAskBrain(DefaultAgentBrain):
    """A brain whose ``generate`` returns immediately with a fixed answer.

    Using a fast deterministic stub isolates the measurement to gateway
    overhead (routing + steering + RAG + channel emission) rather than model
    inference latency, which is what R2.2's 5 s acceptance-to-first-chunk bound
    governs.
    """

    def ask_response(self, prompt: str, context: AskContext) -> str:
        return "ready"


def _first_chunk_latency(workspace_root: Path, prompt: str) -> tuple[float, str]:
    """Drive the Ask path and return (seconds-to-first-chunk, first-chunk-text).

    Records the first chunk's arrival time at the text sink and stops feeding
    further chunks into the measurement. The clock starts at request
    acceptance — the call to :meth:`RunPipeline.run` — so the elapsed time is
    exactly acceptance-to-first-chunk.
    """
    first_chunk: dict[str, object] = {}

    def text_sink(chunk: str) -> None:
        if "at" not in first_chunk:
            first_chunk["at"] = time.perf_counter()
            first_chunk["text"] = chunk

    gate = EmitGate(sink=lambda e: None)
    pipeline = RunPipeline(
        AgentRunRequest(prompt=prompt, mode=Mode.ASK),
        "run-ask-timing",
        gate=gate,
        text_sink=text_sink,
        close=lambda: None,
        workspace_root=workspace_root,
        brain=_FastAskBrain(),
    )

    start = time.perf_counter()
    pipeline.run()
    assert "at" in first_chunk, "Ask path emitted no text chunk"
    elapsed = float(first_chunk["at"]) - start  # type: ignore[arg-type]
    return elapsed, str(first_chunk["text"])


def test_ask_first_chunk_within_budget(tmp_path: Path) -> None:
    """The first Ask text chunk is emitted within the R2.2 5 s budget.

    Measures acceptance-to-first-chunk for a plain question with a fast
    deterministic generate stub and asserts it lands under a conservative
    fraction of the 5 s ceiling.

    Validates: Requirements 2.2
    """
    elapsed, text = _first_chunk_latency(tmp_path, "what is this codebase?")

    assert text == "ready"
    assert elapsed < _BUDGET_S, (
        f"Ask first chunk took {elapsed * 1000:.3f} ms, exceeding the "
        f"{_BUDGET_S:.0f} s acceptance-to-first-chunk budget (R2.2)"
    )
    assert elapsed < _THRESHOLD_S, (
        f"Ask first chunk took {elapsed * 1000:.3f} ms, exceeding the "
        f"{_THRESHOLD_S * 1000:.0f} ms timing-check threshold"
    )


def test_ask_first_chunk_within_budget_across_prompts(tmp_path: Path) -> None:
    """First-chunk latency stays within budget across representative prompts.

    Exercises the worst single acceptance-to-first-chunk latency over a spread
    of prompts (a plain question and edit/implementation phrasings that route
    to the switch-to-Agent message, R2.4) so no Ask outcome can mask a
    regression. Each prompt runs in its own workspace to keep steering/RAG
    setup independent.

    Validates: Requirements 2.2
    """
    prompts = [
        "what is this codebase?",
        "explain the architecture",
        "how do I implement a cache?",
        "implement the cache layer",
        "summarize the design doc",
    ]

    worst = 0.0
    for index, prompt in enumerate(prompts):
        workspace = tmp_path / f"ws{index}"
        workspace.mkdir()
        elapsed, _text = _first_chunk_latency(workspace, prompt)
        worst = max(worst, elapsed)
        assert elapsed < _BUDGET_S, (
            f"Ask first chunk for {prompt!r} took {elapsed * 1000:.3f} ms, "
            f"exceeding the {_BUDGET_S:.0f} s budget (R2.2)"
        )

    assert worst < _THRESHOLD_S, (
        f"worst Ask first-chunk latency was {worst * 1000:.3f} ms, exceeding "
        f"the {_THRESHOLD_S * 1000:.0f} ms timing-check threshold"
    )
