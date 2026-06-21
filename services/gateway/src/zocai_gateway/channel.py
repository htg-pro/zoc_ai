"""Mode-scoped channel discipline over the SSE bus (R6.6, R6.7, R2.7).

The SSE bus carries different payload kinds depending on the active mode, and
the two disciplines are strict mirror images (design.md "Mode-Scoped Channel
Discipline"):

- **Agent Mode (R6.7):** the Gateway emits **only** structured Event_Contract
  events and **never** raw text token chunks. Every byte on the stream is a
  contract-validated row payload, so structured planning, to-do, and
  tool-activity rows flow freely and are *never* suppressed.
- **Ask Mode (R6.6):** the Gateway emits **only** raw markdown text token
  chunks and **never** structured row events. Every structured row — including
  the planning, to-do, and tool-activity rows named by R2.7 — is suppressed.

This module wraps the existing :class:`~zocai_gateway.emit_gate.EmitGate`
(structured channel) and a plain text sink (Ask channel) behind a single
:class:`ModeChannel` interface, so the producer talks to one object and the
mode alone decides which of ``emit_event`` / ``emit_text`` is honored.

**Suppression is a pure function of the active mode (R2.7).** It is active *if
and only if* Ask Mode is active: :func:`suppresses_structured_rows` is the
stateless predicate, and the two channel classes encode the same fact
structurally — there is no mutable, sticky suppression flag that could outlive
an Ask session and carry over into a later Agent run. Each run builds a fresh
channel from its mode (see :func:`channel_for`), so a previous Ask run can never
leave suppression "on" for a subsequent Agent run, and vice versa.

Spec: .kiro/specs/zocai-ecosystem-rebuild/design.md
      — "Mode-Scoped Channel Discipline (R6.6, R6.7, R2.7)"
Requirements: 6.6, 6.7, 2.7.
"""

from __future__ import annotations

import abc
from collections.abc import Callable, Mapping
from typing import Protocol

from zocai_gateway.emit_gate import EmitGate
from zocai_gateway.mode_router import ExecutionPath, Mode

__all__ = [
    "PLANNING_ROW_TYPES",
    "TODO_ROW_TYPES",
    "TOOL_ACTIVITY_ROW_TYPES",
    "SUPPRESSED_IN_ASK_ROW_TYPES",
    "TextSink",
    "ModeChannel",
    "AgentChannel",
    "AskChannel",
    "channel_for",
    "suppresses_structured_rows",
]

#: Structured planning rows — the "what I intend to do / am reasoning about"
#: kinds named by R2.7.
PLANNING_ROW_TYPES: frozenset[str] = frozenset(
    {"intent", "thinking", "plan", "plan-update"}
)

#: To-do / progress-checklist rows named by R2.7.
TODO_ROW_TYPES: frozenset[str] = frozenset({"plan", "plan-update", "summary"})

#: Tool-activity rows — file reads, file edits, and shell commands (R2.7).
TOOL_ACTIVITY_ROW_TYPES: frozenset[str] = frozenset(
    {"read-files", "edit-file", "command", "review"}
)

#: The union of the three R2.7 categories suppressed while Ask Mode is active.
#: Ask Mode additionally restricts the bus to text only (R6.6), so *all*
#: structured rows are withheld, but these are the kinds R2.7 names explicitly.
SUPPRESSED_IN_ASK_ROW_TYPES: frozenset[str] = (
    PLANNING_ROW_TYPES | TODO_ROW_TYPES | TOOL_ACTIVITY_ROW_TYPES
)


def suppresses_structured_rows(mode: Mode) -> bool:
    """Whether structured-row suppression is active for ``mode`` (R2.7).

    Suppression of the planning, to-do, and tool-activity rows is active **if
    and only if** Ask Mode is active. This is a stateless predicate of the
    current mode alone: there is no carried-over or sticky flag, so the same
    mode always yields the same answer regardless of any earlier run.
    """
    return mode is Mode.ASK


class TextSink(Protocol):
    """The sink the Ask channel writes raw markdown text token chunks to.

    Only a call taking the chunk is needed; wiring it onto the run's SSE queue
    (as ``text``/token frames) lives in :mod:`zocai_gateway.app`.
    """

    def __call__(self, chunk: str) -> None: ...


