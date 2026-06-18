# Replit Agent-style workflow implementation

This patch adds a Replit Agent-style Plan → Task Board → Isolated Workspace → Review Diff → Apply/Dismiss flow on top of the existing Tauri + FastAPI + React agent architecture.

## Backend additions

- Added shared schema models for `ReplitPlan`, `ReplitTask`, `ReplitTaskLog`, `ReplitCheckpoint`, plan/task request models, task statuses and priorities.
- Added SQLite tables for Replit-style plans, tasks, task logs and checkpoints.
- Added repository CRUD helpers for plans, tasks, logs and checkpoints.
- Added `zoc_studio_agent.agent.replit_workflow.ReplitWorkflowService`.
- Added `/v1/sessions/{session_id}/replit/*` APIs:
  - `POST /plans`
  - `GET /plans`
  - `POST /plans/{plan_id}/approve`
  - `GET /tasks`
  - `POST /tasks`
  - `GET /tasks/{task_id}`
  - `POST /tasks/{task_id}/start`
  - `POST /tasks/{task_id}/apply`
  - `POST /tasks/{task_id}/dismiss`
  - `POST /tasks/{task_id}/cancel`
  - `GET /tasks/{task_id}/logs`
  - `GET /tasks/{task_id}/diff`
  - `GET /tasks/{task_id}/test-results`
  - `GET /checkpoints`
  - `POST /checkpoints/{checkpoint_id}/rollback`

## Frontend additions

- Added typed agent-client methods for all new Replit workflow APIs.
- Added Zustand state/actions for plans, tasks, selected task, task logs, checkpoints and errors.
- Added a Tasks activity sidebar item.
- Added `TaskBoard` and `TaskWorkspacePanel` UI.
- Added Agent → Tasks tab for Plan Mode, task board, diff, logs, validation and checkpoint rollback.

## Safety behavior

- Plan creation does not modify project files.
- Task execution works in `.zoc-studio-agent/tasks/{taskId}/workspace`.
- Main project files are not changed until the user clicks Apply.
- Applying a task creates a checkpoint under `.zoc-studio-agent/checkpoints/{checkpointId}`.
- Dismiss leaves the main workspace unchanged.
- Rollback restores checkpointed files.

## Validation performed in this environment

- Python compile check passed for new/modified backend and shared schema files.
- FastAPI route smoke test passed with a temporary `structlog` stub because the container environment did not have the project dependency installed.
- Full pytest could not run in this container because `structlog` was missing.
- Frontend TypeScript check could not run fully because the uploaded archive contained incomplete `node_modules` type packages (`@types/react`, `@types/react-dom`, `@types/node` were missing/empty in this environment).

## Deep bug-fix pass

Additional fixes applied after the first Replit workflow integration:

- Task board now shows every task state, including `failed`, `dismissed`, and `cancelled`, so tasks never disappear from the board after an error or user action.
- The task board grid now uses responsive auto-fit columns to avoid the cramped/broken five-column layout on narrow right panels.
- Task cards now surface task error messages directly on failed cards.
- ActivityBar now returns the main surface to the editor when the user clicks Files/Search/Indexer/Tasks after visiting Settings or Showcase.
- Browser-preview/offline mode now supports task start/apply/dismiss/cancel/rollback mock flows instead of throwing sidecar errors.
- Backend task diff/apply logic now supports deleted files, not only created/modified files.
- Rollback now removes files that did not exist at checkpoint time, so applying then rolling back a newly created file is safe.
- Cancelled background tasks no longer overwrite the cancelled state with ready/failed after the runner finishes.
- Applying a task is restricted to `ready` tasks only.

Validation performed in the sandbox:

- Python compile check passed for the sidecar and shared schema packages.
- TypeScript syntax-only check passed with `tsc --noCheck` because the uploaded archive does not contain a usable pnpm node_modules symlink tree.
- Isolated workflow file diff smoke test passed for modified, created, and deleted files.
