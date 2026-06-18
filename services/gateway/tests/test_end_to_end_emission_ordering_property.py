"""Property test for end-to-end backend emission ordering (task 7.6).

Feature: zocai-ecosystem-rebuild, Property 28: Emission order is preserved end
to end on the backend.

**Validates: Requirements 6.5, 9.4**

Design Property 28 (verbatim intent): *For any* sequence of events produced by
the FSM, the Gateway emits them in production order and the Diary_Worker appends
them to the Session_Diary in the same first-in-first-out order.

Strategy
--------
This drives the *real* backend ordering path with no mocks:

* the per-run emit gate → per-run FIFO SSE queue sink in ``app.py`` (the real
  :class:`~zocai_gateway.app._Run`, whose ``emit_gate`` forwards conforming
  events onto an unbounded ``asyncio.Queue`` in call order — R6.5), and
* the real Tier 1 :class:`~zocai_gateway.memory.diary_worker.DiaryWorker`, which
  the run's gate mirrors every conforming event to and which appends them to
  ``.zocai/session_diary.jsonl`` from a single consumer thread draining a FIFO
  queue (R9.4).

For a Hypothesis-generated sequence of conforming contract events we tag each
event with its production index (its ``seq``), push the whole sequence through
``run.emit_gate.emit`` in order, then read back:

1. the order the events reached the **SSE queue sink** (drained from the run's
   FIFO queue), and
2. the order the events were **appended to the Session_Diary** (parsed from the
   on-disk JSONL after the worker drains).

The property asserts both observed orders equal the production order the events
passed through ``EmitGate.emit`` — proving order is preserved end to end across
both the SSE bus (R6.5) and the diary (R9.4).
"""

from __future__ import annotations

import asyncio
import json
import tempfile
from collections.abc import Mapping
from pathlib import Path

from hypothesis import given, settings
from hypothesis import strategies as st

from shared_schema.agent_events import (
    ApprovalEvent,
    CommandEvent,
    DoneEvent,
    EditFileEvent,
    IntentEvent,
    ReadFileRef,
    ReadFilesEvent,
    SummaryEvent,
    ThinkingEvent,
)

from zocai_gateway.app import _Run
from zocai_gateway.memory.diary_worker import DiaryWorker
from zocai_gateway.mode_router import AgentPath

# ── Shared field strategies (no mocks: real contract models) ────────────────
_run_ids = st.text(min_size=1, max_size=12)
_ts = st.just("2024-01-01T00:00:00Z")
_text = st.text(max_size=80)
_paths = st.text(min_size=1, max_size=40)
_model_tiers = st.sampled_from(["local-slm", "edge", "cloud"])


def _read_file_refs() -> st.SearchStrategy[ReadFileRef]:
    return st.fixed_dictionaries({"path": _paths}).map(lambda d: ReadFileRef(**d))


# ── One strategy per contract row kind, each yielding a valid model ──────────
def _events() -> st.SearchStrategy[object]:
    seq = st.just(0)  # placeholder; the test re-stamps seq with the prod index
    intent = st.fixed_dictionaries(
        {
            "seq": seq,
            "run_id": _run_ids,
            "ts": _ts,
            "text": _text,
            "model_tier": _model_tiers,
            "context_window_tokens": st.integers(min_value=1, max_value=1_000_000),
        }
    ).map(lambda d: IntentEvent(**d))
    thinking = st.fixed_dictionaries(
        {"seq": seq, "run_id": _run_ids, "ts": _ts, "text": _text}
    ).map(lambda d: ThinkingEvent(**d))
    read_files = st.fixed_dictionaries(
        {
            "seq": seq,
            "run_id": _run_ids,
            "ts": _ts,
            "files": st.lists(_read_file_refs(), max_size=4),
        }
    ).map(lambda d: ReadFilesEvent(**d))
    edit_file = st.fixed_dictionaries(
        {"seq": seq, "run_id": _run_ids, "ts": _ts, "path": _paths, "diff": _text}
    ).map(lambda d: EditFileEvent(**d))
    command = st.fixed_dictionaries(
        {
            "seq": seq,
            "run_id": _run_ids,
            "ts": _ts,
            "command": st.text(min_size=1, max_size=60),
        }
    ).map(lambda d: CommandEvent(**d))
    summary = st.fixed_dictionaries(
        {"seq": seq, "run_id": _run_ids, "ts": _ts, "text": _text}
    ).map(lambda d: SummaryEvent(**d))
    approval = st.fixed_dictionaries(
        {
            "seq": seq,
            "run_id": _run_ids,
            "ts": _ts,
            "prompt": st.text(min_size=1, max_size=60),
        }
    ).map(lambda d: ApprovalEvent(**d))
    done = st.fixed_dictionaries(
        {"seq": seq, "run_id": _run_ids, "ts": _ts, "ok": st.booleans()}
    ).map(lambda d: DoneEvent(**d))
    return st.one_of(
        intent, thinking, read_files, edit_file, command, summary, approval, done
    )


