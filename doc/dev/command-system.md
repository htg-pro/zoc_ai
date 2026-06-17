# Command system & palette (Phase 1)

A single command registry is the source of truth for every major action. The
command palette, the global keyboard shortcuts, and (over time) toolbar/menu
buttons all resolve through it instead of hardcoding behavior.

## Pieces

| File | Role |
|------|------|
| `apps/frontend/src/lib/commands.ts` | The registry: `Command` type, `COMMANDS`, keybinding parse/format/match, `runCommand(id)`. |
| `apps/frontend/src/lib/recents.ts` | Recent files + recent command ids (localStorage, pure `pushRecent`). |
| `apps/frontend/src/lib/key-bindings.ts` | `useGlobalShortcuts` — one keydown listener that matches the registry and runs the command. |
| `apps/frontend/src/features/palette/CommandPalette.tsx` | The palette UI with Go-to-File / command / symbol modes. |

## Command shape

```ts
interface Command {
  id: string;                 // "workbench.action.quickOpen", "zoc.agent.run"
  title: string;
  category: "Go" | "View" | "File" | "Agent" | "Terminal" | "Preferences";
  keybinding?: string;        // normalized: "mod+p", "mod+shift+d"
  extraKeybindings?: string[];// additional bindings (e.g. "mod+k" for the palette)
  aliases?: string[];         // familiar VS Code / Cursor names for search
  icon?: string;              // lucide icon name, resolved in the palette
  enabled?: (s) => boolean;   // false ⇒ shown disabled
  disabledReason?: (s) => string | null;  // why (surfaced in the palette)
  run: () => void | Promise<void>;
}
```

Handlers reach the app via `useApp.getState()`, so the registry stays
decoupled from React. Keybinding matching (`eventToKeybinding`,
`matchKeybinding`, `formatKeybinding`) is pure and unit-tested without a DOM.

### Keybinding grammar

Lowercase, `+`-joined: `mod` (Cmd on macOS, Ctrl elsewhere), `shift`, `alt`,
then the key. e.g. `mod+shift+p`. `formatKeybinding` renders `⌘⇧P` on macOS and
`Ctrl+Shift+P` elsewhere.

## Palette modes

The input prefix selects the mode:

- (no prefix) → **Go to File**: live workspace search via the store's
  `searchContextCandidates` (backend-backed; falls back to open files only when
  the sidecar is unavailable — never mock data in live mode). Shows recent files
  when the query is empty.
- `>` → **Commands**: the registry, grouped by category, with keybindings and a
  disabled-reason for unavailable surfaces.
- `@` → **Symbols**: workspace symbols from the same search, filtered to
  `kind === "symbol"`.

Commands `workbench.action.quickOpen` / `showCommands` / `gotoSymbol` open the
palette seeded with the right prefix (`openPalette(seed)` on the store).

## Registered commands

Go: quickOpen (⌘P), showCommands (⌘⇧P / ⌘K), gotoSymbol.
View: explorer (⌘1), search (⌘⇧F), indexer (⌘2), sessions (⌘3), scm·debug·extensions
(disabled — Phases 4/7/12), toggle sidebar (⌘B), toggle panel (⌘J), toggle agent
panel (⌘I), problems (⌘⇧M).
Terminal: toggle terminal (⌘`).
File: save (⌘S), save all (⌘⌥S), revert.
Preferences: open settings (⌘,).
Agent: ask, run, reviewChanges (⌘⇧D), applyRun, discardRun, restoreCheckpoint
(the last three gated on pending/applied run state).

Unavailable views are listed but disabled with an honest reason (e.g. "Source
Control isn't available yet (develop.md Phase 4)") rather than hidden — they
light up as their phases land.

## Store additions

- `paletteSeed` + `openPalette(seed)` — open the palette in a given mode.
- `saveAllFiles()` — persist every dirty buffer, returns the count written.
- `revertActiveFile()` — reload the active file from disk/mock, drop edits.
- `openFile` now records the path in the recent-files list.

## Tests

- `lib/__tests__/commands.test.ts` — required ids present; event→binding
  normalization; mac/non-mac formatting; match resolves quickOpen and the
  ⌘K/⌘⇧P aliases; disabled command's key falls through; unavailable views carry
  a reason; apply/discard gated on `reviewRunId`.
- `lib/__tests__/recents.test.ts` — `pushRecent` dedupe/cap/order; localStorage
  round-trip for files and commands.
- `__tests__/command-palette.test.tsx` — command mode lists registry commands,
  shows disabled reasons, filters as you type, and file mode searches without
  mock data.

(`src/__tests__/setup.ts` gained a `scrollIntoView` no-op polyfill that cmdk
needs under jsdom.)

## Not yet

Symbol search depends on the backend returning `kind: "symbol"` candidates;
until the symbol index is richer it returns mostly files/folders. Wiring the
remaining toolbar/activity-bar buttons through `runCommand` is incremental and
can happen as each surface is touched.
