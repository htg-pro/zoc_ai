# Terminal (Phase 8)

A multi-session terminal with tabs, shell profiles, split view, kill/rename,
find, exit-status tracking, and clickable file links. The PTY itself already
lives in the FastAPI sidecar (reached through `agent-client`); Phase 8 is the
frontend session model + UI on top of it.

## Session model (`apps/frontend/src/lib/store.ts`)

- `terminals: TerminalSession[]` (`id`, `title`, `profileId`, `status`,
  `exitCode`), `activeTerminalId`, `terminalProfiles` (platform-aware defaults),
  `terminalSplit`.
- Actions: `newTerminal(profileId?)` (auto-numbers duplicate titles, sets
  active), `closeTerminal` (reassigns active to a neighbor), `setActiveTerminal`,
  `renameTerminal`, `setTerminalExited(id, code)` (called by the manager),
  `toggleTerminalSplit`.

This is the serializable shadow; the live xterm + PTY are owned by the manager.

## Manager (`apps/frontend/src/lib/terminal-manager.ts`)

A non-React singleton keyed by the store's terminal id. Each instance owns a
**detached container `<div>`** plus the xterm instance and the PTY stream, so a
session survives bottom-dock tab switches (the pane mounts/unmounts the container
but never disposes it). Surface:

- `createTerminal(id, profile, cwd?)` — lazy-imports xterm + fit, spawns the PTY
  via `agent-client.spawnTerminal` (falls back to a local-echo mock offline),
  streams output, wires input, and registers a `file:line` link provider.
- `mountTerminal(id, parent)` / `unmountTerminal(id)` — attach/detach + fit +
  `ResizeObserver` (resizes the PTY).
- `findInTerminal(id, query, dir)` — dependency-free buffer scan + scroll.
- `killTerminal(id)` — stops the backend PTY (keeps scrollback).
- `disposeTerminal(id)` — abort stream + stop PTY + dispose xterm + drop.
- `setTerminalCallbacks({ onExit, onOpenLink })` — the pane wires exit → store,
  link clicks → `openFile`.

## UI (`apps/frontend/src/features/terminal/TerminalPane.tsx`)

- Tab strip: per-session tabs (double-click to rename, exit-code badge,
  close button), a **+ New Terminal** button with a **profile dropdown**, a
  **Split** toggle, and **Kill**.
- `TerminalSurface` mounts a manager container and hosts a **find** box
  (Ctrl/Cmd+F) with next/prev.
- Split view renders the active terminal beside the next one.
- The old **fake hardcoded agent-approval overlay was removed** — real agent
  command approval already flows through the agent panel's tool-approval cards
  (the permission flow), not a mock prompt in the terminal.

## Acceptance checks (develop.md)

- Multiple terminals persist while switching bottom tabs ✓ (detached containers
  in the manager; only `unmount`/`mount`, never dispose, on tab switch)
- Terminal kill stops the backend session ✓ (`killTerminal` → `stopTerminal`)
- Shell profile selection is honored ✓ (profile → `spawnTerminal(command, …)`)
- Agent approval card shows the actual command/result ✓ (fake removed; the real
  approval is the agent panel's permission card)

## Tests

- `__tests__/store.test.ts` — create with numbered titles + active selection,
  close reassigns active, rename, exit status, split toggle.

The manager's xterm/PTY paths are runtime (DOM + sidecar) and are exercised in
the running app rather than unit tests.

## Unblocks (follow-up)

The long-lived, streaming PTY transport here is the same shape needed by the
deferred work: **task output streaming + cancellation** (Phase 6) and the
**debug-adapter session** (Phase 7) can now be built on the sidecar process
channel. Shell-integration decorations (OSC 133 prompt/exit markers) and
open-at-folder/copy-paste affordances remain to round out.
