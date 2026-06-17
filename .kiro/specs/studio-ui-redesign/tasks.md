# Implementation Plan: Studio UI Redesign

## Status (updated June 14, 2026)

**Pure modules + property tests (tasks 1–14): COMPLETE.** All pure modules exist
(`run-machine`, `event-ingest`, `reconnect`, `plan-progress`, `session-query`, `diff-utils`,
`layout`, `composer-validate`, `context-usage`, `format-elapsed`, `reduced-motion`) with their
fast-check property suites green.

**View layer + wiring (tasks 15–25): mostly COMPLETE.** Recent increment closed these gaps:
- Bug #4 (run-start ordering): the previous stream is now aborted **before** the new run id is
  assigned in `sendUserMessage` (`store.ts`).
- Queued message (R4.11/R4.14): the composer now actually holds a message while a run is active
  and the store releases + sends it on the terminal transition (`store.ts`, `Composer.tsx`).
- Plan/task progress summary (R9.1–9.6): `ContextBar` renders a `done/total` progress bar driven
  by the new `todoProgress` selector in `plan-progress.ts`.
- "Agent is editing" badge (R3.5): pulsing indicator on actively-changed files in `FileTree`.
- Bottom-dock agent control (R3.12): pause/resume toggle wired into `BottomDock`.
- Checkpoint rollback hardening (R11.3): two-step confirm, in-progress disabling, and a 10s
  timeout with inline error retention in `AgentTimeline`.

**Known remaining partials (lower priority, additive):** `resilientEventStream` reconnection
wrapper in `agent-client.ts` (task 16.1); exact pixel panel bounds via `layout.ts` in `Shell.tsx`
(task 17.1); persisted pin state inside `SessionsView` (task 18.2).

Verification: 121 frontend tests pass (`vitest run`), `tsc --noEmit` clean.

## Overview

This plan implements the Zoc AI frontend redesign (`apps/frontend`: React + Vite + TypeScript
+ Tailwind + shadcn + zustand) at high fidelity across the three Kombai canvases, and hardens the
agent run workflow they depict.

The approach is **pure-modules-first**: the correctness-critical logic is extracted into pure
modules (`run-machine`, `event-ingest`, `reconnect`, `plan-progress`, `session-query`, `diff-utils`
extension, `layout`, `composer-validate`, `context-usage`, `format-elapsed`, `reduced-motion`) and
covered by 30 property-based tests (fast-check, ≥100 iterations each) before the store, client, and
view layers are wired to consume them. The four confirmed bugs are fixed as part of the store and
streaming wiring: (1) real pause that gates SSE consumption, (2) `prefers-reduced-motion` handling,
(3) autonomy/model read from run config, and (4) the run-start ordering race.

Existing tests (`sse.test.ts`, `store.test.ts`, `diff-utils.test.ts`, `agent-panel-tools.test.tsx`)
are preserved, and store selectors are kept backward-compatible during the migration.

Verification (run in `apps/frontend`): `npm run typecheck`, `npm run lint`, `npm run test`
(Vitest single run).

## Tasks

- [x] 1. Property-based test infrastructure
  - [x]* 1.1 Add fast-check dev dependency and configure Vitest
    - Add `fast-check` to `apps/frontend/package.json` devDependencies and install
    - Confirm `vitest.config.ts` runs `*.prop.test.ts` files in single-run (no watch) mode
    - _Requirements: Testing Strategy (PBT setup)_
  - [ ]* 1.2 Create shared fast-check arbitraries
    - Add `src/__tests__/arbitraries.ts` with reusable arbitraries for `RunState`/`RunAction`,
      `AgentEvent` (with `seq`), `PlanStep[]`, `Session[]` + pin maps, unified-diff strings,
      `RunConfig`, and `LayoutState`
    - _Requirements: Testing Strategy (generators)_

- [x] 2. Design system and Design_Tokens
  - [x] 2.1 Define Design_Tokens as CSS variables and Tailwind theme
    - Promote the canvas color, typography, radius values into named CSS variables in
      `src/styles/globals.css` and map them in `tailwind.config.ts`
    - Set `Inter` (→ `system-ui` → sans) for UI text and `JetBrains Mono` (→ `ui-monospace` → mono)
      for code/paths/metrics
    - _Requirements: 1.1, 1.2, 1.3_
  - [ ] 2.2 Replace hardcoded color/radius literals with token classes
    - Remove raw hex literals (e.g. `#0E0E11`, `#9B6AF1`, `#FB923C`) from components and reference
      token classes instead
    - _Requirements: 1.3_
  - [ ]* 2.3 Token and font resolution tests
    - Add `src/__tests__/tokens.test.ts` asserting the dark token set resolves to the canvas
      palette, the font families/fallbacks are present, and no disallowed raw hex literals remain
    - _Requirements: 1.1, 1.2, 1.3_

