"""Replit-style plan/task workflow.

This layer wraps the existing coding-agent orchestrator with product-level
objects: plan drafts, task cards, isolated task workspaces, logs, diffs,
validation, checkpoints and apply/dismiss controls. The main workspace is not
changed until a ready task is explicitly applied.
"""

from __future__ import annotations

import asyncio
import difflib
import fnmatch
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID, uuid4

from shared_schema.models import (
    PermissionScope,
    ReplitCheckpoint,
    ReplitPlan,
    ReplitPlanStatus,
    ReplitTask,
    ReplitTaskLog,
    ReplitTaskPriority,
    ReplitTaskStatus,
)

from ..permissions import PermissionDenied
from ..state import AppState
from .orchestrator import OrchestratorConfig

_IGNORE_DIRS = {
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    ".next",
    ".nuxt",
    "dist",
    "build",
    "target",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".venv",
    "venv",
    ".agent",
    ".llama-studio-agent",
}
_IGNORE_FILES = {"*.pyc", "*.pyo", "*.sqlite", "*.sqlite3", "*.db", "*.log"}
_MAX_TEXT_FILE_BYTES = 512_000
_MAX_VALIDATION_OUTPUT = 24_000
_MAX_REPAIR_ATTEMPTS = 2
_TASK_RUN_SCOPES = {
    PermissionScope.read_fs,
    PermissionScope.write_fs,
    PermissionScope.run_command,
}
_TASK_SYSTEM_PROMPT = (
    "You are the execution worker for a Replit-style coding task. You are already "
    "inside an isolated copy of the user's workspace. Do not only explain or draft "
    "a plan. Inspect files, then create or modify real files with tools. Keep work "
    "focused on the task card. Use write_file or apply_patch for file changes and "
    "run_command for lightweight validation. The main workspace is protected; this "
    "task workspace will be reviewed as a diff before apply."
)

_ALLOWED_TRANSITIONS: dict[ReplitTaskStatus, set[ReplitTaskStatus]] = {
    ReplitTaskStatus.draft: {ReplitTaskStatus.queued, ReplitTaskStatus.active, ReplitTaskStatus.cancelled},
    ReplitTaskStatus.queued: {ReplitTaskStatus.active, ReplitTaskStatus.cancelled},
    ReplitTaskStatus.active: {ReplitTaskStatus.ready, ReplitTaskStatus.failed, ReplitTaskStatus.cancelled},
    ReplitTaskStatus.ready: {ReplitTaskStatus.done, ReplitTaskStatus.dismissed},
    ReplitTaskStatus.failed: {ReplitTaskStatus.queued, ReplitTaskStatus.active, ReplitTaskStatus.dismissed, ReplitTaskStatus.cancelled},
    ReplitTaskStatus.done: set(),
    ReplitTaskStatus.dismissed: set(),
    ReplitTaskStatus.cancelled: set(),
}


@dataclass(slots=True)
class TaskWorkspace:
    task: ReplitTask
    workspace: Path


@dataclass(slots=True)
class ValidationCommand:
    label: str
    cmd: list[str]
    cwd: Path


@dataclass(slots=True)
class ValidationResult:
    label: str
    command: str
    exit_code: int
    output: str

    @property
    def passed(self) -> bool:
        return self.exit_code == 0


class _TaskWorkspacePermissions:
    """Allow tool scopes only for the isolated task workspace run.

    The normal session permission manager is intentionally not mutated here:
    approving a Replit-style plan should let the task worker edit its copied
    workspace and run validation, but it should not silently unlock write/run
    access for unrelated free-form chat turns in the main workspace.
    """

    def __init__(self, delegate) -> None:  # type: ignore[no-untyped-def]
        self.delegate = delegate

    def has(self, session_id: UUID, scope: PermissionScope) -> bool:
        if scope in _TASK_RUN_SCOPES:
            return True
        return bool(self.delegate and self.delegate.has(session_id, scope))

    def require(self, session_id: UUID, scope: PermissionScope) -> None:
        if scope in _TASK_RUN_SCOPES:
            return
        if self.delegate:
            self.delegate.require(session_id, scope)
            return
        raise PermissionDenied(f"missing permission: {scope.value}")

    def allow_tool(self, session_id: UUID, tool: str, *, consume: bool = True) -> bool:
        if not self.delegate:
            return False
        return bool(self.delegate.allow_tool(session_id, tool, consume=consume))


