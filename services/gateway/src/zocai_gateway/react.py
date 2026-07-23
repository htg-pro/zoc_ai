"""The net-new ReAct executor that drives APPLY_EDITS (Requirements 8, 9, 10).

This module replaces the single-shot APPLY_EDITS write pass with an iterative
reason/act/observe loop (design.md "The ReAct loop (net-new, Req 8/9)"). Each
iteration is exactly one :func:`~zocai_gateway.model_runtime.generate_with_tools`
call plus the execution of the tool calls it returns; the loop drives the
workspace-confined :class:`~zocai_gateway.toolsets.FullToolset`, surfaces every
effect as an ``edit-file`` or ``command`` event, counts file mutations against
the Orchestrator's Execution_Budget, and marks the structured ``AgentPlan``
steps done as they are satisfied.

Design invariants encoded here:

- **At most 30 steps (R8.1/8.7).** The loop issues at most ``MAX_STEPS`` model
  requests and never a further request after the 30th step completes.
- **Stop conditions (R8.4/8.5/8.8).** A ``stop`` finish reason stops the loop
  and executes no tool calls from that response; a non-stop response with no
  tool calls stops the loop; satisfying every plan step stops the loop and
  ignores any remaining content in the current response.
- **Confinement never aborts the run (R9.5/9.6).** Every tool call is
  dispatched through the :class:`FullToolset`; an out-of-workspace rejection
  (:class:`ReadOnlyViolation`) or any in-workspace operational failure becomes
  the tool observation and the loop continues.
- **Budget gate before every counted mutation (R10.1/10.2/10.7).** A file
  mutation is gated on ``budget.before_file_op()`` *before* it runs; at the
  File_Ceiling the run pauses (FSM→PAUSED) and an ``approval`` event is
  emitted; on success the file-iteration count increments and a ``budget``
  event is emitted.
- **Observability only as edit-file/command (R9.1/9.2/9.3).** File mutations
  emit ``edit-file``; shell calls emit ``command``; reads emit no visible row.
"""

from __future__ import annotations

import difflib
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import PurePosixPath
from typing import TYPE_CHECKING, Any, ClassVar, Protocol

from shared_schema.agent_events import (
    ApprovalEvent,
    BudgetEvent,
    CommandEvent,
    EditFileEvent,
    PlanUpdateEvent,
)

from zocai_gateway.fsm import EmitSink
from zocai_gateway.memory.state_wrapper import Diff
from zocai_gateway.mode_router import AgentRunRequest
from zocai_gateway.model_runtime import (
    ModelToolResponse,
    ToolCall,
    ToolSpec,
    generate_with_tools,
)
from zocai_gateway.orchestrator import Orchestrator
from zocai_gateway.plan import AgentPlan
from zocai_gateway.stages import Stage
from zocai_gateway.toolsets import FullToolset, ReadOnlyViolation

if TYPE_CHECKING:  # pragma: no cover - typing only, avoids a run_pipeline cycle
    from zocai_gateway.run_pipeline import RunContext

__all__ = [
    "TOOL_SPECS",
    "ReActExecutor",
    "ReActOutcome",
    "ReAct_System_Prompt",
    "ToolHistory",
    "ToolModelFn",
    "ToolObservation",
]


# ── The ReAct system prompt (R8.6) ───────────────────────────────────────────

#: Instructs the model to reason before each tool call, use the previous
#: observation to choose the next action, respond with plain text only when
#: finished, and treat the plan steps as a progress checklist (R8.6).
ReAct_System_Prompt = (
    "You are Zoc Agent executing an approved plan one step at a time.\n"
    "Reason about the next action before every tool call, and use the result "
    "of your previous tool call (your latest observation) to decide what to do "
    "next.\n"
    "Use the available tools — write_file, make_dir, delete_file, move_file, "
    "run_shell, and read_file — to carry out the plan; all paths are relative "
    "to the workspace root.\n"
    "When every step is complete, respond with plain text only and issue no "
    "further tool call.\n"
    "Treat the plan below as a progress checklist and work through each item in "
    "order."
)