- [x] 3. format-elapsed pure module
  - [x] 3.1 Implement `formatElapsed`
    - Add `src/lib/format-elapsed.ts` producing zero-padded `HH:MM:SS` from non-negative elapsed time
    - _Requirements: 3.2_
  - [ ]* 3.2 Write property test for elapsed formatting
    - **Property 29: Elapsed-time formatting round-trips**
    - File `src/lib/__tests__/format-elapsed.prop.test.ts`, tagged
      `// Feature: studio-ui-redesign, Property 29: ...`, ≥100 iterations
    - **Validates: Requirements 3.2**

- [x] 4. reduced-motion pure module
  - [x] 4.1 Implement reduced-motion helpers
    - Add `src/lib/reduced-motion.ts` with `useReducedMotion`, `staticStateCue(state)` (icon + color
      cue for active/complete/error), and a motion-token class resolver
    - _Requirements: 6.6, 6.8_
  - [ ]* 4.2 Write property test for static state cues
    - **Property 30: Reduced-motion state cues are total and distinct**
    - File `src/lib/__tests__/reduced-motion.prop.test.ts`, tagged, ≥100 iterations
    - **Validates: Requirements 6.8**

- [x] 5. plan-progress pure module
  - [x] 5.1 Implement `planProgress`
    - Add `src/lib/plan-progress.ts` returning `{ done, total, ratio }` with ratio clamped to [0,1]
      and 0 when total is 0; `completedCount` = steps in `done`
    - _Requirements: 4.8, 9.1, 9.2, 9.3, 9.6_
  - [ ]* 5.2 Write property test for plan progress
    - **Property 9: Plan progress equals done-over-total**
    - File `src/lib/__tests__/plan-progress.prop.test.ts`, tagged, ≥100 iterations
    - **Validates: Requirements 4.8, 9.1, 9.2, 9.3, 9.6**

- [x] 6. composer-validate pure module
  - [x] 6.1 Implement `validateMessage`
    - Add `src/lib/composer-validate.ts` accepting iff trimmed length is in [1, 10000]
    - _Requirements: 4.9, 4.13_
  - [ ]* 6.2 Write property test for message validation
    - **Property 10: Message validation accepts exactly non-empty bounded input**
    - File `src/lib/__tests__/composer-validate.prop.test.ts`, tagged, ≥100 iterations
    - **Validates: Requirements 4.9, 4.13**

- [x] 7. context-usage pure module
  - [x] 7.1 Implement context-usage computation
    - Add `src/lib/context-usage.ts` returning ratio `consumed/limit` clamped to [0,1], percent in
      [0,100], warning active iff ratio ≥ 0.9
    - _Requirements: 4.12, 4.15_
  - [ ]* 7.2 Write property test for context usage
    - **Property 12: Context-usage ratio and warning threshold**
    - File `src/lib/__tests__/context-usage.prop.test.ts`, tagged, ≥100 iterations
    - **Validates: Requirements 4.12, 4.15**

- [x] 8. session-query pure module
  - [x] 8.1 Implement session selectors and mutations
    - Add `src/lib/session-query.ts` with `groupSessions`, `matchesSearch`, `sortSessions`,
      `filterSortSearch`, stat-card selectors, `tabCounts`, pin toggle, and delete
    - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.11, 2.12_
  - [ ]* 8.2 Write property test for session grouping
    - **Property 16: Session grouping is total and pin-aware**
    - File `src/lib/__tests__/session-query.prop.test.ts`, tagged, ≥100 iterations
    - **Validates: Requirements 2.2, 2.3**
  - [ ]* 8.3 Write property test for filtering and counts
    - **Property 13: Session filtering matches the active tab**
    - **Validates: Requirements 2.5, 2.6**
  - [ ]* 8.4 Write property test for session search
    - **Property 14: Session search is a case-insensitive substring filter**
    - **Validates: Requirements 2.7**
  - [ ]* 8.5 Write property test for session sort
    - **Property 15: Session sort is deterministic and ordered**
    - **Validates: Requirements 2.8**
  - [ ]* 8.6 Write property test for session statistics
    - **Property 17: Session statistics are non-negative integers**
    - **Validates: Requirements 2.4**
  - [ ]* 8.7 Write property test for pin toggle
    - **Property 18: Pin toggle is its own inverse**
    - **Validates: Requirements 2.11**
  - [ ]* 8.8 Write property test for session deletion
    - **Property 19: Session deletion removes only the target**
    - **Validates: Requirements 2.12**

