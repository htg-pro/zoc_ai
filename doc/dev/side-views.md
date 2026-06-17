# Outline & Timeline Side Views (develop.md "Missing UI Checklist")

The remaining concrete Side Panel views from the Missing UI Checklist — Outline
and Timeline — plus the two missing Activity Bar entries (Extensions, Testing).

## What landed

| Piece | File |
|-------|------|
| Outline side view (symbols of the active file) | `apps/frontend/src/features/outline/OutlinePanel.tsx` |
| Timeline side view (commits + checkpoints) | `apps/frontend/src/features/timeline/TimelinePanel.tsx` |
| Pure timeline merge | `apps/frontend/src/lib/timeline.ts` |
| Activity Bar items + routing (Outline, Timeline, Extensions, Testing) | `apps/frontend/src/components/layout/ActivityBar.tsx` |
| Side panel wiring + titles | `apps/frontend/src/components/layout/SidePanel.tsx` |
| Commands `workbench.view.outline` / `workbench.view.timeline` | `apps/frontend/src/lib/commands.ts` |

## Outline

`OutlinePanel` reuses the Phase 9 offline outline extractor (`lib/outline.ts`,
TS/JS/Py/Rust/Go) to list the active file's symbols, with a filter box
(`filterOutline`) and click-to-jump via `revealLine`. It updates as the active
file or its content changes, and shows an empty state when no file is open.

## Timeline

`lib/timeline.ts` `buildTimeline(commits, checkpoints)` merges two real history
sources into one newest-first feed:

- **Git commits** — `store.loadGitLog(30)` (`GitCommit[]`; epoch-second
  timestamps converted to ms).
- **Agent checkpoints** — `store.checkpoints` (`CheckpointInfo[]`; ISO dates).

`TimelinePanel` renders the merged feed with relative timestamps; checkpoint
entries carry a `runId` and expose a Restore action (`restoreCheckpoint`).
Unparseable checkpoint dates sort to the end (ts = 0).

## Activity Bar

Added Outline (→ side view), Timeline (→ side view), Extensions (→ Settings →
Extensions, Phase 12), and Testing (→ tests-first Tasks panel in the bottom
dock, Phase 6). The full top group is now: Explorer, Search, Source Control,
Run and Debug, Testing, Extensions, Outline, Timeline, Indexer, Sessions.

## Tests

- `src/lib/__tests__/timeline.test.ts` (5) — merge order, field mapping
  (seconds→ms), checkpoint runId/subtitle, bad-date tolerance, empty inputs.
- `src/__tests__/outline-panel.test.tsx` (2) — empty state, symbol list + filter.
- `src/__tests__/timeline-panel.test.tsx` (2) — merged render + restore
  affordance, empty state.

Run: `node_modules/.bin/vitest run` from `apps/frontend`. Full suite: 328 green.

## Still deferred (runtime)

From the Missing UI Checklist, these remain runtime-dependent (tracked in their
phases, not stubbed):

- **Debug Console** bottom tab — needs the Debug Adapter runtime (Phase 7).
- **Ports** view — needs port-forwarding/remote runtime.
- **Remote** activity item — remote workspaces are a later initiative.

## Top Bar run selector + Activity Bar badges (UI/UX Development Plan)

Two further gaps flagged in the UI/UX plan are now closed:

- **Run selector** (`components/layout/RunSelector.tsx` + pure
  `lib/run-targets.ts`): replaces the old vague "Run" button with a split
  control. `buildRunTargets(launchConfigs, tasks)` lists debug configs first,
  then tasks ordered build → test → other; `defaultRunTarget` resolves the
  selected/active target. The primary action runs the selected target (tasks via
  `runTask`; debug configs surface an honest "debug isn't wired yet" message
  since the DAP runtime is deferred to Phase 7). A **Configure Run** affordance
  appears when no targets exist. It never silently means "generate tests".
- **Activity Bar badges** (`components/layout/ActivityBar.tsx`): Source Control
  shows the changed-file count and Testing shows the failing-task count, derived
  live from `store.git` and `store.taskRuns`.

Tests: `src/lib/__tests__/run-targets.test.ts` (ordering, default resolution,
id parsing).