# ── Tool schemas presented to the model (R8.2) ───────────────────────────────

_STRING = {"type": "string"}

TOOL_SPECS: tuple[ToolSpec, ...] = (
    ToolSpec(
        name="read_file",
        description="Read and return the text of a workspace file.",
        parameters={"type": "object", "properties": {"path": _STRING}, "required": ["path"]},
    ),
    ToolSpec(
        name="write_file",
        description="Create or modify a workspace file with its full new content.",
        parameters={
            "type": "object",
            "properties": {"path": _STRING, "content": _STRING},
            "required": ["path", "content"],
        },
    ),
    ToolSpec(
        name="make_dir",
        description="Create a directory within the workspace.",
        parameters={"type": "object", "properties": {"path": _STRING}, "required": ["path"]},
    ),
    ToolSpec(
        name="delete_file",
        description="Delete a workspace file.",
        parameters={"type": "object", "properties": {"path": _STRING}, "required": ["path"]},
    ),
    ToolSpec(
        name="move_file",
        description="Rename or move a workspace file.",
        parameters={
            "type": "object",
            "properties": {"src": _STRING, "dst": _STRING},
            "required": ["src", "dst"],
        },
    ),
    ToolSpec(
        name="run_shell",
        description="Run a shell command given as an argv list in the workspace.",
        parameters={
            "type": "object",
            "properties": {"argv": {"type": "array", "items": _STRING}},
            "required": ["argv"],
        },
    ),
)

#: File-mutating tools that are budget-gated, counted, and can satisfy an
#: EditStep (R10.1). ``make_dir`` mutates the workspace but creates a directory,
#: not a file, so it is neither gated nor counted (design tool→event table).
_COUNTED_MUTATIONS = frozenset({"write_file", "delete_file", "move_file"})


class ToolModelFn(Protocol):
    """The injectable model-boundary seam the executor calls each step (R8.2)."""

    def __call__(
        self,
        request: AgentRunRequest,
        *,
        system_prompt: str | None,
        tools: Sequence[ToolSpec],
        tool_history: Sequence[Mapping[str, Any]] = ...,
        timeout: float = ...,
    ) -> ModelToolResponse: ...


# ── Data models ──────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class ToolObservation:
    """The recorded result of executing one tool call (R8.3, R9.5, R9.6)."""

    tool_call_id: str
    ok: bool
    content: str


@dataclass(slots=True)
class ToolHistory:
    """Ordered accumulation of tool calls and observations for one run (R8.2/8.3).

    :attr:`messages` is the normalized transcript passed to the model boundary
    each step; :attr:`observations` records each executed tool call's
    observation in execution order (Property 18).
    """

    messages: list[dict[str, Any]] = field(default_factory=list)
    observations: list[ToolObservation] = field(default_factory=list)

    def append_calls(self, text: str, calls: Sequence[ToolCall]) -> None:
        """Record the assistant turn that requested ``calls``."""
        self.messages.append(
            {
                "role": "assistant",
                "content": text,
                "tool_calls": [
                    {"id": call.id, "name": call.name, "arguments": dict(call.arguments)}
                    for call in calls
                ],
            }
        )

    def append_observation(self, call: ToolCall, observation: ToolObservation) -> None:
        """Append ``observation`` for ``call`` in execution order (R8.3)."""
        self.observations.append(observation)
        self.messages.append(
            {
                "role": "tool",
                "tool_call_id": call.id,
                "name": call.name,
                "content": observation.content,
            }
        )

    def as_messages(self) -> list[dict[str, Any]]:
        """A snapshot copy of the accumulated transcript built so far (R8.2)."""
        return list(self.messages)


