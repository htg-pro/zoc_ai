"""Orchestrator run-state reconstruction from the Session_Diary (task 9.5, R10.3).

When an online model API connection drops mid-run, the in-process run state is
lost but the Tier 1 Session_Diary (``.zocai/session_diary.jsonl``) still holds
the ordered event log. This module reconstructs the **active run state** from
the *trailing* entries of that diary so the Orchestrator can resume rather than
restart (R10.3).

Two invariants drive the design:

* **Ordered, faithful replay (R10.3, design "Orchestrator reconstruction").**
  Reconstruction reads the persisted entries for the active run *in their
  original FIFO order* (the ``seq`` the Diary_Worker assigned) and reproduces
  them exactly — no reordering, no dropping of well-formed entries. This is the
  backend half of design Property 41.
* **Crash tolerance.** A connection drop (or a crash mid-append) can leave a
  torn final line in the JSONL log. :func:`read_diary_entries` skips blank and
  un-parseable lines so a partial trailing write never aborts reconstruction;
  every *complete* entry is preserved.

The reconstructed state is expressed as the model-agnostic Tier 2
:class:`~zocai_gateway.memory.state_wrapper.StateWrapper` (FSM stage, active
file markers, patch diffs, compilation logs), which is exactly what the
hot-swap / resume path (task 11.1) already consumes — so a connection-drop
recovery and a hot-swap resume rebuild the prompt window the same way.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from zocai_gateway.memory.diary_worker import DiaryEntry
from zocai_gateway.memory.state_wrapper import Diff, FailureRecord, StateWrapper
from zocai_gateway.stages import Stage

__all__ = [
    "ReconstructedRun",
    "active_run_id",
    "read_diary_entries",
    "reconstruct_run_state",
    "trailing_entries",
]


# Event ``type`` → the FSM stage its emission implies. ``thinking`` and
# ``command`` are handled specially (their stage is carried in the payload), so
# they are intentionally absent here.
_STAGE_BY_TYPE: dict[str, Stage] = {
    "intent": Stage.INTAKE,
    "read-files": Stage.READ_FILES,
    "edit-file": Stage.APPLY_EDITS,
    "summary": Stage.SUMMARY,
    "done": Stage.DONE,
}

# A synthetic stage event the default FSM factory encodes as a command of the
# form ``<stage:NAME>`` (e.g. ERROR_CLOSED). Recognised so the recorded stage is
# recovered exactly rather than mistaken for a real RUN_CHECKS command.
_STAGE_COMMAND_PREFIX = "<stage:"
_STAGE_COMMAND_SUFFIX = ">"


@dataclass(frozen=True, slots=True)
class ReconstructedRun:
    """The active run rebuilt from the trailing Session_Diary entries (R10.3).

    Attributes:
        run_id: The identifier of the active (most recently appended) run.
        entries: The active run's diary entries in their original FIFO order —
            the faithful, ordered replay backing design Property 41.
        state: The model-agnostic resumable run state derived from ``entries``
            (current FSM stage, active file markers, patch diffs, compilation
            logs), ready to hand to the hot-swap / resume path (task 11.1).
    """

    run_id: str
    entries: list[DiaryEntry]
    state: StateWrapper


def read_diary_entries(diary_path: Path | str) -> list[DiaryEntry]:
    """Read every well-formed Session_Diary entry in on-disk (FIFO) order.

    Blank lines and lines that are not valid entry JSON are skipped, so a torn
    trailing line left by a connection drop or crash mid-append does not abort
    reconstruction (the rest of the log is still replayed). A missing file
    yields an empty list — there is simply nothing to reconstruct yet.
    """
    path = Path(diary_path)
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return []

    entries: list[DiaryEntry] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        entry = _parse_line(line)
        if entry is not None:
            entries.append(entry)
    return entries


def _parse_line(line: str) -> DiaryEntry | None:
    """Parse one JSONL line into a :class:`DiaryEntry`, or ``None`` if malformed."""
    try:
        record = json.loads(line)
    except json.JSONDecodeError:
        return None
    if not isinstance(record, dict):
        return None
    seq = record.get("seq")
    payload = record.get("payload")
    if not isinstance(seq, int) or isinstance(seq, bool):
        return None
    if not isinstance(payload, dict):
        return None
    run_id = record.get("runId")
    event_type = record.get("type")
    ts = record.get("ts")
    return DiaryEntry(
        seq=seq,
        run_id=str(run_id) if isinstance(run_id, str) else "",
        type=str(event_type) if isinstance(event_type, str) else "message",
        ts=str(ts) if isinstance(ts, str) else "",
        payload=cast("dict[str, object]", payload),
    )


def active_run_id(entries: list[DiaryEntry]) -> str | None:
    """The active run's id: the ``run_id`` of the last (most recent) entry.

    Returns ``None`` for an empty diary. "Active" is the run whose entries
    trail the log, which is what R10.3 reconstructs after a connection drop.
    """
    if not entries:
        return None
    return entries[-1].run_id


def trailing_entries(entries: list[DiaryEntry], run_id: str | None = None) -> list[DiaryEntry]:
    """The trailing entries belonging to the active run, in original order.

    When ``run_id`` is omitted the active run is taken to be the run of the
    last appended entry (:func:`active_run_id`). The returned entries keep the
    exact FIFO order they were appended in (sorted by ``seq`` as a tiebreaker
    for robustness), reproducing the persisted order required by R10.3.
    """
    target = run_id if run_id is not None else active_run_id(entries)
    if target is None:
        return []
    selected = [e for e in entries if e.run_id == target]
    # Entries are read in on-disk (append) order already; ``seq`` is the FIFO
    # emission index, so sorting by it is a stable no-op on a healthy log and a
    # repair on a reordered one — either way the result is the persisted order.
    selected.sort(key=lambda e: e.seq)
    return selected


def reconstruct_run_state(
    diary_path: Path | str, run_id: str | None = None
) -> ReconstructedRun | None:
    """Reconstruct the active run state from the trailing diary entries (R10.3).

    Reads the Session_Diary at ``diary_path``, selects the trailing entries of
    the active run (``run_id`` if given, else the most recent run), replays
    them in order, and derives the resumable :class:`StateWrapper`. Returns
    ``None`` when the diary holds no entries for the active run (nothing to
    resume).
    """
    entries = read_diary_entries(diary_path)
    target = run_id if run_id is not None else active_run_id(entries)
    if target is None:
        return None
    run_entries = trailing_entries(entries, target)
    if not run_entries:
        return None
    state = _derive_state(run_entries)
    return ReconstructedRun(run_id=target, entries=run_entries, state=state)


def _derive_state(run_entries: list[DiaryEntry]) -> StateWrapper:
    """Fold the ordered run entries into a resumable :class:`StateWrapper`.

    Replays events in order: the current FSM ``stage`` is the stage implied by
    the last stage-bearing event; ``active_file_markers`` accumulates the
    distinct paths touched by read/edit events (in first-seen order); each
    ``edit-file`` contributes a patch :class:`Diff`; each ``command`` carrying
    an exit code contributes a captured :class:`FailureRecord`.
    """
    stage = Stage.INTAKE
    markers: list[str] = []
    seen_markers: set[str] = set()
    diffs: list[Diff] = []
    logs: list[FailureRecord] = []

    def remember(path: str) -> None:
        if path and path not in seen_markers:
            seen_markers.add(path)
            markers.append(path)

    for entry in run_entries:
        inferred = _stage_from_entry(entry)
        if inferred is not None:
            stage = inferred

        payload = entry.payload
        if entry.type == "read-files":
            files = payload.get("files")
            if isinstance(files, list):
                for ref in files:
                    if isinstance(ref, dict):
                        path = ref.get("path")
                        if isinstance(path, str):
                            remember(path)
        elif entry.type == "edit-file":
            path = payload.get("path")
            diff = payload.get("diff")
            if isinstance(path, str):
                remember(path)
                diffs.append(Diff(path=path, diff=diff if isinstance(diff, str) else ""))
        elif entry.type == "command":
            record = _failure_from_command(payload)
            if record is not None:
                logs.append(record)

    return StateWrapper(
        stage=stage,
        active_file_markers=markers,
        patch_diffs=diffs,
        compilation_logs=logs,
    )


def _stage_from_entry(entry: DiaryEntry) -> Stage | None:
    """The FSM stage implied by a single diary entry, or ``None`` if it implies none.

    ``thinking`` events carry the entered stage as their ``text`` (the default
    FSM factory emits ``text == stage.value``); a synthetic ``<stage:NAME>``
    command carries it in ``command``; every other recognised event maps via
    :data:`_STAGE_BY_TYPE`. A plain ``command`` (a real check invocation) maps
    to ``RUN_CHECKS``.
    """
    payload = entry.payload
    if entry.type == "thinking":
        text = payload.get("text")
        if isinstance(text, str):
            return _stage_or_none(text)
        return None
    if entry.type == "command":
        command = payload.get("command")
        if (
            isinstance(command, str)
            and command.startswith(_STAGE_COMMAND_PREFIX)
            and command.endswith(_STAGE_COMMAND_SUFFIX)
        ):
            name = command[len(_STAGE_COMMAND_PREFIX) : -len(_STAGE_COMMAND_SUFFIX)]
            return _stage_or_none(name) or Stage.RUN_CHECKS
        return Stage.RUN_CHECKS
    return _STAGE_BY_TYPE.get(entry.type)


def _stage_or_none(value: str) -> Stage | None:
    """Coerce a string to a :class:`Stage`, or ``None`` if it names no stage."""
    try:
        return Stage(value)
    except ValueError:
        return None


def _failure_from_command(payload: Mapping[str, object]) -> FailureRecord | None:
    """Build a :class:`FailureRecord` from a ``command`` event payload, if it has an exit code.

    Synthetic ``<stage:...>`` markers carry no ``exit_code``/``exitCode`` and so
    yield ``None`` (they are stage signals, not check results). A real check
    invocation carries its command, exit code, and an optional ``error_tag``
    used as the captured log text.
    """
    exit_code = payload.get("exit_code", payload.get("exitCode"))
    if not isinstance(exit_code, int) or isinstance(exit_code, bool):
        return None
    command = payload.get("command")
    error_tag = payload.get("error_tag", payload.get("errorTag"))
    return FailureRecord(
        command=command if isinstance(command, str) else "",
        exit_code=exit_code,
        log=error_tag if isinstance(error_tag, str) else "",
    )