class ModeChannel(abc.ABC):
    """A mode-scoped view of the SSE bus enforcing channel discipline (R6.6/6.7).

    The producer always calls both :meth:`emit_event` (structured row) and
    :meth:`emit_text` (raw text chunk); the concrete channel honors exactly one
    family and rejects the other, so the partition is enforced in one place
    rather than scattered across producers.
    """

    mode: Mode

    @abc.abstractmethod
    def emit_event(self, payload: Mapping[str, object]) -> bool:
        """Emit a structured Event_Contract row.

        Returns ``True`` when the row was admitted onto the bus, ``False`` when
        it was withheld (suppressed in Ask Mode, or rejected by the contract
        gate in Agent Mode).
        """
        raise NotImplementedError

    @abc.abstractmethod
    def emit_text(self, chunk: str) -> bool:
        """Emit a raw markdown text token chunk.

        Returns ``True`` when the chunk was admitted onto the bus, ``False``
        when it was withheld (Agent Mode never emits raw text, R6.7).
        """
        raise NotImplementedError

    @property
    @abc.abstractmethod
    def suppresses_structured_rows(self) -> bool:
        """Whether this channel suppresses structured rows (R2.7)."""
        raise NotImplementedError


class AgentChannel(ModeChannel):
    """Structured-only channel for Agent Mode (R6.7).

    Wraps the run's :class:`EmitGate`: structured rows are forwarded through the
    contract gate (validation, ordering, diary mirror), while raw text token
    chunks are **never** emitted. Structured planning, to-do, and tool-activity
    rows are *not* suppressed here — suppression is an Ask-only discipline
    (R2.7).
    """

    mode = Mode.AGENT

    __slots__ = ("_gate",)

    def __init__(self, gate: EmitGate) -> None:
        self._gate = gate

    @property
    def gate(self) -> EmitGate:
        """The underlying contract emit gate this channel forwards rows to."""
        return self._gate

    def emit_event(self, payload: Mapping[str, object]) -> bool:
        """Forward a structured row through the contract gate (R6.7)."""
        return self._gate.emit(payload)

    def emit_text(self, chunk: str) -> bool:
        """Reject raw text: Agent Mode emits only structured rows (R6.7)."""
        return False

    @property
    def suppresses_structured_rows(self) -> bool:
        """Agent Mode never suppresses structured rows (R2.7)."""
        return False


class AskChannel(ModeChannel):
    """Text-only channel for Ask Mode (R6.6, R2.7).

    Restricts the bus to raw markdown text token chunks: every structured row
    is suppressed (and recorded for observability), and raw chunks are written
    to the injected :class:`TextSink`. Because suppression is fixed by the
    channel type, it is active for exactly this Ask run and cannot carry over to
    a later run (R2.7).
    """

    mode = Mode.ASK

    __slots__ = ("_text_sink", "_suppressed")

    def __init__(self, text_sink: TextSink) -> None:
        self._text_sink = text_sink
        self._suppressed: list[str | None] = []

    @property
    def suppressed(self) -> tuple[str | None, ...]:
        """The ``type`` of each structured row suppressed so far, in order.

        ``None`` records a suppressed payload that carried no string ``type``.
        Useful for asserting that planning/to-do/tool-activity rows were indeed
        withheld while Ask Mode was active.
        """
        return tuple(self._suppressed)

    def emit_event(self, payload: Mapping[str, object]) -> bool:
        """Suppress a structured row: Ask Mode is text-only (R6.6, R2.7)."""
        raw_type = payload.get("type")
        self._suppressed.append(raw_type if isinstance(raw_type, str) else None)
        return False

    def emit_text(self, chunk: str) -> bool:
        """Emit a raw markdown text token chunk onto the bus (R6.6)."""
        self._text_sink(chunk)
        return True

    @property
    def suppresses_structured_rows(self) -> bool:
        """Ask Mode suppresses every structured row (R6.6, R2.7)."""
        return True


def channel_for(
    path: ExecutionPath,
    *,
    gate: EmitGate,
    text_sink: TextSink,
) -> ModeChannel:
    """Build the mode-scoped channel for ``path`` (R6.6, R6.7, R2.7).

    Dispatches on the path's mode: an Ask path yields a text-only
    :class:`AskChannel` (structured rows suppressed), and any other (Agent) path
    yields a structured-only :class:`AgentChannel` wrapping ``gate`` (raw text
    rejected). A fresh channel is built per run, so suppression never carries
    over between runs (R2.7).
    """
    if path.mode is Mode.ASK:
        return AskChannel(text_sink)
    return AgentChannel(gate)


#: Convenience alias for a callable text sink, mirroring :data:`EmitSink`.
TextSinkFn = Callable[[str], None]
