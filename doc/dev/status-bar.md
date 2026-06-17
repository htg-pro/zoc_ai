# Status Bar & Product Polish (develop.md Phase 14)

A real, always-visible status bar across the bottom of the workbench. Every
indicator reflects live store state and most double as navigation — clicking
opens the relevant panel.

## What landed

| Piece | File |
|-------|------|
| Status bar component (live indicators + navigation) | `apps/frontend/src/components/layout/StatusBar.tsx` |
| Pure formatters (agent state, language, cursor, model, diagnostics) | `apps/frontend/src/lib/status-bar.ts` |
| Caret tracking (line/column) | `apps/frontend/src/lib/editor-actions.ts`, `features/editor/MonacoView.tsx` |
| Indexer status in the store | `apps/frontend/src/lib/store.ts` (`indexStatus` / `loadIndexStatus`) |
| Mounted below the workbench | `apps/frontend/src/components/layout/Shell.tsx` |

## Indicators

Left cluster:
- **Git branch** + dirty count — real, from `store.git`; click opens Source Control.
- **Agent state** — Running (spinner) / Ask / Agent; click opens the Agent panel.
- **Diagnostics** — error + warning counts from `countBySeverity(diagnostics)`;
  click opens the Problems panel.
- **Indexer** — chunk count + live/watching (from `indexStatus`); click opens
  the Indexer panel. Shown only in live (sidecar-connected) mode.
- **Background tasks** — count of running `taskRuns`; click opens the Tasks panel.

Right cluster:
- **Unsaved count** — dirty open buffers.
- **Line/Column** — live caret position from the active Monaco editor.
- **Encoding** — UTF-8 (the editor's working encoding).
- **Language mode** — from the active file's language id (or its extension).
- **Terminals** — open terminal session count; click opens the terminal.
- **Active model** — the loaded local model (preferred) or the selected model.
- **Sidecar indicator** — Connected / Offline from `liveMode`.

## Caret tracking

`editor-actions.ts` gained a tiny cursor pub/sub (`setCursorPosition` /
`getCursorPosition` / `subscribeCursor`). `MonacoView` reports the position on
mount and on `onDidChangeCursorPosition`, and clears it on unmount. The status
bar subscribes through a small `useCursor()` hook, so Ln/Col updates as the
caret moves and resets when no editor is focused.

## Pure formatters (`lib/status-bar.ts`)

Kept out of the component for unit-testing:

- `agentStateLabel({ streaming, isRunning, agentMode })` → `{ label, tone }`.
- `languageLabel(file)` — language id → display name, falling back to the file
  extension, then capitalization.
- `formatCursor(pos)` → `"Ln 12, Col 5"` or `"—"`.
- `modelLabel(selected, loadedModelId)` — prefers the loaded local model and
  shortens any path/org prefix.
- `diagnosticsLabel(errors, warnings)` → `"3 errors, 1 warning"` / `"No problems"`.

## Acceptance checks (develop.md)

- **Status Bar updates when active file changes** — language mode, encoding, and
  Ln/Col derive from the active file + caret (component test).
- **Git branch is real** — rendered from `store.git.branch` (component test).
- **Diagnostics count opens Problems** — the indicator sets the Problems tab and
  opens the dock (component test).
- **Agent state opens Agent Panel** — the indicator opens the right panel
  (component test).

## Tests

- `src/lib/__tests__/status-bar.test.ts` (8) — all pure formatters.
- `src/__tests__/status-bar.test.tsx` (4) — real Git branch, language/cursor on
  active file, diagnostics → Problems, agent state → Agent panel.

Run: `node_modules/.bin/vitest run` from `apps/frontend`. Full suite: 319 green.

## Notes / deferred

- **File encoding** is shown as UTF-8 (the editor operates on UTF-8 text);
  detecting/changing on-disk encodings is a runtime concern.
- **Update/restart sidecar indicator** is represented by the Connected/Offline
  dot; a one-click "restart sidecar" action belongs to the desktop shell
  runtime and is deferred.
