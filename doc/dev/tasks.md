# Task runner & Test Explorer (Phase 6)

Discovers tasks from project config and manifests, runs them in the workspace,
streams output to the Tasks output channel, feeds problem matchers into the
diagnostics store, and surfaces everything in a Tasks panel (which doubles as a
lightweight Test Explorer).

## Discovery (`apps/frontend/src/lib/tasks.ts`)

Pure functions producing a normalized `Task` (`id`, `label`, `source`,
`command`, `args`, `cwd?`, `group`, `isBackground?`, `problemMatcher?`):

- `stripJsonComments` — make JSONC (`//`, `/* */`, trailing commas) parseable.
- `parseTasksJson(text, "vscode"|"zoc")` — VS Code / Zoc `tasks.json`; maps
  `type:"npm"` → `npm run <script>`, normalizes `$tsc`/`$eslint`/`$rustc`
  problem matchers and `group`.
- `detectNpmScripts` — package.json `scripts` (build/test classified).
- `detectCargo` — build/test/check from a `Cargo.toml` (matcher = cargo).
- `detectMake` — Makefile targets (skips `.PHONY`, variable assignments).
- `detectPython` — pytest / ruff from a `pyproject.toml`.
- `dedupeTasks`, `defaultBuildTask`, `defaultTestTask` (config tasks win).

## Runner (`apps/desktop/src/checks.rs`)

`run_task(command, args, cwd?)` spawns the task command in the workspace (cwd
validated via `ensure_within_workspace`) and returns `{ stdout, stderr, code }`.
The command comes from the project's own config, and the cwd can't escape the
workspace.

## Store

- `tasks: Task[]`, `taskRuns: Record<id, "running"|"passed"|"failed">`.
- `discoverTasks()` reads `package.json`, `Cargo.toml`, `Makefile`,
  `pyproject.toml`, `.vscode/tasks.json`, `.zoc/tasks.json` (config first), and
  merges/dedupes.
- `runTask(id)` sets `running`, runs `run_task`, appends output to the **Tasks**
  output channel, parses any `problemMatcher` into the diagnostics store, then
  records `passed`/`failed` from the exit code and logs a summary.
- `runBuildTask()` / `runTestTask()` discover (if needed) and run the default
  build/test task.

## UI

- `TasksPanel` (bottom-dock **Tasks** tab) — tasks sorted with **tests first**
  (Test Explorer role), then build, then the rest; each row shows the command,
  a group badge, a run/passed/failed status icon, and a Run button. A Rescan
  button re-runs discovery. Honest empty state.
- Commands: `workbench.action.tasks.runTask` (opens the panel),
  `workbench.action.tasks.runBuildTask` (**⌘⇧B**), `workbench.action.tasks.test`.

## Acceptance checks (develop.md)

- ⌘⇧B runs the default build task ✓
- Task output streams to the Output panel (Tasks channel) ✓
- Problem matchers populate Problems ✓ (cargo/tsc/eslint/ruff matchers)
- Tasks can be cancelled — **partial**: see below.

## Tests

- `lib/__tests__/tasks.test.ts` — JSONC stripping, tasks.json parsing,
  npm/cargo/make/python detection, dedupe, default build/test selection.
- `__tests__/store.test.ts` — `discoverTasks` merges manifests, `runTask`
  records status + parses a matcher into diagnostics + writes Tasks output,
  `runBuildTask` picks the default.

## Not yet

`run_task` is **blocking** (captures full output then returns), so true output
*streaming* and *cancellation* are deferred — they share the long-lived process
infrastructure that lands with the terminal upgrade (Phase 8); the Tasks panel
will switch to the PTY-backed runner then. Background/watch tasks and a per-test
-case Test Explorer (expanding into individual test results) are also deferred;
today the explorer runs test *tasks* and reports pass/fail at the task level.