class ReplitWorkflowService:
    def __init__(self, state: AppState) -> None:
        self.state = state
        self._running: set[UUID] = set()
        self._background_tasks: set[asyncio.Task[None]] = set()

    def create_plan(self, *, session_id: UUID, prompt: str) -> ReplitPlan:
        cleaned = " ".join(prompt.strip().split()) or "Build requested agent workflow"
        title = _title_from_prompt(cleaned)
        plan = ReplitPlan(
            session_id=session_id,
            title=title,
            summary=(
                "Auto agent run: inspect the request, change real files in an isolated copy, "
                "run validation, then present the result in chat for review."
            ),
        )
        specs = _task_specs(cleaned)
        previous: UUID | None = None
        for idx, spec in enumerate(specs, start=1):
            task = ReplitTask(
                session_id=session_id,
                plan_id=plan.id,
                title=spec["title"],
                summary=spec["summary"],
                priority=ReplitTaskPriority.high if idx <= 2 else ReplitTaskPriority.medium,
                depends_on=[previous] if previous else [],
                files_likely_changed=list(spec["files"]),
                done_looks_like=list(spec["done"]),
                test_plan=list(spec["tests"]),
            )
            previous = task.id
            plan.tasks.append(task)
        self.state.repo.save_replit_plan(plan)
        self._log_many(
            [ReplitTaskLog(task_id=t.id, message=f"Drafted from plan: {plan.title}") for t in plan.tasks]
        )
        return plan

    def revise_plan(self, *, session_id: UUID, plan_id: UUID, prompt: str) -> ReplitPlan:
        existing = self.state.repo.get_replit_plan(session_id, plan_id)
        if existing is None:
            raise KeyError("plan not found")
        if existing.status != ReplitPlanStatus.draft:
            raise ValueError("only draft plans can be revised")
        revised = self.create_plan(session_id=session_id, prompt=prompt)
        revised.title = f"Revision: {revised.title}"
        revised.summary = f"Revised from plan {existing.id}: {revised.summary}"
        self.state.repo.save_replit_plan(revised)
        existing.status = ReplitPlanStatus.archived
        self.state.repo.save_replit_plan(existing)
        return revised

    def approve_plan(self, *, session_id: UUID, plan_id: UUID) -> ReplitPlan:
        plan = self.state.repo.get_replit_plan(session_id, plan_id)
        if plan is None:
            raise KeyError("plan not found")
        if plan.status == ReplitPlanStatus.archived:
            raise ValueError("archived plans cannot be approved")
        plan.status = ReplitPlanStatus.approved
        for task in plan.tasks:
            if task.status == ReplitTaskStatus.draft:
                self._transition(task, ReplitTaskStatus.queued, "Plan approved; task queued.")
        self.state.repo.save_replit_plan(plan)
        return self.state.repo.get_replit_plan(session_id, plan_id) or plan

    def create_task(self, *, session_id: UUID, task: ReplitTask) -> ReplitTask:
        task.session_id = session_id
        self.state.repo.save_replit_task(task)
        self.log(task.id, "info", "Task created as draft.")
        return task

    def queue_task(self, *, session_id: UUID, task_id: UUID) -> ReplitTask:
        task = self._get_task(session_id, task_id)
        self._transition(task, ReplitTaskStatus.queued, "Task queued.")
        return task

    async def start_task(self, *, session_id: UUID, task_id: UUID) -> ReplitTask:
        task = self._get_task(session_id, task_id)
        if task.status == ReplitTaskStatus.active:
            return task
        if task.status not in {ReplitTaskStatus.draft, ReplitTaskStatus.queued, ReplitTaskStatus.failed}:
            raise ValueError(f"cannot start task from {task.status.value}")
        if task_id not in self._running:
            runner = asyncio.create_task(self._run_task(session_id=session_id, task_id=task_id))
            self._background_tasks.add(runner)
            runner.add_done_callback(self._background_tasks.discard)
        self._transition(task, ReplitTaskStatus.active, "Task started in isolated workspace.")
        return task

    async def _run_task(self, *, session_id: UUID, task_id: UUID) -> None:
        if task_id in self._running:
            return
        self._running.add(task_id)
        try:
            task = self.state.repo.get_replit_task(session_id, task_id)
            session = self.state.repo.get_session(session_id)
            if task is None or session is None:
                return
            task.error = None
            task.diff = None
            task.test_output = None
            self._transition(task, ReplitTaskStatus.active, "Creating isolated task workspace.", allow_same=True)
            tw = self.prepare_workspace(task, session.workspace_root)
            await self._run_agent_once(session_id=session_id, task=tw.task, workspace=tw.workspace)
            task = self.state.repo.get_replit_task(session_id, task_id) or task
            if task.status == ReplitTaskStatus.cancelled:
                self.log(task.id, "warning", "Task runner stopped after cancellation.")
                return
            await self._validate_repair_loop(session_id=session_id, task=task, workspace=tw.workspace)
        finally:
            self._running.discard(task_id)

    async def _run_agent_once(self, *, session_id: UUID, task: ReplitTask, workspace: Path) -> None:
        self.log(task.id, "info", "Running agent runtime inside task workspace.")
        session = self.state.repo.get_session(session_id)
        if session is None:
            raise KeyError("session not found")
        try:
            provider, model = self.state.providers.resolve(
                session.provider or self.state.settings.default_provider,
                session.model or self.state.settings.default_model,
            )
            indexer = self.state.indexer_for(session.id, str(workspace))
            from .orchestrator import AgentOrchestrator

            orch = AgentOrchestrator(
                provider=provider,
                model=model.model_id,
                registry=self.state.tools,
                repo=self.state.repo,
                bus=self.state.bus,
                indexer=indexer,
                permissions=_TaskWorkspacePermissions(self.state.permissions),
                approvals=self.state.approvals,
                recall_service=self.state.recall,
            )
            await asyncio.wait_for(
                orch.run(
                    session_id=session_id,
                    workspace_root=str(workspace),
                    prompt=_task_prompt(task),
                    config=OrchestratorConfig(
                        system_prompt=_TASK_SYSTEM_PROMPT,
                        skip_planner=True,
                        max_repair_attempts=2,
                        working_memory_window=12,
                    ),
                    record_prompt=False,
                ),
                timeout=900,
            )
        except Exception as exc:
            self.log(task.id, "warning", f"Agent runtime ended with warning: {exc}")

    async def _validate_repair_loop(self, *, session_id: UUID, task: ReplitTask, workspace: Path) -> ReplitTask:
        session = self.state.repo.get_session(session_id)
        if session is None:
            raise KeyError("session not found")
        source = Path(session.workspace_root).expanduser().resolve()
        attempts = 0
        no_diff_retries = 0
        while True:
            diff = build_workspace_diff(source, workspace)
            task.diff = diff
            if not diff.strip():
                no_diff_retries += 1
                if no_diff_retries > 1:
                    # Already retried once — fail definitively.
                    task.error = "Task produced no file diff. Revise the task or start it again."
                    task.test_output = "NO ERROR was not reached: no diff was produced."
                    self._transition(task, ReplitTaskStatus.failed, task.error, allow_same=True)
                    return task
                # Give the agent one more attempt with a stronger prompt.
                self.log(task.id, "warning", "No file changes detected. Retrying with explicit instructions.")
                retry_task = task.model_copy(
                    update={
                        "summary": (
                            f"{task.summary}\n\n"
                            "IMPORTANT: The previous attempt produced NO file changes. "
                            "You MUST use write_file or apply_patch to create or modify at least one file. "
                            "Do not just describe what to do — actually write the code."
                        )
                    }
                )
                await self._run_agent_once(session_id=session_id, task=retry_task, workspace=workspace)
                task = self.state.repo.get_replit_task(session_id, task.id) or task
                if task.status == ReplitTaskStatus.cancelled:
                    return task
                continue
            task.validation_attempts = (task.validation_attempts or 0) + 1
            self.state.repo.save_replit_task(task)
            results = run_validation_suite(workspace)
            self._log_validation_results(task.id, results, attempt=task.validation_attempts)
            task.test_output = format_validation_results(results)
            if all(r.passed for r in results):
                task.error = None
                self._transition(task, ReplitTaskStatus.ready, "NO ERROR: validation passed and diff is ready.")
                return task
            failed = [r for r in results if not r.passed]
            task.error = failed[0].output.splitlines()[-1][:300] if failed[0].output.strip() else f"{failed[0].label} failed"
            self.state.repo.save_replit_task(task)
            self.log(task.id, "error", f"Validation failed: {failed[0].label}. Repair attempt {attempts + 1}/{_MAX_REPAIR_ATTEMPTS}.")
            if attempts >= _MAX_REPAIR_ATTEMPTS:
                self._transition(task, ReplitTaskStatus.failed, "Validation failed after repair attempts.", allow_same=True)
                return task
            attempts += 1
            await self._run_agent_once(
                session_id=session_id,
                task=_task_for_repair(task, format_validation_results(failed)),
                workspace=workspace,
            )

    def _log_validation_results(
        self, task_id: UUID, results: list[ValidationResult], *, attempt: int
    ) -> None:
        for result in results:
            level = "info" if result.passed else "error"
            tag = "PASS" if result.passed else "FAIL"
            header = f"[{tag}] {result.label} (exit={result.exit_code}) attempt={attempt}: {result.command}"
            if not result.passed and result.output.strip():
                first_line = next(
                    (line for line in result.output.splitlines() if line.strip()),
                    "",
                )
                if first_line:
                    header = f"{header} — {first_line[:240]}"
            self.log(task_id, level, header)

    def prepare_workspace(self, task: ReplitTask, workspace_root: str) -> TaskWorkspace:
        source = Path(workspace_root).expanduser().resolve()
        if not source.exists() or not source.is_dir():
            raise FileNotFoundError(f"workspace not found: {source}")
        base = source / ".llama-studio-agent" / "tasks" / str(task.id)
        workspace = base / "workspace"
        if workspace.exists():
            shutil.rmtree(workspace)
        workspace.parent.mkdir(parents=True, exist_ok=True)
        copy_workspace(source, workspace)
        task.workspace_path = str(workspace)
        self.state.repo.save_replit_task(task)
        self.log(task.id, "info", f"Isolated workspace ready: {workspace}")
        return TaskWorkspace(task=task, workspace=workspace)

    def mark_ready(self, *, session_id: UUID, task_id: UUID) -> ReplitTask:
        task = self._get_task(session_id, task_id)
        if not task.diff or not task.test_output or "NO ERROR" not in task.test_output:
            raise ValueError("task cannot be marked ready until diff and clean validation exist")
        self._transition(task, ReplitTaskStatus.ready, "Task marked ready after validation.")
        return task

    def apply_task(self, *, session_id: UUID, task_id: UUID) -> ReplitTask:
        task = self._get_task(session_id, task_id)
        session = self.state.repo.get_session(session_id)
        if session is None:
            raise KeyError("session not found")
        if task.status != ReplitTaskStatus.ready:
            raise ValueError("task is not ready to apply")
        if not task.workspace_path:
            raise ValueError("task has no isolated workspace")
        source = Path(session.workspace_root).expanduser().resolve()
        work = Path(task.workspace_path).expanduser().resolve()
        changed = changed_files(source, work)
        checkpoint = create_checkpoint(source, session_id=session_id, task_id=task.id, files=changed)
        self.state.repo.save_replit_checkpoint(checkpoint)
        for rel in changed:
            src = work / rel
            dst = source / rel
            if src.exists() and src.is_file():
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
            elif dst.exists() and dst.is_file():
                dst.unlink()
        self._transition(task, ReplitTaskStatus.done, f"Applied {len(changed)} file(s) to main workspace.")
        task.error = None
        self.state.repo.save_replit_task(task)
        return task

    def dismiss_task(self, *, session_id: UUID, task_id: UUID) -> ReplitTask:
        task = self._get_task(session_id, task_id)
        if task.status not in {ReplitTaskStatus.ready, ReplitTaskStatus.failed}:
            raise ValueError("only ready or failed tasks can be dismissed")
        self._transition(task, ReplitTaskStatus.dismissed, "Task dismissed; main workspace unchanged.")
        return task

    def cancel_task(self, *, session_id: UUID, task_id: UUID) -> ReplitTask:
        task = self._get_task(session_id, task_id)
        if task.status not in {ReplitTaskStatus.draft, ReplitTaskStatus.queued, ReplitTaskStatus.active, ReplitTaskStatus.failed}:
            raise ValueError(f"cannot cancel task from {task.status.value}")
        self._transition(task, ReplitTaskStatus.cancelled, "Task cancelled by user.")
        return task

    def rollback_checkpoint(self, *, session_id: UUID, checkpoint_id: UUID) -> ReplitCheckpoint:
        checkpoint = self.state.repo.get_replit_checkpoint(session_id, checkpoint_id)
        session = self.state.repo.get_session(session_id)
        if checkpoint is None or session is None:
            raise KeyError("checkpoint not found")
        root = Path(session.workspace_root).expanduser().resolve()
        snap = Path(checkpoint.snapshot_path).expanduser().resolve()
        for rel in checkpoint.files:
            src = snap / rel
            dst = root / rel
            if src.exists() and src.is_file():
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
            elif dst.exists() and dst.is_file():
                dst.unlink()
        return checkpoint

    def log(self, task_id: UUID, level: str, message: str) -> ReplitTaskLog:
        log = ReplitTaskLog(task_id=task_id, level=level, message=message)  # type: ignore[arg-type]
        return self.state.repo.append_replit_task_log(log)

    def _get_task(self, session_id: UUID, task_id: UUID) -> ReplitTask:
        task = self.state.repo.get_replit_task(session_id, task_id)
        if task is None:
            raise KeyError("task not found")
        return task

    def _transition(
        self,
        task: ReplitTask,
        next_status: ReplitTaskStatus,
        message: str,
        *,
        allow_same: bool = False,
    ) -> None:
        if task.status == next_status and allow_same:
            self.state.repo.save_replit_task(task)
            self.log(task.id, "info", message)
            return
        allowed = _ALLOWED_TRANSITIONS[task.status]
        if next_status not in allowed:
            raise ValueError(f"invalid task transition: {task.status.value} → {next_status.value}")
        task.status = next_status
        self.state.repo.save_replit_task(task)
        self.log(task.id, "info" if next_status != ReplitTaskStatus.failed else "error", message)

    def _log_many(self, logs: list[ReplitTaskLog]) -> None:
        for log in logs:
            self.state.repo.append_replit_task_log(log)