@dataclass(frozen=True, slots=True)
class ReActOutcome:
    """The terminal result of a ReAct run, mapped onto the apply seam (R8.5/8.7/10.2)."""

    applied_diffs: tuple[Diff, ...] = ()
    satisfied_step_ids: tuple[str, ...] = ()
    paused: bool = False
    step_budget_exhausted: bool = False
    stopped_reason: str = ""


@dataclass(slots=True)
class _DispatchResult:
    """Internal result of dispatching one tool call through the toolset."""

    observation: ToolObservation
    event: EditFileEvent | CommandEvent | None = None
    counted: bool = False
    diff: Diff | None = None
    satisfied_indices: tuple[int, ...] = ()


# ── The executor ──────────────────────────────────────────────────────────────


@dataclass(slots=True)
class ReActExecutor:
    """Drives APPLY_EDITS as an iterative reason/act/observe loop (Req 8/9/10)."""

    toolset: FullToolset
    orchestrator: Orchestrator
    plan: AgentPlan
    request: AgentRunRequest
    context: RunContext
    emit: EmitSink
    run_id: str = "run"
    tokens_used: int = 0
    run_with_tools: ToolModelFn = generate_with_tools
    authorize_write: Callable[[str], bool] | None = None

    MAX_STEPS: ClassVar[int] = 30

    def run(self) -> ReActOutcome:
        """Execute the loop to a terminal condition and return its outcome."""
        history = ToolHistory()
        applied: list[Diff] = []
        satisfied: set[int] = set()
        total_steps = len(self.plan.steps)
        system_prompt = self._system_prompt()

        paused = False
        step_budget_exhausted = False
        stopped_reason = ""

        for _step in range(self.MAX_STEPS):
            response = self.run_with_tools(
                self.request,
                system_prompt=system_prompt,
                tools=list(TOOL_SPECS),
                tool_history=history.as_messages(),
            )

            # R8.4: a stop finish reason stops the loop, executing no tool call.
            if response.finish_reason == "stop":
                stopped_reason = "stop"
                break
            # R8.8: a non-stop response with no tool calls stops the loop.
            if not response.tool_calls:
                stopped_reason = "no_tool_calls"
                break

            history.append_calls(response.text, response.tool_calls)

            stop_loop = False
            for call in response.tool_calls:
                if self.authorize_write is not None and any(
                    not self.authorize_write(path)
                    for path in self._write_paths(call)
                ):
                    if self.orchestrator.fsm.current is not Stage.PAUSED:
                        self.orchestrator.fsm.pause(
                            "write approval rejected or unavailable"
                        )
                    paused = True
                    stopped_reason = "paused_approval"
                    stop_loop = True
                    break
                # R10.2/10.7: gate a counted mutation on the file-iteration
                # ceiling *before* it runs; pause + approval at the ceiling.
                if call.name in _COUNTED_MUTATIONS and not self.orchestrator.budget.before_file_op():
                    self._pause_for_budget()
                    paused = True
                    stopped_reason = "paused_budget"
                    stop_loop = True
                    break

                result = self._dispatch(call)
                if result.event is not None:
                    self.emit(result.event)  # R9.1/9.2 edit-file / command
                history.append_observation(call, result.observation)  # R8.3

                if result.counted:
                    self.orchestrator.budget.count_file_op()  # R10.1
                    self._mark_active(call)
                    self._emit_budget()  # R10.4
                    if result.diff is not None:
                        applied.append(result.diff)
                    for index in result.satisfied_indices:
                        if index not in satisfied:
                            satisfied.add(index)
                            self._emit_plan_update(index)  # R5.6

                # R8.5: stop as soon as every step is satisfied, ignoring the
                # rest of the current response.
                if total_steps and len(satisfied) == total_steps:
                    stopped_reason = "all_satisfied"
                    stop_loop = True
                    break

            if stop_loop:
                break
        else:
            # R8.7: reached the 30th step without satisfaction or a stop reason;
            # the loop ends without issuing a further request.
            step_budget_exhausted = True
            stopped_reason = stopped_reason or "step_budget_exhausted"

        return ReActOutcome(
            applied_diffs=tuple(applied),
            satisfied_step_ids=tuple(f"edit-{index}" for index in sorted(satisfied)),
            paused=paused,
            step_budget_exhausted=step_budget_exhausted,
            stopped_reason=stopped_reason,
        )

    # -- request construction ----------------------------------------------

    def _system_prompt(self) -> str:
        """ReAct_System_Prompt plus the AgentPlan rendered as a checklist (R8.2/8.6)."""
        lines = []
        for index, step in enumerate(self.plan.steps, start=1):
            rationale = step.rationale.strip()
            suffix = f" — {rationale}" if rationale else ""
            lines.append(f"{index}. {step.action} {step.file}{suffix}")
        checklist = "\n".join(lines) if lines else "(no steps)"
        prompt = f"{ReAct_System_Prompt}\n\nPlan checklist:\n{checklist}"
        if self.plan.verification_command:
            prompt = f"{prompt}\n\nVerification command: {self.plan.verification_command}"
        return prompt

    # -- dispatch (R9.4) ----------------------------------------------------

    @staticmethod
    def _write_paths(call: ToolCall) -> tuple[str, ...]:
        if call.name in {"write_file", "delete_file"}:
            return (_arg_str(call.arguments, "path"),)
        if call.name == "move_file":
            return (
                _arg_str(call.arguments, "src"),
                _arg_str(call.arguments, "dst"),
            )
        return ()

    def _dispatch(self, call: ToolCall) -> _DispatchResult:
        """Route ``call`` through the FullToolset only, catching failures (R9.4/9.5/9.6)."""
        name = call.name
        if name == "read_file":
            return self._dispatch_read(call)
        if name == "write_file":
            return self._dispatch_write(call)
        if name == "make_dir":
            return self._dispatch_make_dir(call)
        if name == "delete_file":
            return self._dispatch_delete(call)
        if name == "move_file":
            return self._dispatch_move(call)
        if name == "run_shell":
            return self._dispatch_shell(call)
        return _DispatchResult(
            observation=ToolObservation(call.id, ok=False, content=f"unknown tool: {name!r}")
        )

    def _dispatch_read(self, call: ToolCall) -> _DispatchResult:
        path = _arg_str(call.arguments, "path")
        try:
            content = self.toolset.read_file(path)
        except (ReadOnlyViolation, OSError, UnicodeError) as exc:
            return _DispatchResult(
                observation=ToolObservation(call.id, ok=False, content=_error_text(exc))
            )
        # R9.3: reads produce an observation but no visible trace row.
        return _DispatchResult(
            observation=ToolObservation(call.id, ok=True, content=_clip(content))
        )

    def _dispatch_write(self, call: ToolCall) -> _DispatchResult:
        path = _arg_str(call.arguments, "path")
        content = _arg_str(call.arguments, "content")
        prior = self._read_prior(path)
        try:
            self.toolset.write_file(path, content)
        except (ReadOnlyViolation, OSError, UnicodeError) as exc:
            return _DispatchResult(
                observation=ToolObservation(call.id, ok=False, content=_error_text(exc))
            )
        diff_text = _unified_diff(prior or "", content, path)
        adds, dels = _diff_stats(diff_text)
        event = EditFileEvent(
            seq=0,
            run_id=self.run_id,
            ts=_now(),
            path=path,
            diff=diff_text,
            adds=adds,
            dels=dels,
            status="done",
        )
        return _DispatchResult(
            observation=ToolObservation(call.id, ok=True, content=f"wrote {path}"),
            event=event,
            counted=True,
            diff=Diff(path=path, diff=diff_text),
            satisfied_indices=self._satisfied_by(("create", "modify"), path),
        )

    def _dispatch_make_dir(self, call: ToolCall) -> _DispatchResult:
        path = _arg_str(call.arguments, "path")
        try:
            self.toolset.make_dir(path)
        except (ReadOnlyViolation, OSError) as exc:
            return _DispatchResult(
                observation=ToolObservation(call.id, ok=False, content=_error_text(exc))
            )
        # A directory is not a file: emit edit-file for visibility but do not
        # count it against the file-iteration budget or satisfy a step.
        event = EditFileEvent(
            seq=0,
            run_id=self.run_id,
            ts=_now(),
            path=path,
            diff=f"create directory {path}",
            adds=0,
            dels=0,
            status="done",
        )
        return _DispatchResult(
            observation=ToolObservation(call.id, ok=True, content=f"created directory {path}"),
            event=event,
        )

    def _dispatch_delete(self, call: ToolCall) -> _DispatchResult:
        path = _arg_str(call.arguments, "path")
        prior = self._read_prior(path)
        try:
            self.toolset.delete_file(path)
        except (ReadOnlyViolation, OSError) as exc:
            return _DispatchResult(
                observation=ToolObservation(call.id, ok=False, content=_error_text(exc))
            )
        diff_text = _unified_diff(prior or "", "", path)
        adds, dels = _diff_stats(diff_text)
        event = EditFileEvent(
            seq=0,
            run_id=self.run_id,
            ts=_now(),
            path=path,
            diff=diff_text or f"delete {path}",
            adds=adds,
            dels=dels,
            status="done",
        )
        return _DispatchResult(
            observation=ToolObservation(call.id, ok=True, content=f"deleted {path}"),
            event=event,
            counted=True,
            diff=Diff(path=path, diff=diff_text or f"delete {path}"),
            satisfied_indices=self._satisfied_by(("delete",), path),
        )

    def _dispatch_move(self, call: ToolCall) -> _DispatchResult:
        src = _arg_str(call.arguments, "src")
        dst = _arg_str(call.arguments, "dst")
        try:
            self.toolset.move_file(src, dst)
        except (ReadOnlyViolation, OSError) as exc:
            return _DispatchResult(
                observation=ToolObservation(call.id, ok=False, content=_error_text(exc))
            )
        diff_text = f"rename {src} -> {dst}"
        event = EditFileEvent(
            seq=0,
            run_id=self.run_id,
            ts=_now(),
            path=dst,
            diff=diff_text,
            adds=0,
            dels=0,
            status="done",
        )
        return _DispatchResult(
            observation=ToolObservation(call.id, ok=True, content=diff_text),
            event=event,
            counted=True,
            diff=Diff(path=dst, diff=diff_text),
            satisfied_indices=self._satisfied_by_rename(src, dst),
        )

    def _dispatch_shell(self, call: ToolCall) -> _DispatchResult:
        argv = _arg_list(call.arguments, "argv")
        command = " ".join(argv) if argv else ""
        try:
            completed = self.toolset.run_shell(argv)
        except (OSError, ValueError) as exc:
            event = CommandEvent(
                seq=0,
                run_id=self.run_id,
                ts=_now(),
                command=command or "run_shell",
                command_id="react-shell",
                status="fail",
                exit_code=None,
                error_tag=_error_text(exc),
                output_tail=_error_text(exc),
            )
            return _DispatchResult(
                observation=ToolObservation(call.id, ok=False, content=_error_text(exc)),
                event=event,
            )
        output = (completed.stdout or "") + (completed.stderr or "")
        ok = completed.returncode == 0
        event = CommandEvent(
            seq=0,
            run_id=self.run_id,
            ts=_now(),
            command=command or "run_shell",
            command_id="react-shell",
            status="pass" if ok else "fail",
            exit_code=completed.returncode,
            output_tail=_clip(output),
        )
        return _DispatchResult(
            observation=ToolObservation(
                call.id,
                ok=ok,
                content=f"exit {completed.returncode}\n{_clip(output)}",
            ),
            event=event,
        )

    # -- step satisfaction (R5.6, R8.5) -------------------------------------

    def _satisfied_by(self, actions: Sequence[str], path: str) -> tuple[int, ...]:
        """1-based indices of plan steps satisfied by ``actions`` on ``path``."""
        target = _normalize_path(path)
        return tuple(
            index
            for index, step in enumerate(self.plan.steps, start=1)
            if step.action in actions and _normalize_path(step.file) == target
        )

    def _satisfied_by_rename(self, src: str, dst: str) -> tuple[int, ...]:
        """1-based indices of rename steps satisfied by moving ``src`` to ``dst``."""
        ends = {_normalize_path(src), _normalize_path(dst)}
        return tuple(
            index
            for index, step in enumerate(self.plan.steps, start=1)
            if step.action == "rename" and _normalize_path(step.file) in ends
        )

    # -- emission helpers ---------------------------------------------------

    def _emit_plan_update(self, index: int) -> None:
        self.emit(
            PlanUpdateEvent(
                seq=0,
                run_id=self.run_id,
                ts=_now(),
                id=f"edit-{index}",
                status="done",
            )
        )

    def _emit_budget(self) -> None:
        self.emit(
            BudgetEvent(
                seq=0,
                run_id=self.run_id,
                ts=_now(),
                tokens_used=max(self.tokens_used, 0),
                token_limit=self.context.allocation.context_window,
                iterations=self.orchestrator.budget.file_iterations,
                recoveries=self.orchestrator.budget.error_recoveries,
            )
        )

    def _pause_for_budget(self) -> None:
        """Pause at the file-iteration ceiling: FSM→PAUSED + approval (R10.2/10.7)."""
        self.orchestrator.fsm.pause(
            "file-iteration ceiling reached; developer confirmation required"
        )
        self.emit(
            ApprovalEvent(
                seq=0,
                run_id=self.run_id,
                ts=_now(),
                prompt=(
                    f"File-iteration ceiling of {self.orchestrator.budget.FILE_CEILING} "
                    "reached; confirm to continue."
                ),
            )
        )

    def _mark_active(self, call: ToolCall) -> None:
        path = _arg_str(call.arguments, "dst") if call.name == "move_file" else _arg_str(
            call.arguments, "path"
        )
        if path and path not in self.orchestrator.active_file_markers:
            self.orchestrator.active_file_markers.append(path)

    def _read_prior(self, path: str) -> str | None:
        """Best-effort read of a file's prior content for diff computation."""
        try:
            return self.toolset.read_file(path)
        except (ReadOnlyViolation, OSError, UnicodeError):
            return None


