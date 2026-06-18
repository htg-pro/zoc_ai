"""Tier 2 — Cross-Model Bus / ``State_Wrapper`` store (task 9.3, R9.5 + R9.6).

The State_Wrapper is the Tier 2 store of the memory matrix. On a model
hot-swap the Orchestrator serializes the *run-resumable* slice of state —- the
current FSM stage, the active file markers, the patch diff arrays, and the
captured compilation logs -— into ``.zocai/cross_model_bus/state_wrapper.json``
(R9.5). The replacement model later reads it back to rebuild its prompt window
and resume from the recorded stage (tasks 11.1, R11.3-R11.5).

Two invariants drive the schema:

* **Round-trip (R9.5).** ``deserialize(serialize(state)) == state`` for every
  representable run state: the stage, file markers, patch diffs, and
  compilation logs are preserved exactly. Compilation-log text is capped to
  :data:`LOG_MAX_CHARS` *at construction* (design "Run State", ``log`` truncated
  to 65_536 chars), so the in-memory value already equals what is written and
  the round-trip stays faithful even for very long logs.
* **Model-agnostic (R9.6).** The on-disk schema carries **no tier-specific
  field** — nothing names a Model_Tier, a context-window size, a model id, or
  any other model-bound attribute. Only :data:`SCHEMA_KEYS` may appear, which
  is exactly what lets any tier deserialize state another tier wrote.

This module owns the schema and the (de)serialization; the hot-swap freeze /
resume sequence that *uses* it lives in task 11.1.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from zocai_gateway.stages import Stage

__all__ = [
    "LOG_MAX_CHARS",
    "SCHEMA_KEYS",
    "SCHEMA_VERSION",
    "Diff",
    "FailureRecord",
    "StateWrapper",
    "StateWrapperError",
    "StateWrapperStore",
]

#: The version stamped into every wrapper written by this module. Bumped only
#: on an incompatible schema change so a reader can refuse unknown layouts.
SCHEMA_VERSION = 1

#: Compilation-log text is truncated to this many characters (design "Run
#: State": ``log`` truncated to 65_536 chars). Enforced at construction so the
#: stored value equals the in-memory value and the round-trip is exact.
LOG_MAX_CHARS = 65_536

#: The complete, fixed set of top-level keys the wrapper schema may contain.
#: None of these names a Model_Tier or any other model-bound attribute, which
#: is the R9.6 model-agnostic invariant. Tests assert membership against this
#: set so a tier-specific field can never be added unnoticed.
SCHEMA_KEYS: frozenset[str] = frozenset(
    {
        "schema_version",
        "stage",
        "active_file_markers",
        "patch_diffs",
        "compilation_logs",
    }
)


class StateWrapperError(ValueError):
    """Raised when a payload is not a valid State_Wrapper document.

    Covers malformed JSON shapes, an unknown :data:`SCHEMA_VERSION`, an
    unrecognized :class:`~zocai_gateway.stages.Stage` value, and — crucially —
    any top-level key outside :data:`SCHEMA_KEYS`, so a tier-specific field
    leaking into the schema is rejected rather than silently tolerated (R9.6).
    """


# ── Schema value types ──────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Diff:
    """A single patch diff: the edited ``path`` and its unified ``diff`` text.

    Mirrors the ``edit-file`` event payload (``path`` + ``diff``) so a patch
    diff recorded during ``APPLY_EDITS`` survives a hot-swap unchanged.
    """

    path: str
    diff: str

    def to_dict(self) -> dict[str, str]:
        return {"path": self.path, "diff": self.diff}

    @classmethod
    def from_dict(cls, data: object) -> Diff:
        if not isinstance(data, dict):
            raise StateWrapperError(f"patch diff must be an object, got {type(data).__name__}")
        try:
            path = data["path"]
            diff = data["diff"]
        except KeyError as exc:
            raise StateWrapperError(f"patch diff missing key {exc}") from exc
        if not isinstance(path, str) or not isinstance(diff, str):
            raise StateWrapperError("patch diff 'path' and 'diff' must be strings")
        if data.keys() - {"path", "diff"}:
            extra = ", ".join(sorted(data.keys() - {"path", "diff"}))
            raise StateWrapperError(f"unexpected patch diff field(s): {extra}")
        return cls(path=path, diff=diff)


@dataclass(frozen=True, slots=True)
class FailureRecord:
    """A captured compilation/check failure (design "Run State", R5.3).

    ``log`` is truncated to :data:`LOG_MAX_CHARS` at construction so the value
    held in memory already equals what is persisted; this keeps the round-trip
    exact regardless of the original log size.
    """

    command: str
    exit_code: int
    log: str

    def __post_init__(self) -> None:
        if len(self.log) > LOG_MAX_CHARS:
            # Frozen dataclass: ``object.__setattr__`` is the supported way to
            # normalize a field during construction.
            object.__setattr__(self, "log", self.log[:LOG_MAX_CHARS])

    def to_dict(self) -> dict[str, Any]:
        return {"command": self.command, "exit_code": self.exit_code, "log": self.log}

    @classmethod
    def from_dict(cls, data: object) -> FailureRecord:
        if not isinstance(data, dict):
            raise StateWrapperError(
                f"compilation log must be an object, got {type(data).__name__}"
            )
        try:
            command = data["command"]
            exit_code = data["exit_code"]
            log = data["log"]
        except KeyError as exc:
            raise StateWrapperError(f"compilation log missing key {exc}") from exc
        if data.keys() - {"command", "exit_code", "log"}:
            extra = ", ".join(sorted(data.keys() - {"command", "exit_code", "log"}))
            raise StateWrapperError(f"unexpected compilation log field(s): {extra}")
        if not isinstance(command, str) or not isinstance(log, str):
            raise StateWrapperError("compilation log 'command' and 'log' must be strings")
        # ``bool`` is a subclass of ``int``; reject it so exit codes stay numeric.
        if not isinstance(exit_code, int) or isinstance(exit_code, bool):
            raise StateWrapperError("compilation log 'exit_code' must be an integer")
        return cls(command=command, exit_code=exit_code, log=log)


# ── The wrapper ───────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class StateWrapper:
    """The model-agnostic Tier 2 state payload (R9.5, R9.6).

    Holds exactly the run state needed to resume after a hot-swap: the FSM
    ``stage``, the ``active_file_markers``, the ``patch_diffs``, and the
    captured ``compilation_logs``. ``schema_version`` is the only metadata; no
    field names a Model_Tier, so any tier can read state any other tier wrote.
    """

    stage: Stage
    active_file_markers: list[str] = field(default_factory=list)
    patch_diffs: list[Diff] = field(default_factory=list)
    compilation_logs: list[FailureRecord] = field(default_factory=list)
    schema_version: int = SCHEMA_VERSION

    # -- serialization -----------------------------------------------------

    def to_dict(self) -> dict[str, Any]:
        """Render to a plain JSON-ready dict using only :data:`SCHEMA_KEYS`."""
        return {
            "schema_version": self.schema_version,
            "stage": self.stage.value,
            "active_file_markers": list(self.active_file_markers),
            "patch_diffs": [d.to_dict() for d in self.patch_diffs],
            "compilation_logs": [r.to_dict() for r in self.compilation_logs],
        }

    def to_json(self) -> str:
        """Serialize to a JSON document (R9.5).

        Keys are emitted in a stable order so two equal wrappers serialize to
        byte-identical text, which makes diffs and equality checks predictable.
        """
        return json.dumps(self.to_dict(), ensure_ascii=False, indent=2, sort_keys=True) + "\n"

    @classmethod
    def from_dict(cls, data: object) -> StateWrapper:
        """Reconstruct from a plain dict, rejecting any non-schema shape (R9.6)."""
        if not isinstance(data, dict):
            raise StateWrapperError(
                f"state wrapper must be a JSON object, got {type(data).__name__}"
            )
        unexpected = data.keys() - SCHEMA_KEYS
        if unexpected:
            # A tier-specific (or otherwise unknown) field breaks the
            # model-agnostic invariant — refuse it loudly (R9.6).
            raise StateWrapperError(
                f"unexpected state wrapper field(s): {', '.join(sorted(unexpected))}"
            )

        schema_version = data.get("schema_version", SCHEMA_VERSION)
        if schema_version != SCHEMA_VERSION:
            raise StateWrapperError(
                f"unsupported state wrapper schema_version {schema_version!r}; "
                f"expected {SCHEMA_VERSION}"
            )

        try:
            stage = Stage(data["stage"])
        except KeyError as exc:
            raise StateWrapperError("state wrapper missing 'stage'") from exc
        except ValueError as exc:
            raise StateWrapperError(f"unknown FSM stage {data['stage']!r}") from exc

        markers = data.get("active_file_markers", [])
        if not isinstance(markers, list) or not all(isinstance(m, str) for m in markers):
            raise StateWrapperError("'active_file_markers' must be a list of strings")

        raw_diffs = data.get("patch_diffs", [])
        if not isinstance(raw_diffs, list):
            raise StateWrapperError("'patch_diffs' must be a list")

        raw_logs = data.get("compilation_logs", [])
        if not isinstance(raw_logs, list):
            raise StateWrapperError("'compilation_logs' must be a list")

        return cls(
            stage=stage,
            active_file_markers=list(markers),
            patch_diffs=[Diff.from_dict(d) for d in raw_diffs],
            compilation_logs=[FailureRecord.from_dict(r) for r in raw_logs],
            schema_version=SCHEMA_VERSION,
        )

    @classmethod
    def from_json(cls, text: str) -> StateWrapper:
        """Parse a JSON document into a wrapper (R9.5)."""
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise StateWrapperError(f"state wrapper is not valid JSON: {exc}") from exc
        return cls.from_dict(data)


# ── The on-disk store ─────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class StateWrapperStore:
    """Reads/writes a :class:`StateWrapper` at ``.zocai/cross_model_bus/state_wrapper.json``.

    Bind the store to the matrix's ``state_wrapper_path`` (see
    :class:`~zocai_gateway.memory.matrix.MemoryMatrix`). :meth:`save` is atomic
    — it writes a sibling temp file and ``os.replace``s it into place — so a
    crash mid-write never leaves a torn document for the replacement model to
    read on resume (R11.3).
    """

    path: Path

    def __init__(self, path: Path | str) -> None:
        object.__setattr__(self, "path", Path(path))

    def save(self, wrapper: StateWrapper) -> None:
        """Serialize ``wrapper`` to :attr:`path` atomically (R9.5)."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".tmp")
        with tmp.open("w", encoding="utf-8") as handle:
            handle.write(wrapper.to_json())
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, self.path)

    def load(self) -> StateWrapper:
        """Deserialize the wrapper persisted at :attr:`path` (R9.5).

        Raises:
            StateWrapperError: If the file is missing, not valid JSON, or does
                not conform to the model-agnostic schema (R9.6).
        """
        try:
            text = self.path.read_text(encoding="utf-8")
        except FileNotFoundError as exc:
            raise StateWrapperError(f"no state wrapper at {self.path}") from exc
        return StateWrapper.from_json(text)

    def exists(self) -> bool:
        """Whether a wrapper file is present at :attr:`path`."""
        return self.path.is_file()