def _title_from_prompt(prompt: str) -> str:
    words = prompt[:80].strip().strip(".!?")
    return words[0].upper() + words[1:] if words else "Agent build plan"


def _task_specs(prompt: str) -> list[dict[str, object]]:
    lowered = prompt.lower()
    website = any(
        k in lowered
        for k in [
            "website",
            "web app",
            "webapp",
            "portfolio",
            "landing page",
            "site",
            "homepage",
            "frontend app",
        ]
    )
    agent_workflow = any(k in lowered for k in ["replit", "agent flow", "agent workflow", "task board", "sidecar"])
    if website:
        subject = "portfolio website" if "portfolio" in lowered else "web application"
        return [
            {
                "title": f"Build and validate the {subject}",
                "summary": (
                    "Run the request end to end like a single agent job: inspect the current project, "
                    "choose the existing frontend stack when present, create or update the needed files, "
                    f"build polished user-facing screens and interactions, then validate the result. Request: {prompt}"
                ),
                "files": [
                    "package.json",
                    "src",
                    "src/App.tsx",
                    "src/main.tsx",
                    "src/styles.css",
                    "public",
                    "index.html",
                    "style.css",
                    "vite.config.ts",
                    "README.md",
                ],
                "done": [
                    "The app has an entry point and runnable project structure",
                    "The first screen is the actual usable app/site, not a placeholder",
                    "Content matches the user's requested domain",
                    "Primary workflow can be used end to end",
                    "Layout works on desktop and mobile widths",
                    "Validation output contains NO ERROR",
                    "Diff is reviewable before applying to the main workspace",
                ],
                "tests": [
                    "Project files exist",
                    "Frontend typecheck or build passes",
                    "Generated app opens without runtime errors",
                ],
            },
        ]

    if agent_workflow:
        return [
            {
                "title": "Implement the requested agent workflow end to end",
                "summary": (
                    "Implement the requested agent workflow as one continuous change, keeping the UI simple and "
                    "chat-first while preserving isolated execution and validation."
                ),
                "files": [
                    "apps/frontend/src/lib/store.ts",
                    "apps/frontend/src/features/agent",
                    "apps/frontend/src/features/tasks",
                    "services/agent/src/llama_studio_agent/agent/replit_workflow.py",
                    "scripts",
                    "tests",
                ],
                "done": [
                    "Implementation prompts run from the chat without opening a separate task board",
                    "Task workers can write files in the isolated workspace",
                    "Normal chat permissions remain unchanged",
                    "Release packaging still includes all runtime binaries",
                ],
                "tests": ["Frontend store tests pass", "Backend workflow tests pass", "Package smoke test passes"],
            },
        ]

    specs: list[dict[str, object]] = [
        {
            "title": "Implement the requested files and behavior",
            "summary": (
                "Create or modify the concrete files needed for the request, using the existing project "
                f"patterns and minimal scope. Request: {prompt}"
            ),
            "files": ["README.md", "package.json", "pyproject.toml", "src", "apps", "services", "tests"],
            "done": [
                "The requested workflow is usable",
                "No placeholder-only implementation remains",
                "Errors are surfaced clearly",
                "Diff is reviewable before applying to the main workspace",
            ],
            "tests": ["Relevant unit/type/build checks pass", "Discovered validation suite reports NO ERROR"],
        },
    ]
    return specs