def _drain_sse_queue(queue: "asyncio.Queue[dict | None]") -> list[Mapping[str, object]]:
    """Synchronously drain the run's FIFO SSE queue in order.

    ``put_nowait``/``get_nowait`` need no running loop, so we can read the
    enqueued wire events back in exactly the order the emit-gate sink wrote
    them — the SSE generator drains this same queue (R6.5).
    """
    drained: list[Mapping[str, object]] = []
    while True:
        try:
            item = queue.get_nowait()
        except asyncio.QueueEmpty:
            break
        if item is None:  # close sentinel (not expected here, but stop if seen)
            break
        drained.append(item)
    return drained


@settings(max_examples=150, deadline=None)
@given(events=st.lists(_events(), min_size=1, max_size=25))
def test_emission_order_preserved_end_to_end(events: list[object]) -> None:
    """Property 28: emission order is preserved end to end on the backend.

    Feature: zocai-ecosystem-rebuild, Property 28

    **Validates: Requirements 6.5, 9.4**
    """
    # Stamp each event with its production index as ``seq`` so the order events
    # pass through the gate is observable downstream regardless of row kind.
    stamped = [e.model_copy(update={"seq": i}) for i, e in enumerate(events)]  # type: ignore[attr-defined]
    production_order = [i for i, _ in enumerate(stamped)]

    with tempfile.TemporaryDirectory() as tmp:
        diary_path = Path(tmp) / "session_diary.jsonl"
        worker = DiaryWorker(diary_path)
        worker.start()
        try:
            # Real per-run emit gate → real FIFO SSE queue sink, mirroring to
            # the real Tier 1 Diary_Worker (app.py wiring, no mocks).
            run = _Run(run_id="r-prop28", path=AgentPath(), diary=worker)

            # Push the whole sequence through the gate in production order.
            for event in stamped:
                emitted = run.emit_gate.emit(event.model_dump(by_alias=True))  # type: ignore[attr-defined]
                assert emitted is True  # every generated event conforms

            # 1) Order events reached the SSE queue sink (R6.5).
            sse_events = _drain_sse_queue(run.queue)
            sse_order = [int(e["seq"]) for e in sse_events]

            # 2) Order events were appended to the Session_Diary (R9.4).
            worker.wait_until_idle(timeout=5.0)
            lines = diary_path.read_text(encoding="utf-8").splitlines()
            diary_order = [int(json.loads(line)["seq"]) for line in lines]
        finally:
            worker.stop()

    # Every event made it through both sinks exactly once...
    assert len(sse_order) == len(production_order)
    assert len(diary_order) == len(production_order)
    # ...the SSE bus carries them in FSM production order (R6.5)...
    assert sse_order == production_order
    # ...and the diary appends them in the same FIFO order (R9.4).
    assert diary_order == production_order
    # Transitively, the SSE order and diary order agree end to end.
    assert sse_order == diary_order
