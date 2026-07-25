# Design: Advanced Terminal (Part 6)

## Overview

- **6.1 pane tree** — `apps/frontend/src/lib/terminal-layout.ts`: a pure algebra
  over `PaneNode = SplitNode | TerminalPane`. `SplitNode { id, direction:
  "row"|"column", a: PaneNode, b: PaneNode }`; `TerminalPane { id, sessionId }`.
  Operations `splitPane`, `closePane`, `focusAdjacent`, plus `leaves`/`paneCount`
  are pure `(layout, focusedPaneId) → (layout, focusedPaneId)`.
- **6.2 output parser** — `apps/frontend/src/features/terminal/output-parser.ts`:
  pure `parseTerminalLine(line) → Annotation[]` (+ `parseTerminalOutput`) with
  char offsets, and `collapseCarriageReturns(line)` for progress lines. The
  React overlay (`OutputParser.tsx`) renders these on top of xterm without
  touching the raw stream.
- **6.3 integration** — the agent's `run_command` uses the active pane's PTY
  session; a completion badge + "Follow agent" toggle + separator line. This is
  UI/stream wiring over the two cores.

## Data models

```typescript
// 6.1
export type PaneNode = SplitNode | TerminalPane;
export interface TerminalPane { kind: "pane"; id: string; sessionId: string }
export interface SplitNode {
  kind: "split"; id: string; direction: "row" | "column"; a: PaneNode; b: PaneNode;
}
export const MAX_PANES = 4;

// 6.2
export type Annotation =
  | { type: "path"; start: number; end: number; path: string; line?: number; column?: number }
  | { type: "url"; start: number; end: number; url: string }
  | { type: "stack"; start: number; end: number }
  | { type: "test-summary"; start: number; end: number; passed: number; failed: number; skipped: number };
```

`splitPane(layout, focusedId, direction, newPane)`: replace the focused leaf `L`
with `SplitNode{direction, a:L, b:newPane}`; a no-op (returns the same layout)
when `paneCount(layout) >= MAX_PANES` or the focus is not found. `closePane`
removes the leaf and lifts its sibling into the parent's slot (root close →
`null`). `focusAdjacent(layout, focusedId, +1|-1)` indexes into `leaves(layout)`
(stable in-order) and wraps.

The parser scans a line with a small ordered set of regexes, emitting
non-overlapping annotations sorted by start offset (URLs matched before bare
paths to avoid mislabeling a URL's host as a path). Test-summary parsing pulls
`passed/failed/skipped` counts from pytest/jest/cargo summary shapes.

## Correctness Properties

- **P1 — Split grows by one leaf, bounded.** For any layout with `< MAX_PANES`
  leaves and a valid focus, `splitPane` yields `paneCount+1` leaves containing
  the original session ids plus the new one; at `MAX_PANES` it is a no-op.
- **P2 — Close removes exactly the pane and lifts the sibling.** For any layout
  with ≥2 leaves, `closePane(id)` yields a layout whose leaves are the originals
  minus `id`, preserving the sibling subtree; closing the sole leaf yields
  `null`.
- **P3 — Focus navigation is a stable wrap-around cycle.** Repeated
  `focusAdjacent(+1)` visits every leaf id in `leaves` order and returns to the
  start after `paneCount` steps; `-1` is its inverse.
- **P4 — Operations are pure.** Every operation returns a new tree and leaves
  the input object structurally unchanged (input `paneCount`/ids unchanged).
- **P5 — Annotations are non-overlapping and offset-faithful.** For any line,
  `parseTerminalLine` returns annotations sorted by `start`, pairwise
  non-overlapping, and each annotation's `[start,end)` slice equals its matched
  substring.
- **P6 — Path/URL/summary extraction.** A `path:line:col` token yields a `path`
  annotation with the parsed line/column; an `http(s)` token yields a `url`; a
  pytest/jest/cargo summary yields the correct `passed/failed/skipped`.
- **P7 — Carriage-return collapse.** `collapseCarriageReturns(s)` returns the
  segment after the last `\r` (the visible overwrite), or `s` unchanged when
  there is no `\r`.

## Testing strategy

- **fast-check** for P1–P7 (`{ numRuns: 200 }`), tagged
  `Feature: advanced-terminal, Property N: <text>`; leaves/ids generated so
  splits/closes/focus are exercised over arbitrary trees.
- Example tests for concrete stacktrace/test-summary/URL/path lines.
- The store slice (`layout`, `focusedPaneId`) and the xterm overlay/rendering +
  agent PTY streaming (6.3) are the integration layer over these verified cores.