def _task_prompt(task: ReplitTask) -> str:
    return "\n".join(
        [
            f"Task: {task.title}",
            task.summary,
            "",
            "Done looks like:",
            *[f"- {x}" for x in task.done_looks_like],
            "",
            "Likely files:",
            *[f"- {x}" for x in task.files_likely_changed],
            "",
            "Rules:",
            "- This is an execution task, not a planning-only task.",
            "- Produce concrete file changes with write_file or apply_patch when implementation is requested.",
            "- Work only inside the current task workspace.",
            "- Keep changes focused to this task.",
            "- Prefer the existing project stack and scripts over inventing a new framework.",
            "- Do not claim success until validation output says NO ERROR.",
            "- If the request is ambiguous, write the clarification needed into the task output instead of guessing.",
        ]
    )


def _task_for_repair(task: ReplitTask, validation_output: str) -> ReplitTask:
    return task.model_copy(
        update={
            "summary": "\n".join(
                [
                    task.summary,
                    "",
                    "Validation failed. Inspect the exact file/line errors below, fix the workspace, and rerun validation.",
                    validation_output[-8000:],
                ]
            )
        }
    )


def discover_validation_commands(root: Path) -> list[ValidationCommand]:
    """Pick the strongest real validation commands for this project layout.

    Prefers `uv run pytest`, `ruff check`, and per-package `pnpm --filter`
    commands derived from `pnpm-workspace.yaml` so task readiness reflects the
    project's actual checks rather than a generic compile pass.
    """

    commands: list[ValidationCommand] = []
    uv_available = shutil.which("uv") is not None

    # ── JavaScript / TypeScript ────────────────────────────────────────
    has_root_pkg = (root / "package.json").exists()
    has_nested_pkg = (root / "apps" / "frontend" / "package.json").exists()
    if has_root_pkg or has_nested_pkg:
        runner = "pnpm" if (root / "pnpm-lock.yaml").exists() or (root / "pnpm-workspace.yaml").exists() else "npm"
        ws_packages = _discover_pnpm_workspace_packages(root) if runner == "pnpm" else []
        added_filtered = False
        for pkg_name, scripts in ws_packages:
            for script in ("typecheck", "test", "build"):
                if script in scripts:
                    commands.append(
                        ValidationCommand(
                            f"{pkg_name} {script}",
                            ["pnpm", "--filter", pkg_name, script],
                            root,
                        )
                    )
                    added_filtered = True
        if not added_filtered:
            if runner == "pnpm":
                commands.append(ValidationCommand("TypeScript", ["pnpm", "typecheck"], root))
                commands.append(
                    ValidationCommand(
                        "Frontend build",
                        ["pnpm", "--filter", "@llama-studio/frontend", "build"],
                        root,
                    )
                )
            else:
                commands.append(ValidationCommand("TypeScript", ["npm", "run", "typecheck"], root))
                commands.append(ValidationCommand("Frontend build", ["npm", "run", "build"], root))

    # ── Python ─────────────────────────────────────────────────────────
    pyproject = root / "pyproject.toml"
    nested_pyproject = root / "services" / "agent" / "pyproject.toml"
    if pyproject.exists() or nested_pyproject.exists():
        if uv_available:
            commands.append(
                ValidationCommand(
                    "Python tests",
                    ["uv", "run", "pytest", "services/agent/tests"],
                    root,
                )
            )
        else:
            commands.append(
                ValidationCommand(
                    "Python tests",
                    ["python", "-m", "pytest", "services/agent/tests"],
                    root,
                )
            )
        commands.append(
            ValidationCommand(
                "Python compile",
                ["python", "-m", "compileall", "services", "packages"],
                root,
            )
        )
        if _has_ruff_config(pyproject if pyproject.exists() else nested_pyproject):
            ruff_cmd = (
                ["uv", "run", "ruff", "check", "services", "packages"]
                if uv_available
                else ["ruff", "check", "services", "packages"]
            )
            commands.append(ValidationCommand("Ruff lint", ruff_cmd, root))
    elif any(root.glob("**/*.py")):
        commands.append(ValidationCommand("Python compile", ["python", "-m", "compileall", "."], root))

    # ── Rust / Tauri ───────────────────────────────────────────────────
    if (root / "Cargo.toml").exists() or (root / "src-tauri" / "Cargo.toml").exists():
        commands.append(ValidationCommand("Rust/Tauri check", ["cargo", "check", "--workspace"], root))

    # ── Packaging smoke ────────────────────────────────────────────────
    if (root / "scripts" / "verify_zip.py").exists():
        commands.append(ValidationCommand("Startup smoke", ["python", "scripts/verify_zip.py", "--help"], root))

    if not commands:
        commands.append(ValidationCommand("Python compile", ["python", "-m", "compileall", "."], root))
    return commands


