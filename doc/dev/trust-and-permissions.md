# Safety, Permissions & Trust (develop.md Phase 13)

A unified, workspace-aware permission model layered over the existing per-tool
agent grants. One pure decision engine governs every privileged action — agent
tools, terminal commands, tasks, Git, MCP tools, plugin actions, and filesystem
operations — driven by a persisted Workspace Trust config and recorded in an
audit log.

## What landed

| Piece | File |
|-------|------|
| Pure decision engine (`evaluatePermission`) + path helpers | `apps/frontend/src/lib/permissions-engine.ts` |
| Trust config persistence + audit log + `checkAction` | `apps/frontend/src/lib/trust.ts` |
| Task execution gate | `apps/frontend/src/lib/store.ts` (`runTask`) |
| Plugin action gate | `apps/frontend/src/lib/plugins.ts` (contributed command `run`) |
| Trust & Safety UI | `apps/frontend/src/features/settings/sections/Trust.tsx` |
| Commands: "Manage Trust & Safety" | `apps/frontend/src/lib/commands.ts` |

## Decision engine

`evaluatePermission(config, request, workspaceRoot?) → { effect, reason }` where
`effect` is `allow | deny | prompt`. Precedence:

1. **Read-only** actions are always allowed.
2. **Workspace trust gate** — a `restricted` workspace **denies** all execution
   kinds (`terminal`, `task`, `plugin`, `agent_tool`, `mcp`, `git`) until
   trusted. (Acceptance: *restricted workspace blocks terminal/task/plugin
   execution until trusted*.)
3. **Filesystem protections** — deletion (`protectDeletions`), dotfiles
   (`protectDotfiles`, e.g. `.env`), and external paths (`protectExternal`,
   outside the workspace root) → **prompt** for confirmation.
4. **Destructive actions** require explicit confirmation **or** an allowlist
   entry — even in "Run everything" mode. (Acceptance: *destructive actions
   require explicit confirmation or allowlist*.)
5. **Network** actions require an allowlisted host.
6. **Run mode** decides the rest:
   - `ask` — prompt unless allowlisted.
   - `allowlist` — allow allowlisted, prompt otherwise.
   - `sandboxed` — allow sandboxable actions, prompt otherwise.
   - `all` — allow (destructive still gated by step 4).

Helpers `isDotfile`, `isExternalPath`, and `matchesAllowlist` (exact or
whitespace-delimited prefix) are exported and tested.

## Trust config + audit log

`lib/trust.ts` persists the `PermissionConfig` (trust state, run mode, the
command/MCP/network allowlists, and the three protections) to localStorage
(`zoc.trust.config`) and keeps an in-memory audit log (capped at 500). Defaults
are deliberately conservative: **restricted** workspace, **ask-every-time** run
mode, all protections on.

`checkAction(request, workspaceRoot?)` evaluates against the live config **and**
records the decision — so every permission decision is auditable. (Acceptance:
*permission decisions are recorded*.) Setters (`setTrust`, `setRunMode`,
`setProtection`, `addToAllowlist`, `removeFromAllowlist`) persist and notify via
`subscribeTrust`.

## Integration points

- **Tasks** — `store.runTask` calls `checkAction({ kind: "task", … })`; a
  restricted workspace blocks the run with a toast + log entry and never invokes
  the command.
- **Plugins** — a contributed command's `run()` calls
  `checkAction({ kind: "plugin", … })`; restricted workspaces block the action
  and log it to the plugin host log.

Other call sites (terminal send, Git operations, MCP tool invocation, agent
filesystem writes) consume the same `checkAction` API; wiring them through is a
mechanical follow-up as those runtimes land. The engine already encodes the full
policy for every kind.

## UI

Settings → **Trust & Safety** (`TrustSection`): trust/restrict toggle with a
status banner, run-mode selector, the three protection switches, add/remove
editors for the command/MCP/network allowlists, and the audit log viewer (with
clear). The `workbench.action.manageTrust` command (palette: "Workspace: Manage
Trust & Safety") deep-links here.

## Acceptance checks (develop.md)

- **Restricted workspace blocks terminal/task/plugin execution until trusted** —
  trust gate (engine) + `runTask` / plugin-command gates.
- **Destructive actions require explicit confirmation or allowlist** — step 4 of
  the engine, verified including "Run everything" mode.
- **Permission decisions are recorded** — `checkAction` → audit log.

## Tests

- `src/lib/__tests__/permissions-engine.test.ts` (17) — path helpers, trust
  gate, protections, destructive gating, network, every run mode.
- `src/lib/__tests__/trust.test.ts` (5) — defaults, persistence, allowlist
  add/remove dedupe, `checkAction` audit recording, clear.
- `src/__tests__/store.test.ts` — `runTask` blocked in a restricted workspace.

Run: `node_modules/.bin/vitest run` from `apps/frontend`. Full suite: 307 green.

## Deferred (runtime)

- Wiring the gate into the terminal PTY send path, live Git operations, MCP tool
  invocation, and agent filesystem writes (the engine + `checkAction` are ready;
  these are call-site hookups in runtime code paths).
- A true OS-level sandbox for "sandboxed" mode (today it's a policy signal).
- Surfacing `prompt` decisions as an interactive confirmation dialog at every
  call site (the agent tool-approval flow already provides this for tools).
