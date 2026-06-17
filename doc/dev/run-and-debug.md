# Run and Debug (Phase 7)

The Run & Debug layer that does **not** need a live runtime is implemented:
breakpoints (with a Monaco gutter), `launch.json` parsing, and the Run & Debug
view. The live debug-adapter (DAP) session is intentionally deferred — see the
note at the end.

## Implemented

### Breakpoints
- Store: `breakpoints: Record<file, number[]>`, `toggleBreakpoint(file, line)`,
  `clearBreakpoints(file?)` (lines kept sorted; a file key is dropped when it has
  no breakpoints).
- Editor: `MonacoView` enables the glyph margin and toggles a breakpoint when the
  margin is clicked (`onMouseDown` → `GUTTER_GLYPH_MARGIN`), rendering a red
  `.zoc-breakpoint-glyph` on each breakpoint line. Breakpoints persist in the
  store and re-render when the file is reopened.

### Launch configurations
- `apps/frontend/src/lib/launch-configs.ts` — pure `parseLaunchJson` (JSONC via
  `stripJsonComments`) → `LaunchConfig[]`, classifying the adapter family
  (node/python/rust/go/other).
- Store: `launchConfigs`, `selectedDebugConfig`, `setSelectedDebugConfig`,
  `loadLaunchConfigs()` (reads `.vscode/launch.json` then `.zoc/launch.json`).

### UI
- `RunDebugPanel` (Activity Bar **Run and Debug**, ⌘⇧D) — a configuration
  `Select`, a (disabled) Start button with an explanatory tooltip, a
  **Breakpoints** section (list, jump-to, remove one / remove all), and
  **Variables / Watch / Call Stack** sections with honest "available while
  paused" placeholders.
- Commands: `workbench.view.debug` (enabled, ⌘⇧D) and
  `workbench.action.debug.start` (F5, **disabled** with a reason until the
  adapter runtime lands). `zoc.agent.reviewChanges` gave up its ⌘⇧D binding to
  the debug view (VS Code parity).

## Acceptance checks (develop.md)

- Clicking the editor gutter toggles a breakpoint ✓
- F5 starts the selected configuration — **deferred** (command present but
  disabled with a reason; see below)
- Debug console receives runtime output / Stop terminates adapter — **deferred**

## Tests

- `lib/__tests__/launch-configs.test.ts` — parsing + family classification +
  malformed handling.
- `__tests__/store.test.ts` — `toggleBreakpoint` add/remove/sort + key cleanup,
  `clearBreakpoints` one/all, `loadLaunchConfigs` reads and selects.

## Deferred — and why

A working debugger needs a **Debug Adapter Protocol client** that spawns and
speaks DAP (initialize / setBreakpoints / launch / stackTrace / scopes /
variables / continue / step / events) over a long-lived process to `debugpy`,
`node --inspect`, or `lldb`. That long-lived, event-streaming process runtime is
the same infrastructure the terminal upgrade (Phase 8) builds (the hotpath crate
already has a `pty` module). Rather than ship Start/Step/Stop buttons that do
nothing, they're disabled with a clear reason. Once Phase 8 lands the process
runtime, the DAP client plugs into the breakpoints + launch configs already
modeled here: variables/watch/call-stack/debug-console fill in, and Start/F5 and
the debug toolbar activate.