def _discover_pnpm_workspace_packages(root: Path) -> list[tuple[str, set[str]]]:
    """Return `(package_name, scripts)` for each package listed in `pnpm-workspace.yaml`.

    Best-effort: missing/garbled YAML and package.json files are skipped silently
    so discovery never crashes the workflow.
    """

    workspace_file = root / "pnpm-workspace.yaml"
    if not workspace_file.exists():
        return []
    try:
        raw = workspace_file.read_text(encoding="utf-8")
    except OSError:
        return []
    patterns: list[str] = []
    in_packages = False
    for line in raw.splitlines():
        stripped = line.strip()
        if stripped.startswith("packages:"):
            in_packages = True
            continue
        if in_packages:
            if stripped.startswith("- "):
                value = stripped[2:].strip().strip("'\"")
                if value:
                    patterns.append(value)
            elif stripped and not stripped.startswith("#") and not stripped.startswith("- "):
                in_packages = False
    out: list[tuple[str, set[str]]] = []
    for pattern in patterns:
        for pkg_dir in sorted(root.glob(pattern)):
            pkg_json = pkg_dir / "package.json"
            if not pkg_json.is_file():
                continue
            try:
                import json as _json

                data = _json.loads(pkg_json.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            name = data.get("name")
            if not isinstance(name, str):
                continue
            scripts = data.get("scripts") or {}
            script_names = {k for k in scripts if isinstance(k, str)}
            out.append((name, script_names))
    return out


def _has_ruff_config(pyproject: Path) -> bool:
    if not pyproject.is_file():
        return False
    try:
        text = pyproject.read_text(encoding="utf-8")
    except OSError:
        return False
    return "[tool.ruff" in text


def run_validation_suite(root: Path) -> list[ValidationResult]:
    results: list[ValidationResult] = []
    for spec in discover_validation_commands(root):
        rendered = " ".join(spec.cmd)
        if shutil.which(spec.cmd[0]) is None:
            results.append(ValidationResult(spec.label, rendered, 127, f"SKIPPED: executable not found: {spec.cmd[0]}"))
            continue
        try:
            completed = subprocess.run(
                spec.cmd,
                cwd=spec.cwd,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=180,
                check=False,
            )
            output = (completed.stdout or "")[-_MAX_VALIDATION_OUTPUT:]
            results.append(ValidationResult(spec.label, rendered, completed.returncode, output))
        except subprocess.TimeoutExpired as exc:
            output = ((exc.stdout or "") if isinstance(exc.stdout, str) else "")[-_MAX_VALIDATION_OUTPUT:]
            results.append(ValidationResult(spec.label, rendered, 124, output + "\nTIMEOUT"))
    return results


def format_validation_results(results: list[ValidationResult]) -> str:
    if not results:
        return "NO ERROR\nNo validation commands were discovered."
    lines = []
    all_passed = all(r.passed for r in results)
    lines.append("NO ERROR" if all_passed else "ERROR")
    for result in results:
        status = "PASS" if result.passed else "FAIL"
        lines.append(f"\n[{status}] {result.label}")
        lines.append(f"$ {result.command}")
        lines.append(f"exit_code={result.exit_code}")
        if result.output.strip():
            lines.append(result.output.strip())
    return "\n".join(lines).strip()


def copy_workspace(source: Path, dest: Path) -> None:
    def ignore(_dirpath: str, names: list[str]) -> set[str]:
        ignored: set[str] = set()
        for name in names:
            if name in _IGNORE_DIRS:
                ignored.add(name)
                continue
            if any(fnmatch.fnmatch(name, pat) for pat in _IGNORE_FILES):
                ignored.add(name)
        return ignored

    shutil.copytree(source, dest, ignore=ignore)


def _is_text(path: Path) -> bool:
    try:
        if path.stat().st_size > _MAX_TEXT_FILE_BYTES:
            return False
        path.read_text(encoding="utf-8")
        return True
    except Exception:
        return False


def iter_files(root: Path) -> list[Path]:
    out: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _IGNORE_DIRS]
        for filename in filenames:
            if any(fnmatch.fnmatch(filename, pat) for pat in _IGNORE_FILES):
                continue
            path = Path(dirpath) / filename
            if path.is_file():
                out.append(path.relative_to(root))
    return sorted(out, key=lambda p: str(p))


