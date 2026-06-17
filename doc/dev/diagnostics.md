# Diagnostics, Problems, Logs & Output (Phase 5)

The Problems, Logs, and Output panels are backed by real data: a diagnostic
store fed by problem-matcher parsers, a rolling log buffer fed by sidecar
events, and per-channel output buffers.

## Problem matchers (`apps/frontend/src/lib/problem-matchers.ts`)

Pure parsers that turn a checker's raw output into `Diagnostic[]`
(`{ source, file, line, column, severity, message, code }`):

- `parseTsc` — `file(line,col): error TSxxxx: message`
- `parseEslint` — the stylish formatter (file header + `L:C sev msg rule` rows)
- `parseRuff` — `path:line:col: CODE message` (E9xx → error, else warning)
- `parseCargo` — `path:line:col: error[Exxxx]: message` (`--message-format=short`)

Plus `parseByKind`, `sourceForKind`, and `countBySeverity`. All unit-tested.

## Check runner (`apps/desktop/src/checks.rs`)

`run_check(kind, cwd?)` runs an **allow-listed** checker (`tsc`/`eslint` via npx,
`ruff`, `cargo`) inside the workspace (or a validated sub-directory) and returns
`{ kind, stdout, stderr, code }`. It never runs an arbitrary command and the
`cwd` is validated with `ensure_within_workspace`. A non-zero exit is expected
(checkers exit non-zero when they find problems) and is not treated as an error.

## Store

- `diagnostics: Record<source, Diagnostic[]>` with `setDiagnostics`,
  `clearDiagnostics(source?)`, and `runDiagnostics(kind, cwd?)` which runs the
  checker, parses with the matcher, stores the diagnostics, mirrors the raw
  output to the **Tasks** output channel, and logs a summary.
- `outputChannels: Record<OutputChannel, string[]>` (Agent / Git / Tasks / MCP /
  Terminal / Extension Host) with `appendOutput` / `clearOutput` (capped at 2000
  lines/channel).
- `logs: LogLine[]` with `appendLog` / `clearLogs` (capped at 2000). Agent SSE
  `log` events are routed into the log buffer **and** the Agent output channel
  in `consumeStream`.

## Panels

- `ProblemsPanel` — real diagnostics grouped by file, severity icons,
  error/warning counts, run buttons (tsc/eslint/ruff/cargo), clear, and an honest
  empty state. Clicking a row opens the file (relative paths resolved against the
  workspace root).
- `LogsPanel` — the real `logs` buffer with timestamps + levels, auto-scroll,
  clear, and an empty state.
- `OutputPanel` — a channel `Select` showing the chosen channel's buffer, with
  per-channel clear and an empty state.
- `BottomDock` — adds the **Output** tab and a Problems count badge.

## Acceptance checks (develop.md)

- Problems panel is empty when there are no diagnostics ✓
- Running validation populates Problems with clickable file/line entries ✓
  (`runDiagnostics` → parser → store → panel)
- Logs panel shows real sidecar/desktop events ✓ (agent `log` SSE events)
- Output panel can show Agent / Git / Tasks / MCP / Terminal / Extension Host
  channels ✓ (`OUTPUT_CHANNELS`)

## Tests

- `lib/__tests__/problem-matchers.test.ts` — each parser, dispatch, severity
  counts.
- `__tests__/store.test.ts` — diagnostics set/clear, `runDiagnostics` parses
  checker output into diagnostics + Tasks output, output/log append + clear.
- `__tests__/problems-panel.test.tsx` — empty state, grouped diagnostics +
  click-to-open, run button wiring.

## Not yet

A live diagnostics *stream* (checks are run on demand, not on save — a fileEdited
hook or watch-task would push this further), LSP-server-backed diagnostics, and
task-runner problem matchers beyond the four built-in checkers (Phase 6). Output
channels are populated by Tasks/Agent today; Git/MCP/Terminal/Extension-Host
channels exist and fill in as those phases land.
