# Implementation Plan: Advanced Terminal (Part 6)

Pure cores first (property-tested), then store + rendering + agent integration.
`*` = tests.

## Progress (2026-07-24 session 4)

Verified cores + UI integration built & green (frontend vitest + typecheck + eslint clean):
- **6.1 core** `lib/terminal-layout.ts` (P1–P4) and **6.2 core** `features/terminal/output-parser.ts` (P5–P7) — done in the prior session.
- **6.1 UI**: store slice `terminalLayout`/`focusedPaneId` + `ensureTerminalPane`/`splitActivePane`/`closeTerminalPane`/`focusTerminalPane` (delegating to the pure algebra) — `lib/__tests__/terminal-slice.test.ts` (3); recursive renderer `features/terminal/TerminalPanes.tsx` (this repo's `react-resizable-panels` fork: `Group`/`Panel`/`Separator`); `useTerminalPaneShortcuts.ts` (Cmd/Ctrl+D split, Shift split-down, W close, [ / ] focus) — `pane-shortcuts.test.tsx` (3).
- **6.2 overlay**: `features/terminal/OutputParser.tsx` (`AnnotatedOutput`): clickable file paths (open at line:col), URLs (open externally), stacktrace "Fix with Agent", test-summary badge, `<progress>` for CR lines — `OutputParser.test.tsx` (5).

Note: the `store.test.ts` "dirty/save" failure is pre-existing v0.0.1 breakage (verified by stash: 1 fail on the committed baseline), not from the slice.

**6.3 — DONE + verified.** Pure `features/terminal/agent-terminal.ts` reducer
(agent command events + user actions → per-pane routing: designated agent pane,
run-start marker + exactly one run-end separator, `running`/`ok`/`fail` badge,
`agentActive`, `followAgent`; never drops user typing) — `agent-terminal.test.ts`
(incl. fast-check). `AgentTerminalPanes.tsx` mounts a live xterm per pane via
`TerminalPanes.renderPane` with the ✓/✗ badge, an amber "Agent is using this
terminal" warning, and a "Follow agent" toggle; `terminal-manager.ts` + `store.ts`
wiring. terminal-folder vitest green; typecheck + eslint clean.

## Tasks

- [x] 1. Pane-tree layout algebra (`lib/terminal-layout.ts`)
  - [x] 1.1 `PaneNode`/`SplitNode`/`TerminalPane` types, `leaves`, `paneCount`,
    `splitPane`, `closePane`, `focusAdjacent`, `MAX_PANES=4` (pure).
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_
  - [x]* 1.2 Property tests P1–P4 (split bound, close+lift, focus cycle, purity).

- [x] 2. Output parser core (`features/terminal/output-parser.ts`)
  - [x] 2.1 `Annotation`, `parseTerminalLine`, `parseTerminalOutput`,
    `collapseCarriageReturns` (paths/URLs/stack/test-summary; non-overlapping).
    - _Requirements: 2.1, 2.2, 2.3, 2.4_
  - [x]* 2.2 Property tests P5–P7 + example lines (pytest/jest/cargo, URL, path).

- [x] 3. Terminal store slice + panes UI (`store.ts`, `features/terminal/`)
  - [x] 3.1 Add `layout: PaneNode | null` + `focusedPaneId` + actions; render the
    tree with `react-resizable-panels`; split/close/focus keyboard shortcuts.
    - _Requirements: 1.1–1.4_
  - [x] 3.2 `OutputParser.tsx` overlay rendering annotations over xterm (clickable
    path/URL, "Fix with Agent" on stacktraces, test badge, `<progress>`).
    - _Requirements: 2.1–2.4_

- [x] 4. Agent–terminal integration (`6.3`)
  - [x] 4.1 Stream agent `run_command` into the active pane; completion badge;
    "Follow agent" toggle; separator line.
    - _Requirements: 3.1, 3.2_

- [x] 5. Verification: `vitest run` for the new suites; typecheck clean.

## Notes
- Verified core in this pass = tasks 1 + 2 (pure algebra + parser). Tasks 3–4 are
  the rendering/stream integration layer over them.
