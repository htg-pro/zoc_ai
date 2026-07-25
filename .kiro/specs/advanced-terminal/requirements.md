# Requirements: Advanced Terminal (Part 6)

## Introduction

Part 6 upgrades the terminal (today a single-pane, tabbed `TerminalPane.tsx`
over a `terminals`/`activeTerminalId` store slice) with three capabilities:

- **6.1 Multi-pane layout** — split the terminal horizontally/vertically into a
  binary tree of panes (max 4), each bound to its own PTY session, resizable,
  with keyboard shortcuts and a `layout`/`focusedPaneId` state model.
- **6.2 Smart output parsing** — a pure stream annotator that detects file
  paths, URLs, error stacktraces, test-result summaries, and progress bars in
  PTY output and exposes interactive overlays without mutating the raw stream.
- **6.3 Agent–terminal integration** — the agent's `run_command` streams into
  the active pane live, with status badges, a "Follow agent" toggle, and a
  completion separator.

This spec front-loads the two pure, testable cores (the pane-tree layout algebra
and the output annotator); the rendering (react-resizable-panels, xterm overlay
layer) and the agent PTY streaming are the integration layer on top.

## Requirements

### Requirement 1 — Pane tree layout (6.1)

**User Story:** As a developer, I want to split the terminal into resizable
panes so I can watch multiple sessions at once.

#### Acceptance Criteria
1. The layout SHALL be a binary tree of `SplitNode` (with `direction` and two
   children) and `TerminalPane` leaves; each leaf references one PTY session id.
2. WHEN a pane is split right/down THEN the focused leaf SHALL become a
   `SplitNode` with the original pane and a new pane as children, and the tree
   SHALL never exceed 4 leaves.
3. WHEN a pane is closed THEN its sibling SHALL replace the parent split; closing
   the last pane SHALL yield an empty layout.
4. Focus navigation (prev/next) SHALL move `focusedPaneId` across the leaves in a
   stable left-to-right order and wrap around.
5. Every layout operation SHALL be a pure function of `(layout, focusedPaneId,
   arg)` returning a new `(layout, focusedPaneId)` — no in-place mutation.

### Requirement 2 — Output parsing (6.2)

**User Story:** As a developer, I want terminal output turned into clickable
links and summaries.

#### Acceptance Criteria
1. The parser SHALL detect, per line, as non-overlapping annotations: file paths
   with optional `:line[:col]` (e.g. `src/a.ts:42:10`, `./b.py:10`), URLs
   (`http(s)://…`), stacktrace frames (lines starting with `at `, `File "`, or
   `Traceback`), and test-result summary lines (pytest/jest/cargo).
2. A file-path annotation SHALL carry `{ path, line?, column? }`; a URL
   annotation SHALL carry `{ url }`; a test-summary annotation SHALL carry
   `{ passed, failed, skipped }` parsed from the line.
3. The parser SHALL be pure: it returns annotations with character offsets and
   SHALL NOT modify the raw text.
4. A carriage-return progress line (contains `\r`) SHALL be reducible to its
   final overwritten segment for a `<progress>`-style render.

### Requirement 3 — Agent–terminal integration (6.3)

**User Story:** As a user, I want the agent's commands to run live in my
terminal and be clearly attributed.

#### Acceptance Criteria
1. WHEN the agent runs a command THEN its output SHALL stream into the active
   pane's session and, on exit, show a faint `✓/✗ Agent ran: {cmd} — exit N`
   badge.
2. A "Follow agent" toggle SHALL, when on, switch the active pane to the agent's
   session; when the run ends, a separator line SHALL be printed.

## Non-goals
- Terminal multiplexer parity (tmux); >4 panes; persistent pane layouts across
  restarts (v1 keeps the layout in memory).
- The xterm rendering and react-resizable-panels wiring are the integration
  layer; this spec's *verified* core is the pure layout algebra + parser.
