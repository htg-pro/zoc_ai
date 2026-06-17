"""Plan → act → observe → repair loop.

For each plan step the orchestrator asks the model to execute it (with the
full tool schema available). Tool calls are dispatched against the tool
registry; results are fed back to the model as `tool` messages. The loop
runs until the model returns a final text response with no further tool
calls. Failed tool calls trigger a bounded repair sub-loop where the model
is shown the error and asked to retry differently.

Every notable state transition is published as a structured `AgentEvent`
on the bus and persisted to the session's event log.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from uuid import UUID


def _utcnow() -> datetime:
    """Timezone-aware UTC `now`. Replaces ``_utcnow()`` which is
    deprecated in 3.12 and slated for removal in 3.13."""
    return datetime.now(UTC)


_PROJECT_QUESTION_MARKERS = (
    "analyze this project",
    "analyse this project",
    "tell me about this project",
    "what is this project",
    "check this code",
    "find bugs",
    "analyse this",
    "analyze this",
    "this project",
    "workspace",
    "codebase",
    "repo",
    "repository",
)


def _needs_workspace_inspection(prompt: str) -> bool:
    lowered = " ".join(prompt.lower().split())
    return any(marker in lowered for marker in _PROJECT_QUESTION_MARKERS)


def _clip(text: str | None, limit: int) -> str:
    if not text:
        return ""
    if len(text) <= limit:
        return text
    return text[:limit] + "\n...[truncated]"


def _format_workspace_context(
    workspace_root: str, workspace_context: dict[str, Any] | None
) -> str:
    ctx = workspace_context or {}
    lines = [
        "Workspace context supplied by the editor:",
        f"- workspace_root: {workspace_root}",
    ]
    active_file = ctx.get("active_file")
    if active_file:
        lines.append(f"- active_file: {active_file}")
    selected_text = _clip(ctx.get("selected_text"), 12_000)
    if selected_text:
        lines.extend(["- selected_text:", "```", selected_text, "```"])
    editor_content = _clip(ctx.get("editor_content"), 40_000)
    if editor_content:
        lines.extend(["- active editor content (may include unsaved changes):", "```", editor_content, "```"])
    open_files = ctx.get("open_files") or []
    if isinstance(open_files, list) and open_files:
        lines.append("- open_files:")
        for item in open_files[:12]:
            if not isinstance(item, dict):
                continue
            path = item.get("path")
            language = item.get("language") or "text"
            dirty = " dirty" if item.get("dirty") else ""
            lines.append(f"  - {path} ({language}{dirty})")
            content = _clip(item.get("content"), 8_000)
            if content and path == active_file and not editor_content:
                lines.extend(["    content:", "```", content, "```"])
    lines.append(
        "Use workspace tools for project facts; do not ask the user to upload files from this workspace."
    )
    return "\n".join(lines)

from shared_schema.models import (
    AgentLifecycleEvent,
    DiffEvent,
    DiffPatch,
    DiffReadyEvent,
    DoneEvent,
    ErrorEvent,
    LogEvent,
    Message,
    MessageDeltaEvent,
    MessageEvent,
    MessageRole,
    Plan,
    PlanCreatedEvent,
    PlanEvent,
    PlanStep,
    PlanStepEvent,
    PlanStepStatus,
    RunLifecycleEvent,
    TestLifecycleEvent,
    TodoItem,
    TodoStatus,
    TodoUpdateEvent,
    ToolCall,
    ToolCallEvent,
    ToolCallStatus,
    ToolCompletedEvent,
    ToolResult,
    ToolStartedEvent,
)

from ..events import EventBus
from ..permissions import PermissionDenied
from ..persistence import SessionRepository
from ..providers.base import (
    ChatMessage,
    ChatRequest,
    ChatResponse,
    LLMProvider,
    ProviderError,
    ProviderToolCall,
    ToolSchema,
)
from ..tools import ToolRegistry
from ..tools.base import ToolContext
from ..tools.workspace import build_project_summary
from .memory import (
    MemoryConfig,
    MemoryStats,
    estimate_tokens,
    fit_budget,
    tool_schemas_tokens,
)
from .planner import build_plan
from .project_rules import load_project_rules
from .recall import RecallConfig, RecallService, hits_as_chat_message_content
from .summariser import (
    SummariserConfig,
    summary_as_chat_message,
    update_session_summary,
)

# Strong references to fire-and-forget background tasks. Without retaining the
# task, the event loop only keeps a weak reference and the task can be garbage
# collected mid-flight, silently cancelling the work (RUF006).
_BACKGROUND_TASKS: set[asyncio.Task[Any]] = set()


def _spawn_background(coro: Any) -> asyncio.Task[Any]:
    """Schedule a fire-and-forget coroutine while keeping a strong reference."""
    task = asyncio.create_task(coro)
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)
    return task


def _format_project_summary_context(summary: dict[str, Any]) -> str:
    """Compact deterministic project snapshot for codebase-analysis prompts.

    This supplements tool calling for small/local models that sometimes answer
    before using tools. It keeps the prompt factual without requiring the user
    to paste or upload files that already exist in the selected workspace.
    """

    lines = [
        "Current workspace project snapshot:",
        f"- workspace_root: {summary.get('workspace_root')}",
        f"- exists: {summary.get('exists')}",
    ]
    frameworks = summary.get("frameworks") or []
    if frameworks:
        lines.append(f"- detected_stack: {', '.join(str(item) for item in frameworks)}")
    top_level = summary.get("top_level") or []
    if isinstance(top_level, list) and top_level:
        lines.append("- top_level:")
        for item in top_level[:80]:
            if not isinstance(item, dict):
                continue
            path = item.get("path")
            kind = item.get("kind")
            suffix = f" ({kind})" if kind else ""
            lines.append(f"  - {path}{suffix}")
    source_dirs = summary.get("source_dirs") or []
    if source_dirs:
        lines.append(f"- source_dirs: {', '.join(str(item) for item in source_dirs)}")
    package_files = summary.get("package_files") or {}
    if isinstance(package_files, dict) and package_files:
        lines.append("- package_files:")
        for path, info in list(package_files.items())[:24]:
            if not isinstance(info, dict):
                lines.append(f"  - {path}")
                continue
            details: list[str] = []
            scripts = info.get("scripts")
            if isinstance(scripts, list) and scripts:
                details.append("scripts=" + ",".join(str(s) for s in scripts[:16]))
            deps = sorted(
                {
                    str(dep)
                    for key in ("dependencies", "devDependencies", "peerDependencies")
                    for dep in (info.get(key) or [])
                }
            )
            if deps:
                details.append("deps=" + ",".join(deps[:24]))
            preview = info.get("preview")
            if isinstance(preview, str) and preview.strip():
                details.append("preview=" + _clip(preview.strip(), 600).replace("\n", " / "))
            lines.append(f"  - {path}" + (f": {'; '.join(details)}" if details else ""))
    important_files = summary.get("important_files") or []
    if isinstance(important_files, list) and important_files:
        lines.append("- important_files:")
        for item in important_files[:120]:
            if isinstance(item, dict):
                lines.append(f"  - {item.get('path')}")
    issues = summary.get("potential_issues") or []
    if issues:
        lines.append("- potential_issues:")
        for issue in issues:
            lines.append(f"  - {issue}")
    lines.append(
        "When answering, analyze this workspace directly from the snapshot and tools. "
        "Do not ask the user to upload or paste files from this workspace."
    )
    return "\n".join(lines)


# Live to-do list tool (Cursor/Claude Code TodoWrite pattern). The LLM calls
# this to author and update a checklist specific to the current request. It is
# intercepted by the orchestrator (never routed to the filesystem dispatcher)
# and each call emits a `todo_update` SSE event carrying the full snapshot.
TODO_WRITE_TOOL_SCHEMA = ToolSchema(
    name="todo_write",
    description=(
        "Author and maintain a live checklist for the current request. Call this "
        "on your first turn with a short list of concrete steps specific to THIS "
        "request (not a generic template). As you work, call it again with the "
        "full updated list, marking items 'in_progress' or 'completed'. For a "
        "trivial request that needs no file changes (e.g. a greeting or a "
        "question), a single item is fine."
    ),
    parameters={
        "type": "object",
        "properties": {
            "todos": {
                "type": "array",
                "description": "The full to-do list (always send the complete list, not a delta).",
                "items": {
                    "type": "object",
                    "properties": {
                        "content": {
                            "type": "string",
                            "description": "Short imperative description of the step.",
                        },
                        "status": {
                            "type": "string",
                            "enum": ["pending", "in_progress", "completed"],
                            "description": "Current status of this step.",
                        },
                    },
                    "required": ["content", "status"],
                },
            }
        },
        "required": ["todos"],
    },
)


def _coerce_todos(raw: Any) -> list[TodoItem]:
    """Best-effort parse of the LLM's `todo_write` arguments into TodoItems.

    Tolerates missing ids, unknown statuses, and string-only items so a
    slightly malformed tool call still renders something useful instead of
    crashing the run.
    """
    items = raw.get("todos") if isinstance(raw, dict) else raw
    if not isinstance(items, list):
        return []
    out: list[TodoItem] = []
    for idx, item in enumerate(items):
        if isinstance(item, str):
            content, status = item, TodoStatus.pending
        elif isinstance(item, dict):
            content = str(item.get("content") or item.get("title") or "").strip()
            raw_status = str(item.get("status") or "pending").strip().lower()
            try:
                status = TodoStatus(raw_status)
            except ValueError:
                status = TodoStatus.pending
        else:
            continue
        if not content:
            continue
        out.append(TodoItem(id=str(idx + 1), content=content, status=status))
    return out


def _diff_patch_from_result(
    name: str, arguments: dict[str, Any], data: Any
) -> DiffPatch | None:
    """Build a `DiffPatch` from a successful write_file / apply_patch result.

    Returns None when there's nothing meaningful to show (e.g. a write that
    produced an empty diff because the content was identical).
    """
    if name == "write_file":
        if not isinstance(data, dict):
            return None
        diff = str(data.get("diff") or "")
        path = str(data.get("path") or arguments.get("path") or "file")
        if not diff.strip():
            return None
        return DiffPatch(file_path=path, unified_diff=diff, summary=f"Edited {path}")
    if name == "apply_patch":
        diff = str(arguments.get("unified_diff") or "")
        if not diff.strip():
            return None
        changed = data.get("files_changed") if isinstance(data, dict) else None
        if isinstance(changed, list) and changed:
            label = ", ".join(str(f) for f in changed[:4])
            file_path = str(changed[0])
        else:
            label = "patch"
            file_path = "patch"
        return DiffPatch(file_path=file_path, unified_diff=diff, summary=f"Applied patch to {label}")
    return None


def _aggregate_run_patches(tool_calls: list[ToolCall]) -> list[DiffPatch]:
    """Collect one `DiffPatch` per successful write_file/apply_patch call in a
    run, for the end-of-run `diff.ready` review snapshot. De-dupes by file
    path, keeping the latest change."""
    by_path: dict[str, DiffPatch] = {}
    for call in tool_calls:
        if call.status != ToolCallStatus.succeeded or call.name not in ("write_file", "apply_patch"):
            continue
        patch = _diff_patch_from_result(call.name, call.arguments, call.result)
        if patch is not None:
            by_path[patch.file_path] = patch
    return list(by_path.values())


# Ask mode system prompt: read-only Q&A. No planning, no to-do checklist, and
# the model is told never to claim it changed files. The tool set is further
# restricted to read/search tools at the endpoint (ASK_MODE_TOOLS).
ASK_SYSTEM_PROMPT: str = (
    "You are Zoc AI in Ask mode: a read-only coding assistant for the user's "
    "current workspace. Answer the user's question directly and conversationally. "
    "You may inspect the project with read/search tools (get_project_summary, "
    "list_dir, read_file, grep_search, glob_files, get_git_status, get_git_diff) "
    "when the question needs project context, but only when needed — a greeting or "
    "general question needs no tools. "
    "Do NOT create a plan. Do NOT create or update a to-do checklist. Do NOT claim "
    "you changed, created, or deleted any files — Ask mode cannot modify the "
    "workspace. If the request would require editing files or running commands, "
    "briefly explain what you would do and tell the user to switch to Agent mode to "
    "make the changes."
)


@dataclass(slots=True)
class OrchestratorConfig:
    system_prompt: str = (
        "You are Zoc AI, an autonomous agentic coding assistant running inside "
        "the user's current workspace. The workspace files are available through tools. "
        "Never ask the user to upload or provide project files when a workspace path is "
        "present. For project-specific questions, use workspace tools before answering. "
        "For requests such as analyze this project, tell me about this project, what is "
        "this project, check this code, or find bugs: first inspect package/config files, "
        "README files, and source directories with get_project_summary, list_dir, "
        "read_file, grep_search, or glob_files, then answer from those facts. If the "
        "active editor file is relevant, inspect get_active_file or the supplied editor "
        "content. If the user asks about a UI bug, inspect frontend layout/components "
        "first. If the user asks about a backend bug, inspect FastAPI/Tauri/agent files "
        "first. For code changes, create a clear plan and rely on tool approvals before "
        "writing files or running commands. After edits, run the strongest relevant "
        "validation commands and repair exact file/line errors until no known error "
        "remains or you must report a concrete blocker. "
        "Before doing anything else, call the `todo_write` tool with a short checklist "
        "of concrete steps specific to this request, then update it (marking items "
        "'in_progress' and 'completed') as you make progress. For a trivial request "
        "that needs no file changes, a single completed item is fine."
    )
    max_iterations: int = 12
    max_repair_attempts: int = 2
    allowed_tools: tuple[str, ...] | None = None
    skip_planner: bool = False
    # When False, the virtual `todo_write` tool is not exposed to the model and
    # no to-do checklist events are emitted. Ask mode sets this False so a
    # read-only Q&A never produces a plan/checklist (see ASK_SYSTEM_PROMPT).
    enable_todos: bool = True
    # Presentation hint carried end-to-end so the frontend can pick a render
    # pipeline. "ask" => clean Q&A transcript; "agent"/"plan"/"debug" => full
    # workflow timeline. Does not change orchestration on its own.
    presentation_mode: str = "agent"
    # How long a tool call may sit suspended waiting for the user's
    # approval decision before it is treated as denied.
    approval_timeout: float = 300.0
    # Phase-1 stop-gap: hard cap on the number of prior messages we replay
    # into history. Used only when the model's context_window is unknown
    # (mock/dev). Real budgeting goes through `MemoryConfig` below.
    working_memory_window: int = 40
    # Phase-2: token-budget-aware truncation. When set, the orchestrator
    # uses `fit_budget` from `agent.memory` to decide what fits instead of
    # relying on the message-count cap above. The orchestrator fills
    # `context_window` from the active provider's catalogue if it can.
    memory: MemoryConfig | None = None
    # Phase-3: episodic summarisation. When enabled and `fit_budget`
    # evicts messages, the orchestrator runs a background summariser to
    # fold the dropped chunk into a running summary. The summary is
    # injected into the next turn's history as a system message.
    enable_summarisation: bool = True
    summariser: SummariserConfig | None = None
    # Phase-4: semantic recall. When enabled and a `RecallService` is
    # plumbed through, dropped messages get embedded into a per-session
    # vector store and the top-k relevant ones for the current prompt
    # are injected as an extra system message. Cheap insurance against
    # the summariser losing a specific fact the user later asks about.
    enable_recall: bool = True
    recall: RecallConfig | None = None


@dataclass(slots=True)
class OrchestratorResult:
    final_text: str
    iterations: int
    plan: Plan | None
    tool_calls: list[ToolCall] = field(default_factory=list)
    repaired: bool = False
    memory_stats: MemoryStats | None = None


class AgentOrchestrator:
    def __init__(
        self,
        *,
        provider: LLMProvider,
        model: str,
        registry: ToolRegistry,
        repo: SessionRepository,
        bus: EventBus,
        indexer: Any = None,
        permissions: Any = None,
        approvals: Any = None,
        recall_service: RecallService | None = None,
    ) -> None:
        self.provider = provider
        self.model = model
        self.registry = registry
        self.repo = repo
        self.bus = bus
        self.indexer = indexer
        self.permissions = permissions
        self.approvals = approvals
        self.recall_service = recall_service
        # The owning run id for the in-flight `run()`. Set at the start of
        # `run()` from `workspace_context["run_id"]` and stamped onto every
        # event by `_emit` so the frontend can correlate events to runs and
        # discard events from a superseded run. Orthogonal to the per-session
        # `seq` (which `EventBus.next_seq` remains the sole authority for).
        self._run_id: str | None = None

    def _resolve_context_window(self) -> int | None:
        """Best-effort: ask the provider for the active model's context window."""
        try:
            for descriptor in self.provider.models():
                if descriptor.model_id == self.model:
                    return descriptor.capability.context_window
        except Exception:  # pragma: no cover — providers may not have a catalogue
            return None
        return None

    async def _extend_summary_safely(
        self,
        *,
        session_id: UUID,
        dropped: list[Message],
        cfg: SummariserConfig | None,
    ) -> None:
        """Background-task wrapper around `update_session_summary`.

        Swallows all exceptions because failing to update the summary must
        never break the user's turn — the working window alone is still a
        coherent conversation, just less informative.
        """
        try:
            await update_session_summary(
                repo=self.repo,
                provider=self.provider,
                model=self.model,
                session_id=session_id,
                dropped=dropped,
                cfg=cfg,
            )
        except Exception:
            return

    async def _index_recall_safely(
        self,
        *,
        session_id: UUID,
        messages: list[Message],
    ) -> None:
        """Background-task wrapper around `RecallService.index_messages`.

        Like the summariser, swallows everything: an embedding failure
        must never break the user's turn. The next turn will simply
        retry indexing for the same messages (the store is idempotent).
        """
        if self.recall_service is None:
            return
        try:
            await self.recall_service.index_messages(session_id, messages)
        except Exception:
            return

    async def run(
        self,
        *,
        session_id: UUID,
        workspace_root: str,
        prompt: str,
        workspace_context: dict[str, Any] | None = None,
        config: OrchestratorConfig | None = None,
        record_prompt: bool = True,
    ) -> OrchestratorResult:
        cfg = config or OrchestratorConfig()
        # Adopt the owning run id (minted in v1/agent_run.py and threaded
        # through workspace_context) so every event emitted below carries it.
        # Absent (e.g. the retry path) → events keep run_id=None and the
        # frontend treats them as belonging to the active run (legacy).
        run_id_ctx = (workspace_context or {}).get("run_id")
        self._run_id = str(run_id_ctx) if run_id_ctx else None
        await self._emit(
            session_id,
            AgentLifecycleEvent(
                session_id=session_id,
                seq=0,
                type="agent.started",
                message="Agent run started.",
            ),
        )
        # Unified run lifecycle (Part 4), emitted additively alongside the
        # legacy agent.* events. `mode` lets the UI branch on ask vs agent.
        run_mode = str((workspace_context or {}).get("mode") or "agent")
        await self._emit(
            session_id,
            RunLifecycleEvent(
                session_id=session_id,
                seq=0,
                type="run.started",
                mode=run_mode,
                message="Run started.",
            ),
        )
        await self._emit(
            session_id, LogEvent(session_id=session_id, seq=0, level="info", message="agent.start")
        )
        await self._emit(
            session_id,
            AgentLifecycleEvent(
                session_id=session_id,
                seq=0,
                type="agent.context.loading",
                message="Loading workspace context.",
            ),
        )

        plan: Plan | None = None
        if not cfg.skip_planner:
            try:
                planner_out = await build_plan(
                    self.provider, model=self.model, goal=prompt
                )
                plan = planner_out.plan
                self.repo.save_plan(session_id, plan)
                await self._emit(
                    session_id,
                    PlanCreatedEvent(session_id=session_id, seq=0, plan=plan),
                )
                await self._emit(
                    session_id, PlanEvent(session_id=session_id, seq=0, plan=plan)
                )
            except ProviderError as exc:
                await self._emit(
                    session_id,
                    ErrorEvent(session_id=session_id, seq=0, message="planner failed", detail=str(exc)),
                )

        ctx = ToolContext(
            session_id=session_id,
            workspace_root=workspace_root,
            active_file=(workspace_context or {}).get("active_file"),
            open_files=(workspace_context or {}).get("open_files"),
            selected_text=(workspace_context or {}).get("selected_text"),
            editor_content=(workspace_context or {}).get("editor_content"),
            permissions=self.permissions,
            indexer=self.indexer,
        )

        tools = self._resolve_tools(cfg)
        tool_schemas = [
            ToolSchema(name=t.name, description=t.description, parameters=t.Input.model_json_schema())
            for t in tools
        ]
        # Expose the live to-do tool alongside the real filesystem/shell tools.
        # It's intercepted in the dispatch loop and never hits the registry.
        # Ask mode disables this so a read-only Q&A produces no checklist.
        if cfg.enable_todos:
            tool_schemas.append(TODO_WRITE_TOOL_SCHEMA)

        # Phase 1+2+3: working memory with token-budget truncation and an
        # episodic summary of older turns.
        # Replay the persisted conversation so the model sees prior turns
        # and can answer follow-ups coherently. If a `MemoryConfig` is
        # provided (or one can be derived from the model's context window),
        # `fit_budget` decides how many fit; otherwise we fall back to the
        # `working_memory_window` message count.
        prior_messages = self.repo.list_messages(session_id)
        memory_cfg = cfg.memory
        if memory_cfg is None:
            ctx_window = self._resolve_context_window()
            if ctx_window is not None:
                memory_cfg = MemoryConfig(context_window=ctx_window)

        # Phase 3: load any existing episodic summary so we can (a) inject
        # it as a system message and (b) reserve its tokens in the budget.
        existing_summary = self.repo.get_summary(session_id)
        summary_text: str | None = (
            existing_summary["summary"] if existing_summary else None
        )
        summary_tokens = (
            int(existing_summary["token_estimate"]) if existing_summary else 0
        )
        if memory_cfg is not None and summary_tokens > 0:
            # Make a copy with the summary's tokens reserved so `fit_budget`
            # leaves room for it in the prompt.
            memory_cfg = MemoryConfig(
                context_window=memory_cfg.context_window,
                output_reserve=memory_cfg.output_reserve,
                tool_overhead_floor=memory_cfg.tool_overhead_floor,
                working_window=memory_cfg.working_window,
                summary_reserve=summary_tokens,
            )

        memory_stats: MemoryStats | None = None
        dropped_messages: list[Message] = []
        if memory_cfg is not None:
            kept, dropped_messages, memory_stats = fit_budget(
                prior_messages,
                memory_cfg,
                system_prompt_tokens=estimate_tokens(cfg.system_prompt),
                tool_overhead=tool_schemas_tokens(tool_schemas),
                current_user_prompt_tokens=estimate_tokens(prompt),
            )
            prior_messages = kept
        elif cfg.working_memory_window > 0 and len(prior_messages) > cfg.working_memory_window:
            prior_messages = prior_messages[-cfg.working_memory_window:]

        inspect_workspace = _needs_workspace_inspection(prompt)
        project_summary_context = ""
        if inspect_workspace:
            project_summary_context = _format_project_summary_context(
                build_project_summary(workspace_root, max_files=240)
            )

        history: list[ChatMessage] = [ChatMessage(role="system", content=cfg.system_prompt)]
        if summary_text:
            history.append(summary_as_chat_message(summary_text))
        workspace_context_text = _format_workspace_context(workspace_root, workspace_context)
        if workspace_context_text:
            history.append(ChatMessage(role="system", content=workspace_context_text))
        # Project rules (.zoc/rules) — authoritative per-project conventions.
        rules_text = load_project_rules(workspace_root)
        if rules_text:
            history.append(ChatMessage(role="system", content=rules_text))
        if project_summary_context:
            history.append(ChatMessage(role="system", content=project_summary_context))
        await self._emit(
            session_id,
            AgentLifecycleEvent(
                session_id=session_id,
                seq=0,
                type="agent.context.ready",
                message=(
                    "Workspace context ready. Inspected the project root."
                    if inspect_workspace
                    else "Workspace context ready."
                ),
            ),
        )
        await self._emit(
            session_id,
            RunLifecycleEvent(
                session_id=session_id,
                seq=0,
                type="run.context_ready",
                mode=run_mode,
                message="Workspace context ready.",
            ),
        )

        # Phase 4: semantic recall. Pull a few prior messages that look
        # relevant to the current prompt and inject them as a system
        # message. We exclude anything already in the working window so
        # we don't waste tokens repeating what the model is about to see
        # verbatim.
        if (
            cfg.enable_recall
            and self.recall_service is not None
            and prior_messages is not None
        ):
            try:
                kept_ids = {m.id for m in prior_messages}
                hits = await self.recall_service.recall(
                    session_id,
                    prompt,
                    cfg=cfg.recall,
                    exclude_message_ids=kept_ids,
                )
            except Exception:
                hits = []
            if hits:
                history.append(
                    ChatMessage(
                        role="system",
                        content=hits_as_chat_message_content(hits),
                    )
                )

        for m in prior_messages:
            history.append(
                ChatMessage(
                    role=m.role.value,
                    content=m.content,
                    name=m.name,
                    tool_call_id=str(m.tool_call_id) if m.tool_call_id is not None else None,
                )
            )
        history.append(ChatMessage(role="user", content=prompt))

        # Phase 3 fire-and-forget: extend the running summary in the
        # background so this turn isn't blocked. We only summarise messages
        # that aren't already covered by the existing summary.
        if cfg.enable_summarisation and dropped_messages:
            _spawn_background(
                self._extend_summary_safely(
                    session_id=session_id,
                    dropped=dropped_messages,
                    cfg=cfg.summariser,
                )
            )

        # Phase 4 fire-and-forget: embed dropped messages into the recall
        # store so the next turn can retrieve them. Indexing is idempotent
        # (the store skips message ids it already has) so re-firing this
        # task across turns is safe.
        if (
            cfg.enable_recall
            and self.recall_service is not None
            and dropped_messages
        ):
            _spawn_background(
                self._index_recall_safely(
                    session_id=session_id,
                    messages=dropped_messages,
                )
            )

        # User message is also persisted as part of the session transcript.
        # Skipped when re-issuing an existing prompt (e.g. retrying a tool call
        # cancelled by a restart) so the transcript isn't duplicated.
        if record_prompt:
            user_msg = Message(role=MessageRole.user, content=prompt)
            self.repo.add_message(session_id, user_msg)
            await self._emit(
                session_id, MessageEvent(session_id=session_id, seq=0, message=user_msg)
            )

        tool_calls_recorded: list[ToolCall] = []
        repaired = False
        final_text = ""
        # Pre-initialise the iteration counter so a zero-iteration run
        # (e.g. `max_iterations=0`, or a provider error before the first
        # iteration body) still reports a meaningful number to the client.
        iteration = 0

        # Step pointer for the plan — advance each time the model completes
        # a step (heuristic: each iteration without a tool call counts).
        active_step_idx = 0

        if inspect_workspace:
            preflight = ProviderToolCall(
                id="preflight-get-project-summary",
                name="get_project_summary",
                arguments={"path": ".", "max_files": 240},
            )
            call_record, observation = await self._dispatch_tool(
                session_id, ctx, preflight, cfg, 0
            )
            tool_calls_recorded.append(call_record)
            observed_call = ProviderToolCall(
                id=str(call_record.id),
                name=preflight.name,
                arguments=preflight.arguments,
            )
            history.append(
                ChatMessage(
                    role="assistant",
                    content="",
                    tool_calls=[observed_call],
                )
            )
            history.append(
                ChatMessage(
                    role="tool",
                    name=preflight.name,
                    tool_call_id=str(call_record.id),
                    content=observation,
                )
            )

        for iteration in range(1, cfg.max_iterations + 1):
            try:
                response = await self._chat_with_events(
                    session_id,
                    ChatRequest(messages=history, model=self.model, tools=tool_schemas),
                )
            except ProviderError as exc:
                await self._emit(
                    session_id,
                    ErrorEvent(session_id=session_id, seq=0, message="provider failed", detail=str(exc)),
                )
                await self._emit(
                    session_id,
                    AgentLifecycleEvent(
                        session_id=session_id,
                        seq=0,
                        type="agent.error",
                        message="Provider failed.",
                        detail=str(exc),
                    ),
                )
                await self._emit(
                    session_id,
                    RunLifecycleEvent(
                        session_id=session_id,
                        seq=0,
                        type="run.error",
                        mode=run_mode,
                        message="Provider failed.",
                        detail=str(exc),
                    ),
                )
                final_text = f"(error: {exc})"
                break

            if response.text:
                history.append(ChatMessage(role="assistant", content=response.text))
            if not response.tool_calls:
                if response.text:
                    msg = Message(role=MessageRole.assistant, content=response.text)
                    self.repo.add_message(session_id, msg)
                    await self._emit(
                        session_id, MessageEvent(session_id=session_id, seq=0, message=msg)
                    )
                final_text = response.text or final_text
                if plan and active_step_idx < len(plan.steps):
                    await self._mark_step(session_id, plan, active_step_idx, PlanStepStatus.done)
                break

            history.append(
                ChatMessage(
                    role="assistant",
                    content=response.text or "",
                    tool_calls=list(response.tool_calls),
                )
            )

            for ptc in response.tool_calls:
                call_record, observation = await self._dispatch_tool(
                    session_id, ctx, ptc, cfg, iteration
                )
                tool_calls_recorded.append(call_record)
                history.append(
                    ChatMessage(
                        role="tool",
                        name=ptc.name,
                        tool_call_id=str(call_record.id),
                        content=observation,
                    )
                )

                if call_record.status == ToolCallStatus.failed and cfg.max_repair_attempts > 0:
                    repaired_ok = await self._repair_loop(
                        session_id=session_id,
                        ctx=ctx,
                        history=history,
                        failed_call=ptc,
                        tools_schema=tool_schemas,
                        cfg=cfg,
                        tool_calls_recorded=tool_calls_recorded,
                    )
                    repaired = repaired or repaired_ok

            if plan and active_step_idx < len(plan.steps):
                await self._mark_step(
                    session_id, plan, active_step_idx, PlanStepStatus.running
                )
                active_step_idx = min(active_step_idx + 1, len(plan.steps))

        # If the loop ran to completion without producing a final assistant
        # message (i.e. every iteration ended in a tool call), tell the user
        # *something* instead of returning an empty string. This is the
        # max-iterations exhaustion path.
        if not final_text and iteration >= cfg.max_iterations:
            final_text = (
                f"(stopped after {iteration} iterations without a final answer — "
                "the agent exhausted its iteration budget while still calling tools)"
            )
            exhausted_msg = Message(role=MessageRole.assistant, content=final_text)
            self.repo.add_message(session_id, exhausted_msg)
            await self._emit(
                session_id,
                MessageEvent(session_id=session_id, seq=0, message=exhausted_msg),
            )

        await self._emit(
            session_id,
            AgentLifecycleEvent(
                session_id=session_id,
                seq=0,
                type="agent.completed",
                message="Agent run completed." if final_text else "Agent run ended without a final answer.",
                detail=final_text[:500] if final_text else None,
            ),
        )
        # Unified run-end lifecycle (Part 4): branch on whether the run
        # actually changed files. Aggregate the per-write diffs into one
        # `diff.ready` snapshot for the review card.
        run_patches = _aggregate_run_patches(tool_calls_recorded)
        if run_patches:
            await self._emit(
                session_id,
                DiffReadyEvent(session_id=session_id, seq=0, patches=run_patches),
            )
            await self._emit(
                session_id,
                RunLifecycleEvent(
                    session_id=session_id,
                    seq=0,
                    type="run.awaiting_review",
                    mode=run_mode,
                    message="Run finished with changes awaiting review.",
                    changed_files=len(run_patches),
                ),
            )
        else:
            await self._emit(
                session_id,
                RunLifecycleEvent(
                    session_id=session_id,
                    seq=0,
                    type="run.applied",
                    mode=run_mode,
                    message="Run finished with no file changes.",
                    changed_files=0,
                ),
            )
        await self._emit(
            session_id,
            DoneEvent(
                session_id=session_id,
                seq=0,
                ok=bool(final_text),
                summary=final_text[:200] if final_text else None,
            ),
        )
        return OrchestratorResult(
            final_text=final_text,
            iterations=iteration,
            plan=plan,
            tool_calls=tool_calls_recorded,
            repaired=repaired,
            memory_stats=memory_stats,
        )

    # ── helpers ────────────────────────────────────────────────────────

    def _resolve_tools(self, cfg: OrchestratorConfig):
        if cfg.allowed_tools is None:
            return self.registry.list()
        return [self.registry.get(n) for n in cfg.allowed_tools]

    async def _chat_with_events(
        self, session_id: UUID, request: ChatRequest
    ) -> ChatResponse:
        try:
            stream = await self.provider.stream(request)
        except (AttributeError, NotImplementedError):
            return await self.provider.chat(request)

        text_parts: list[str] = []
        tool_calls: list[ProviderToolCall] = []
        async for chunk in stream:
            if chunk.delta_text:
                text_parts.append(chunk.delta_text)
                await self._emit(
                    session_id,
                    MessageDeltaEvent(
                        session_id=session_id,
                        seq=0,
                        delta=chunk.delta_text,
                    ),
                )
            if chunk.delta_tool_calls:
                tool_calls.extend(chunk.delta_tool_calls)
        return ChatResponse(text="".join(text_parts), tool_calls=tool_calls)

    async def _dispatch_tool(
        self,
        session_id: UUID,
        ctx: ToolContext,
        ptc: ProviderToolCall,
        cfg: OrchestratorConfig,
        iteration: int,
    ) -> tuple[ToolCall, str]:
        # `todo_write` is a virtual tool: it never touches the filesystem.
        # Intercept it, broadcast the live to-do snapshot, and return a
        # cheap success observation so the LLM keeps going.
        if ptc.name == "todo_write":
            # Ask mode (enable_todos=False) must never emit a to-do snapshot,
            # even if a misbehaving model calls todo_write anyway. Swallow it as
            # a no-op and nudge the model back to answering directly.
            if not cfg.enable_todos:
                call = ToolCall(
                    name=ptc.name,
                    arguments=ptc.arguments,
                    status=ToolCallStatus.succeeded,
                    result={"ok": True, "ignored": True},
                    started_at=_utcnow(),
                    finished_at=_utcnow(),
                )
                return call, json.dumps(
                    {
                        "ok": True,
                        "message": (
                            "To-do lists are disabled in Ask mode. Answer the user "
                            "directly without a checklist."
                        ),
                    }
                )
            todos = _coerce_todos(ptc.arguments)
            await self._emit(
                session_id,
                TodoUpdateEvent(session_id=session_id, seq=0, todos=todos),
            )
            call = ToolCall(
                name=ptc.name,
                arguments=ptc.arguments,
                status=ToolCallStatus.succeeded,
                result={"ok": True, "count": len(todos)},
                started_at=_utcnow(),
                finished_at=_utcnow(),
            )
            return call, json.dumps({"ok": True, "message": "Todo list updated."})

        try:
            tool = self.registry.get(ptc.name)
        except KeyError as exc:
            call = ToolCall(
                name=ptc.name,
                arguments=ptc.arguments,
                status=ToolCallStatus.failed,
                error=str(exc),
                started_at=_utcnow(),
                finished_at=_utcnow(),
            )
            self.repo.upsert_tool_call(session_id, call)
            await self._emit(
                session_id, ToolCallEvent(session_id=session_id, seq=0, tool_call=call)
            )
            await self._emit(
                session_id,
                ToolCompletedEvent(session_id=session_id, seq=0, tool_call=call),
            )
            return call, json.dumps({"ok": False, "error": str(exc)})

        call = ToolCall(
            name=ptc.name,
            arguments=ptc.arguments,
            status=ToolCallStatus.running,
            started_at=_utcnow(),
        )

        # If the call would be denied, suspend it and wait for the user's
        # decision instead of failing it outright. A real interactive pause:
        # the orchestrator stops here until the frontend resolves the call.
        denial = tool.permission_error(ctx)
        if denial is not None:
            approved = await self._await_approval(session_id, call, denial, cfg)
            if not approved:
                call.status = ToolCallStatus.failed
                call.error = f"not approved: {denial}"
                call.finished_at = _utcnow()
                self.repo.upsert_tool_call(session_id, call)
                await self._emit(
                    session_id,
                    ToolCallEvent(session_id=session_id, seq=0, tool_call=call),
                )
                await self._emit(
                    session_id,
                    ToolCompletedEvent(session_id=session_id, seq=0, tool_call=call),
                )
                return call, json.dumps({"ok": False, "error": call.error})
            # Approved: clear the suspension and run for real.
            call.status = ToolCallStatus.running
            call.error = None

        self.repo.upsert_tool_call(session_id, call)
        await self._emit(
            session_id, ToolCallEvent(session_id=session_id, seq=0, tool_call=call)
        )
        await self._emit(
            session_id, ToolStartedEvent(session_id=session_id, seq=0, tool_call=call)
        )
        if call.name == "run_tests":
            await self._emit(
                session_id,
                TestLifecycleEvent(
                    session_id=session_id,
                    seq=0,
                    type="test.started",
                    name=call.name,
                ),
            )
        try:
            result: ToolResult = await tool.execute(ctx, ptc.arguments)
        except PermissionDenied as exc:
            # The grant disappeared between approval and execution (e.g. a
            # one-shot grant consumed elsewhere). Surface as a failure.
            call.status = ToolCallStatus.failed
            call.error = str(exc)
            call.finished_at = _utcnow()
            self.repo.upsert_tool_call(session_id, call)
            await self._emit(
                session_id, ToolCallEvent(session_id=session_id, seq=0, tool_call=call)
            )
            await self._emit(
                session_id,
                ToolCompletedEvent(session_id=session_id, seq=0, tool_call=call),
            )
            return call, json.dumps({"ok": False, "error": str(exc)})
        call.status = ToolCallStatus.succeeded if result.ok else ToolCallStatus.failed
        call.result = result.data
        call.error = result.error
        call.finished_at = _utcnow()
        self.repo.upsert_tool_call(session_id, call)
        await self._emit(
            session_id, ToolCallEvent(session_id=session_id, seq=0, tool_call=call)
        )
        await self._emit(
            session_id, ToolCompletedEvent(session_id=session_id, seq=0, tool_call=call)
        )
        # Surface file changes as diff events so the UI can show a review card.
        if result.ok and call.name in ("write_file", "apply_patch"):
            patch = _diff_patch_from_result(call.name, ptc.arguments, result.data)
            if patch is not None:
                await self._emit(
                    session_id, DiffEvent(session_id=session_id, seq=0, patch=patch)
                )
        if call.name == "run_tests":
            await self._emit(
                session_id,
                TestLifecycleEvent(
                    session_id=session_id,
                    seq=0,
                    type="test.completed",
                    name=call.name,
                    ok=result.ok,
                    output=json.dumps(result.data, default=str)[:24_000],
                ),
            )

        observation = json.dumps(
            {"ok": result.ok, "data": result.data, "error": result.error}, default=str
        )
        return call, observation

    async def _await_approval(
        self,
        session_id: UUID,
        call: ToolCall,
        denial: PermissionDenied,
        cfg: OrchestratorConfig,
    ) -> bool:
        """Suspend a tool call and wait for the user's approval decision.

        Emits a `needs_approval` tool-call event so the UI can prompt, then
        blocks on the approval gate until the frontend resolves the call.
        Returns True if the user approved (and the grant is now in place),
        False on denial or timeout.
        """

        call.status = ToolCallStatus.needs_approval
        call.error = str(denial)
        self.repo.upsert_tool_call(session_id, call)
        await self._emit(
            session_id, ToolCallEvent(session_id=session_id, seq=0, tool_call=call)
        )

        if self.approvals is None:
            return False

        await self._emit(
            session_id,
            LogEvent(
                session_id=session_id,
                seq=0,
                level="info",
                message=f"awaiting approval for {call.name}",
            ),
        )
        try:
            return await self.approvals.wait(
                session_id, call.id, timeout=cfg.approval_timeout
            )
        except TimeoutError:
            await self._emit(
                session_id,
                LogEvent(
                    session_id=session_id,
                    seq=0,
                    level="warning",
                    message=f"approval timed out for {call.name}",
                ),
            )
            return False

    async def _repair_loop(
        self,
        *,
        session_id: UUID,
        ctx: ToolContext,
        history: list[ChatMessage],
        failed_call: ProviderToolCall,
        tools_schema: list[ToolSchema],
        cfg: OrchestratorConfig,
        tool_calls_recorded: list[ToolCall],
    ) -> bool:
        """Ask the model to recover from a failed tool call. Returns True
        if recovery succeeded within `max_repair_attempts`.
        """

        for attempt in range(1, cfg.max_repair_attempts + 1):
            history.append(
                ChatMessage(
                    role="user",
                    content=(
                        f"The previous tool call to `{failed_call.name}` failed."
                        f" Please diagnose and retry with a corrected call."
                        f" Attempt {attempt}/{cfg.max_repair_attempts}."
                    ),
                )
            )
            await self._emit(
                session_id,
                LogEvent(
                    session_id=session_id,
                    seq=0,
                    level="warning",
                    message=f"repair attempt {attempt} for {failed_call.name}",
                ),
            )
            try:
                resp = await self._chat_with_events(
                    session_id,
                    ChatRequest(messages=history, model=self.model, tools=tools_schema),
                )
            except ProviderError as exc:
                await self._emit(
                    session_id,
                    ErrorEvent(session_id=session_id, seq=0, message="repair provider error", detail=str(exc)),
                )
                return False
            if resp.text:
                history.append(ChatMessage(role="assistant", content=resp.text))
            if not resp.tool_calls:
                return True
            history.append(
                ChatMessage(role="assistant", content=resp.text or "", tool_calls=list(resp.tool_calls))
            )
            success = True
            for ptc in resp.tool_calls:
                call, obs = await self._dispatch_tool(session_id, ctx, ptc, cfg, 0)
                tool_calls_recorded.append(call)
                history.append(
                    ChatMessage(
                        role="tool",
                        name=ptc.name,
                        tool_call_id=str(call.id),
                        content=obs,
                    )
                )
                if call.status != ToolCallStatus.succeeded:
                    success = False
                    failed_call = ptc
            if success:
                return True
        return False

    async def _mark_step(
        self, session_id: UUID, plan: Plan, idx: int, status: PlanStepStatus
    ) -> None:
        step: PlanStep = plan.steps[idx]
        step.status = status
        step.done = status == PlanStepStatus.done
        self.repo.save_plan(session_id, plan)
        await self._emit(
            session_id, PlanStepEvent(session_id=session_id, seq=0, step=step)
        )

    async def _emit(self, session_id: UUID, event) -> None:
        seq = self.bus.next_seq(session_id)
        # Pydantic event models are frozen via _Base; recreate with the seq.
        data = event.model_dump()
        data["seq"] = seq
        # Stamp the owning run id so the frontend can correlate every event to
        # the run that produced it (Requirements 1.2, 1.7). `next_seq` remains
        # the sole monotonic seq source — run_id is orthogonal. Never clobber a
        # run_id an event already set explicitly.
        if data.get("run_id") is None and self._run_id is not None:
            data["run_id"] = self._run_id
        rebuilt = event.__class__.model_validate(data)
        self.repo.append_event(session_id, seq, rebuilt.type, data)
        await self.bus.publish(rebuilt)
