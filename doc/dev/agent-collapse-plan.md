# Dual-System Collapse — Migration Plan

## STATUS: ✅ COMPLETE (Replit subsystem deleted)

The legacy Replit planning subsystem has been **fully removed**. Backend:
`agent/replit_workflow.py`, `v1/replit_workflow.py`, `tests/test_replit_workflow.py`
deleted; validation extracted to `agent/validation.py`, FS primitives to
`agent/workspace_diff.py`; repository methods + DDL + shared-schema `Replit*`
models (Python + TS) removed. Frontend: all `replit*` store state/actions,
client methods, `TaskBoard`/`TaskWorkspacePanel`, the `tasks` view, and related
tests removed. The unified isolated-run flow (`zoc_run` + `AgentRunCard` +
`DiffReviewCard`) is the single agent path. Verified: backend 189 / frontend
115 tests green, `tsc` + `ruff` clean, zero `Replit` references in source.

The remainder of this document is kept for historical context.

---

## Why this existed

The agent has two overlapping systems (see `AGENT_REDESIGN_PLAN.md` Part 1):

- **Legacy planning layer** — `ReplitPlan` / `ReplitTask`, `_task_specs`,
  `_run_task`, the `/v1/.../replit/plans|tasks` routes, and the frontend
  `TaskBoard` / `TaskWorkspacePanel` / `replitPlans` store slice. A CRUD
  pre-planning system that emits fixed templated steps before the LLM runs.
- **New unified run** — the orchestrator's live to-do loop + the isolated
  review-before-apply flow (`zoc_run.py`). This is the model we're keeping.

The redesign goal is to **collapse the legacy layer into the new run** and
delete it. The four historical bugs all stem from the two systems pretending to
be one.

## Status

**Done — decoupling step (this session):** the shared workspace filesystem
primitives (`copy_workspace`, `iter_files`, `changed_files`,
`build_workspace_diff`) were extracted from `replit_workflow.py` into the
neutral `agent/workspace_diff.py`. The new isolation flow (`zoc_run.py`) now
imports them from there, so it no longer depends on the legacy module for
filesystem logic. `replit_workflow.py` re-imports them for its own internal use.

This matters because **`zoc_run` previously imported its core primitives from
`replit_workflow`** — meaning the legacy module could not be deleted without
breaking the new system. That coupling (for the FS primitives) is now removed.

## Remaining work (ordered, each independently shippable)

1. **Extract the validation suite.** `run_validation_suite`,
   `discover_validation_commands`, `ValidationResult`, `ValidationCommand`,
   `format_validation_results`, and `_discover_pnpm_workspace_packages` are
   still in `replit_workflow.py` and used by both `zoc_run` and
   `tools/workspace.py`. Move them to a `agent/validation.py` module and update
   the three importers. After this, `replit_workflow.py` contains *only* the
   legacy planning logic.

2. **Dogfood the new path.** Confirm the isolated-run + review/apply/discard
   flow is the default for agent-mode runs (`reviewChanges: true`) and that the
   UI no longer needs `ReplitPlan`/`ReplitTask` for any user-facing flow.

3. **Remove the backend planning layer.** Delete `ReplitWorkflowService`
   (`_task_specs`, `_run_task`, plan/task CRUD) from `replit_workflow.py`, the
   `v1/replit_workflow.py` router (and its registration in `v1/router.py`), and
   the `replit/plans|tasks` persistence methods in `repository.py`. Remove
   `ReplitPlan`/`ReplitTask`/`ReplitTaskLog`/`ReplitCheckpoint` from the shared
   schema (`models.py` + regenerate TS) once nothing references them.

4. **Remove the legacy `agent.*` events** once the new `run.*` / `todo_update`
   / `diff.ready` events fully drive the UI. Update `applyAgentEvent` to drop
   the legacy handlers.

5. **Remove the frontend planning UI.** Delete `features/tasks/TaskBoard.tsx`,
   `TaskWorkspacePanel.tsx`, the `replitPlans`/`replitTasks` store slice and
   actions, and the related `slash-commands` / `event-ingest` branches.

6. **Delete the now-empty test surfaces** (`test_replit_workflow.py`) and prune
   `arbitraries.ts` / store tests that fabricate `ReplitPlan`/`ReplitTask`.

## Blast radius (for planning)

~23 files reference the legacy symbols: backend (`replit_workflow.py`,
`v1/replit_workflow.py`, `v1/router.py`, `repository.py`, `tools/workspace.py`,
`models.py`, `__init__.py`), shared TS (`index.ts`), and frontend (`store.ts`,
`AgentTimeline.tsx`, `TaskBoard.tsx`, `TaskWorkspacePanel.tsx`,
`slash-commands.ts`, `event-ingest.ts`, plus 4 test files).

**Do this incrementally, one numbered step per PR, keeping `make check` green
after each.** A single big-bang deletion will break the build and whole test
suites — the primitives extraction above was the prerequisite that makes the
incremental path possible.