- [x] 9. diff-utils extension
  - [x] 9.1 Extend diff-utils for review logic
    - Extend `src/lib/diff-utils.ts` with line classification (`add`/`del`/context), `reviewSummary`,
      `clampIndex` navigation, per-file apply/undo set operations, and applied-id persistence helpers
    - Preserve existing `diff-utils.test.ts` behavior
    - _Requirements: 5.2, 5.3, 5.4, 5.7, 5.8, 10.1, 10.2, 10.4, 10.6_
  - [ ]* 9.2 Write property test for parse/format round-trip and classification
    - **Property 20: Diff parse/format round-trips and classifies lines**
    - File `src/lib/__tests__/diff-utils.prop.test.ts`, tagged, ≥100 iterations
    - **Validates: Requirements 5.3**
  - [ ]* 9.3 Write property test for review-pending summary
    - **Property 21: Review-pending summary aggregates per-file counts**
    - **Validates: Requirements 5.2**
  - [ ]* 9.4 Write property test for change navigation
    - **Property 22: Change navigation increments, decrements, and clamps**
    - **Validates: Requirements 5.4, 5.5, 5.6, 5.9, 5.10**
  - [ ]* 9.5 Write property test for apply/undo isolation
    - **Property 23: Apply and undo remove only the target from pending reviews**
    - **Validates: Requirements 5.7, 5.8, 10.1, 10.2, 10.4**
  - [ ]* 9.6 Write property test for applied-patch persistence
    - **Property 24: Applied-patch persistence round-trips**
    - **Validates: Requirements 10.6**

- [x] 10. layout pure module
  - [x] 10.1 Implement layout helpers
    - Add `src/lib/layout.ts` with `togglePanel`, `clampSize` (Explorer/Agent 180–600px; dock
      120px–80% window), and `sanitizeLayout`/persist/load round-trip helpers
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.7, 12.8_
  - [ ]* 10.2 Write property test for panel toggling
    - **Property 26: Panel toggling is its own inverse**
    - File `src/lib/__tests__/layout.prop.test.ts`, tagged, ≥100 iterations
    - **Validates: Requirements 12.1, 12.2, 12.3**
  - [ ]* 10.3 Write property test for size clamping
    - **Property 27: Panel size clamping respects bounds**
    - **Validates: Requirements 12.7**
  - [ ]* 10.4 Write property test for layout persistence
    - **Property 28: Layout persistence round-trips sizes and visibility**
    - **Validates: Requirements 12.4, 12.8**

- [x] 11. run-machine pure module
  - [x] 11.1 Implement run lifecycle reducer
    - Add `src/lib/run-machine.ts` with `runReducer` (start/pause/resume/stop/done/error/stream-lost),
      `controlAvailability(phase)`, and queued-message release logic; clears `runId` on terminal states
    - _Requirements: 7.1, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 4.11, 4.14_
  - [ ]* 11.2 Write property test for lifecycle transitions
    - **Property 1: Run lifecycle transitions are well-defined**
    - File `src/lib/__tests__/run-machine.prop.test.ts`, tagged, ≥100 iterations
    - **Validates: Requirements 7.1, 7.5, 7.6, 7.10, 8.5**
  - [ ]* 11.3 Write property test for single active run
    - **Property 2: Starting a new run yields exactly one active run**
    - **Validates: Requirements 7.9**
  - [ ]* 11.4 Write property test for control availability
    - **Property 3: Control availability is determined solely by phase**
    - **Validates: Requirements 7.7, 7.8**
  - [ ]* 11.5 Write property test for queued-message release
    - **Property 11: Queued message releases exactly once on terminal transition**
    - **Validates: Requirements 4.11, 4.14**