def changed_files(base: Path, work: Path) -> list[str]:
    rels = set(iter_files(base)) | set(iter_files(work))
    changed: list[str] = []
    for rel in sorted(rels, key=lambda p: str(p)):
        a = base / rel
        b = work / rel
        if not b.exists():
            changed.append(str(rel))
            continue
        if not a.exists() or (a.is_file() and b.is_file() and a.read_bytes() != b.read_bytes()):
            changed.append(str(rel))
    return changed


def build_workspace_diff(base: Path, work: Path) -> str:
    hunks: list[str] = []
    for rel_s in changed_files(base, work):
        rel = Path(rel_s)
        a = base / rel
        b = work / rel
        before = a.read_text(encoding="utf-8").splitlines(keepends=True) if a.exists() and _is_text(a) else []
        if not b.exists():
            after: list[str] = []
        elif not _is_text(b):
            hunks.append(f"Binary or large file changed: {rel_s}\n")
            continue
        else:
            after = b.read_text(encoding="utf-8").splitlines(keepends=True)
        hunks.extend(
            difflib.unified_diff(
                before,
                after,
                fromfile=f"a/{rel_s}",
                tofile=f"b/{rel_s}",
                lineterm="",
            )
        )
        hunks.append("\n")
    return "\n".join(hunks).strip()


def create_checkpoint(root: Path, *, session_id: UUID, task_id: UUID, files: list[str]) -> ReplitCheckpoint:
    cid = uuid4()
    snap = root / ".llama-studio-agent" / "checkpoints" / str(cid)
    snap.mkdir(parents=True, exist_ok=True)
    for rel in files:
        src = root / rel
        if src.exists() and src.is_file():
            dst = snap / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
    return ReplitCheckpoint(
        id=cid,
        session_id=session_id,
        task_id=task_id,
        label="Before applying task changes",
        snapshot_path=str(snap),
        files=files,
    )