# ── module helpers ────────────────────────────────────────────────────────────


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _arg_str(arguments: Mapping[str, Any], key: str) -> str:
    value = arguments.get(key)
    return value if isinstance(value, str) else ""


def _arg_list(arguments: Mapping[str, Any], key: str) -> list[str]:
    value = arguments.get(key)
    if isinstance(value, list):
        return [str(item) for item in value]
    if isinstance(value, str) and value:
        return [value]
    return []


def _normalize_path(path: str) -> str:
    cleaned = path.strip().replace("\\", "/")
    if not cleaned:
        return ""
    return str(PurePosixPath(cleaned))


def _unified_diff(old: str, new: str, path: str) -> str:
    diff = difflib.unified_diff(
        old.splitlines(keepends=True),
        new.splitlines(keepends=True),
        fromfile=f"a/{path}",
        tofile=f"b/{path}",
    )
    return "".join(diff)


def _diff_stats(diff: str) -> tuple[int, int]:
    adds = 0
    dels = 0
    for line in diff.splitlines():
        if line.startswith("+++") or line.startswith("---"):
            continue
        if line.startswith("+"):
            adds += 1
        elif line.startswith("-"):
            dels += 1
    return adds, dels


def _clip(text: str, limit: int = 8000) -> str:
    if not text:
        return ""
    return text[-limit:]


def _error_text(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {exc}"