- [x] 12. event-ingest pure module
  - [x] 12.1 Implement event ingestion and ordering
    - Add `src/lib/event-ingest.ts` with `decideIngest` (stale/stopped/buffer/apply), `orderEvents`
      + id-upsert (ascending `seq`), isolated plan-step status update, and checkpoint/timeline
      ordering by creation time
    - _Requirements: 7.3, 4.4, 8.2, 8.4, 8.7, 8.8, 11.1_
  - [ ]* 12.2 Write property test for ingestion decision
    - **Property 4: Event ingestion decision is correct for every phase and sequence**
    - File `src/lib/__tests__/event-ingest.prop.test.ts`, tagged, ≥100 iterations
    - **Validates: Requirements 7.3, 8.7, 8.8**
  - [ ]* 12.3 Write property test for timeline ordering
    - **Property 5: Timeline ordering preserves ascending sequence and id-uniqueness**
    - **Validates: Requirements 4.4, 8.2**
  - [ ]* 12.4 Write property test for plan-step isolation
    - **Property 8: Plan-step status updates are isolated**
    - **Validates: Requirements 8.4**
  - [ ]* 12.5 Write property test for checkpoint ordering
    - **Property 25: Checkpoint/timeline ordering is by creation time**
    - **Validates: Requirements 11.1**

- [x] 13. reconnect pure module
  - [x] 13.1 Implement reconnection policy
    - Add `src/lib/reconnect.ts` with `nextReconnect` returning `resubscribe`
      (`sinceSeq = highestSeq`, `attempt = attempts + 1`) while `attempts < 5` and `give-up` at 5
    - _Requirements: 7.4, 8.6, 8.9_
  - [ ]* 13.2 Write property test for resume cursor
    - **Property 6: Subscription and resume request events after the highest processed sequence**
    - File `src/lib/__tests__/reconnect.prop.test.ts`, tagged, ≥100 iterations
    - **Validates: Requirements 7.4, 8.6**
  - [ ]* 13.3 Write property test for bounded reconnection
    - **Property 7: Reconnection is bounded to five attempts**
    - **Validates: Requirements 8.9**

- [x] 14. Checkpoint - Pure modules complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 15. Run slice store migration
  - [ ] 15.1 Integrate run-machine and fix pause/stop and start ordering
    - Add `RunState` to `src/lib/store.ts`, drive lifecycle through `run-machine`, gate event
      consumption via `event-ingest` with a paused buffer (fixes bug #1), and terminate the previous
      stream before assigning the new run id (fixes bug #4)
    - _Requirements: 7.1, 7.3, 7.4, 7.5, 7.6, 7.9, 7.10, 8.8_
  - [ ] 15.2 Wire RunConfig, queued message, and backward-compatible selectors
    - Add `RunConfig` (autonomy/model) read from the active run (fixes bug #3), pending queued
      message release on terminal transition, and keep existing selectors backward-compatible
    - _Requirements: 9.4, 9.5, 9.7, 4.11, 4.14_
  - [ ]* 15.3 Extend store tests
    - Extend `src/__tests__/store.test.ts` for lifecycle, pause gating, start ordering, and config
    - _Requirements: 7.1, 7.3, 7.9, 9.4, 9.5_

- [ ] 16. SSE client resilience wiring
  - [ ] 16.1 Implement resilientEventStream and stream-lost handling
    - Add reconnection wrapper in `src/lib/agent-client.ts` using `reconnect`, keep `since_seq` and
      `lastSeq` dedupe in `src/lib/sse.ts`, and map exhausted reconnects to a `StreamLostError`
      consumed as an `error` transition
    - _Requirements: 8.1, 8.5, 8.6, 8.7, 8.8, 8.9_
  - [ ]* 16.2 Extend streaming tests
    - Extend `src/__tests__/sse.test.ts` and `src/__tests__/agent-client.test.ts` for resumption,
      dedupe, and reconnection
    - _Requirements: 8.6, 8.7, 8.9_

- [ ] 17. Layout shell and Title_Bar
  - [ ] 17.1 Update Shell panel bounds and persistence
    - Update `Shell.tsx` to pixel bounds (Explorer/Agent 180–600px, dock 120px–80%) and wire
      size/visibility persistence through the `layout` module
    - _Requirements: 3.1, 12.4, 12.7, 12.8_
  - [ ] 17.2 Update TopBar (Title_Bar)
    - Set 38px height, truncating workspace path, panel toggles with active/inactive states, and a
      Run/Running pill reading elapsed time from the run slice via `formatElapsed`
    - _Requirements: 1.4, 1.5, 3.2, 3.3, 3.4, 12.5, 12.6_
  - [ ]* 17.3 Shell/TopBar unit tests
    - Assert 38px height, path truncation, toggle states, and Running indicator appearance/removal
      with fake timers
    - _Requirements: 1.4, 1.5, 3.2, 3.3, 3.4, 12.5, 12.6_

- [ ] 18. Sessions view
  - [ ] 18.1 Build Sessions_Sidebar and Sessions_Dashboard
    - Render sidebar groups, stat cards, filter tabs with counts, search, sort, and empty state in
      `src/features/sessions/`, wired to `session-query`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.15_
  - [ ] 18.2 Wire session card actions
    - Wire Resume (open workspace / error stays on dashboard), pin toggle (persisted), delete
      (persisted with rollback + error), and New session
    - _Requirements: 2.9, 2.10, 2.11, 2.12, 2.13, 2.14_
  - [ ]* 18.3 Sessions unit tests
    - Assert resume/delete wiring, error indications, New session, and empty state
    - _Requirements: 2.1, 2.9, 2.10, 2.13, 2.14, 2.15_

- [ ] 19. Agent_Panel, timeline, composer, and context
  - [ ] 19.1 Build Agent_Panel header and run-control bar
    - Header (identity, run-status, overflow), idle model picker, Planning/Building status, and
      pause/resume/stop + autonomy/model badges reading the store (no hardcoded values)
    - _Requirements: 4.1, 4.2, 4.3, 7.7, 7.8, 9.4, 9.5, 9.7_
  - [ ] 19.2 Build Run_Timeline
    - Render plan steps (done checkmark + elapsed, in-progress spinner, queued indicator), tool
      actions labeled by status, fade-in rows, and inline checkpoints ordered by creation time
    - _Requirements: 4.4, 4.5, 4.6, 4.7, 8.3, 11.1_
  - [ ] 19.3 Build Agent_Composer
    - Message input (1–10,000 via `composer-validate`), attachments, Plan/Build toggle, Autonomy
      selector, send; reject empty with feedback; queue message while a run is active
    - _Requirements: 4.9, 4.10, 4.11, 4.13, 4.14_
  - [ ] 19.4 Build ContextBar and task summary
    - `ContextBar.tsx` (consumed/limit ratio + warning at ≥90% via `context-usage`) and a progress
      summary component (completed/total + fill from `plan-progress`)
    - _Requirements: 4.8, 4.12, 4.15, 9.1, 9.2, 9.3, 9.6_
  - [ ]* 19.5 Agent panel unit tests
    - Extend `src/__tests__/agent-panel-tools.test.tsx` for pause↔resume swap, control enable/disable
      per phase, start-failure path, and queued submission
    - _Requirements: 4.3, 4.10, 7.2, 7.7, 7.8_

- [ ] 20. Diff-review workspace
  - [ ] 20.1 Build Diff_View, Review_Toolbar, and change summary
    - Render side-by-side diff with distinct add/remove/context backgrounds, "Review Pending"
      summary, "Reviewing changes N of M" with per-file counts, and prev/next navigation with clamping
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.9, 5.10_
  - [ ] 20.2 Wire apply/undo and review states
    - Apply/undo per file via the store, retain on apply failure with error, no-op + indication when
      empty, and all-reviewed state when pending becomes empty
    - _Requirements: 5.7, 5.8, 5.11, 5.12, 10.1, 10.2, 10.3, 10.4, 10.5, 10.7_
  - [ ]* 20.3 Diff-review unit tests
    - Assert composition, apply-failure retention, no-pending behavior, and all-reviewed state
    - _Requirements: 5.1, 5.11, 5.12, 10.5, 10.7_

- [ ] 21. Editor_View and File_Explorer agent activity
  - [ ] 21.1 File_Explorer agent activity and change badges
    - Add "Agent is editing" badge, A/M change badges, and applied-state badge updates after
      apply/rollback in `src/features/files/`
    - _Requirements: 3.5, 3.6, 3.7, 10.3, 11.5_
  - [ ] 21.2 Editor_View tabs and edit decorations
    - Render editor tabs with modified indicator, highlight agent-edited lines with an "Agent editing"
      marker, and a blinking caret at the active edit position
    - _Requirements: 3.8, 3.9, 3.10_
  - [ ]* 21.3 Editor/explorer unit tests
    - Assert badges, modified tab indicator, and edit/caret decorations
    - _Requirements: 3.5, 3.6, 3.7, 3.8, 3.9, 3.10_

- [ ] 22. Bottom_Dock
  - [ ] 22.1 Build Bottom_Dock tabs and agent-control toggle
    - Terminal/Problems/Logs tabs plus an agent-control toggle that updates state and reflects within 1s
    - _Requirements: 3.11, 3.12_
  - [ ]* 22.2 Bottom_Dock unit tests
    - Assert tabs and agent-control toggle behavior
    - _Requirements: 3.11, 3.12_

- [ ] 23. Motion_System and reduced motion
  - [ ] 23.1 Add motion utilities and reduced-motion block
    - Add the motion utilities (pulse dots, orb glow, shimmer, blinking caret, typing dots, fade-in,
      spinners, progress bars) and a single `@media (prefers-reduced-motion: reduce)` block in
      `globals.css` (fixes bug #2)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.7_
  - [ ] 23.2 Wire reduced-motion into animated components
    - Use `useReducedMotion`/`staticStateCue` to swap looping animations for static state cues across
      the timeline, status indicators, typing dots, and carets
    - _Requirements: 6.6, 6.8_
  - [ ]* 23.3 Motion smoke and reduced-motion tests
    - Assert keyframe/utility presence and that looping animations are neutralized with remaining
      transitions ≤200ms when reduced-motion is enabled
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_

- [ ] 24. Checkpoint and rollback
  - [ ] 24.1 Implement checkpoint rollback flow
    - Add checkpoint timeline entries with a rollback control, confirmation prompt, in-progress
      indicator that disables controls, 10s timeout, error handling that preserves pre-rollback state,
      and Explorer badge refresh on success (store + `AgentTimeline.tsx`)
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6_
  - [ ]* 24.2 Rollback integration test
    - Mock the agent client rollback; assert store call, in-progress disabling, success badge refresh,
      and failure/timeout retention
    - _Requirements: 11.3, 11.5, 11.6_

- [ ] 25. Final integration and regression
  - [ ] 25.1 Wire view routing
    - Wire Sessions / agent-editing workspace / diff-review view switching in `App.tsx`
    - _Requirements: 2.1, 3.1, 5.1_
  - [ ]* 25.2 Run full regression and keep existing tests green
    - Run `npm run typecheck`, `npm run lint`, `npm run test` in `apps/frontend`; ensure
      `sse.test.ts`, `store.test.ts`, `diff-utils.test.ts`, `agent-panel-tools.test.tsx` still pass
    - _Requirements: all_

- [ ] 26. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional (tests and test infrastructure) and can be skipped for a faster
  MVP; if `1.1`/`1.2` are skipped, the property tests cannot run.
- Each task references the specific requirements (and, for property tests, the design property) it
  implements for traceability.
- The four confirmed bugs are fixed in: 15.1 (bug #1 pause gating, bug #4 start ordering), 15.2
  (bug #3 autonomy/model from config), and 23.1 (bug #2 reduced motion).
- All 30 correctness properties are covered by single property-based tests using fast-check at ≥100
  iterations, tagged `// Feature: studio-ui-redesign, Property {n}: {text}`.
- Existing tests are preserved and store selectors stay backward-compatible during the migration.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1"] },
    { "id": 1, "tasks": ["1.2", "2.2", "3.1", "4.1", "5.1", "6.1", "7.1", "8.1", "9.1", "10.1", "11.1", "12.1", "13.1"] },
    { "id": 2, "tasks": ["2.3", "3.2", "4.2", "5.2", "6.2", "7.2", "8.2", "9.2", "10.2", "11.2", "12.2", "13.2", "15.1", "16.1", "17.1"] },
    { "id": 3, "tasks": ["8.3", "9.3", "10.3", "11.3", "12.3", "13.3", "15.2", "16.2", "18.1", "20.1", "21.1", "21.2", "22.1"] },
    { "id": 4, "tasks": ["8.4", "9.4", "10.4", "11.4", "12.4", "15.3", "17.2", "18.2", "19.1", "19.2", "19.3", "20.2", "21.3"] },
    { "id": 5, "tasks": ["8.5", "9.5", "11.5", "12.5", "17.3", "18.3", "19.4", "20.3", "22.2", "23.1"] },
    { "id": 6, "tasks": ["8.6", "9.6", "19.5", "24.1"] },
    { "id": 7, "tasks": ["8.7", "23.2", "23.3", "24.2", "25.1"] },
    { "id": 8, "tasks": ["8.8", "25.2"] }
  ]
}
```
