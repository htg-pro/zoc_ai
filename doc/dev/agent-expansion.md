# Cursor-Style Agent Expansion (develop.md Phase 11)

Phase 11 is a large surface. This pass lands the **testable, local-first core**
of three pillars and is explicit about what's deferred to the desktop runtime.

| Pillar | Status |
|--------|--------|
| Queue controls (multi-message, reorder, stop-and-send) | **Done** |
| Rules visibility (`.zoc` / `.cursor` / `AGENTS.md`, nested) | **Done** (viewer) |
| MCP host config (`.zoc/mcp.json`, transports, merge) | **Done** (config + UI) |
| Browser / web-search / vision / image-gen / skills / subagents / hooks / live MCP transport | **Deferred** (runtime/external — see below) |

## Queue controls

The single held message (`queuedMessage`) became a real queue
(`messageQueue: QueuedMessage[]`) in the store:

- `queueUserMessage(content)` — append while a run is active (no-op when idle).
- `dequeueMessage(id)` / `clearQueue()` — remove one / all.
- `reorderQueue(from, to)` — move within bounds (out-of-range is a no-op).
- `stopAndSend(content)` — cancel the in-flight run and send immediately.
- On each run's terminal transition the **first** queued message is shifted and
  sent; the rest chain as subsequent runs complete (R4.11/R4.14). Stopping a run
  still clears the queue.

UI: `features/agent/MessageQueue.tsx` renders the queue above the composer with
drag reorder, up/down buttons, and per-item remove; the composer shows a count
and a **Stop & send** button while streaming. This satisfies the acceptance
check *"Queue can hold multiple messages and reorder them."*

## Rules visibility

`lib/rules-sources.ts` classifies workspace-relative rule paths into a
structured, ordered model:

- **Kinds**: `zoc` (`.zoc/rules`), `cursor` (`.cursor/rules` compatibility),
  `agents` (`AGENTS.md`), `other`.
- **Nested**: rules in a subdirectory (apply to that subtree) are flagged.
- **Order**: zoc → cursor → agents → other, root before nested, then
  alphabetical (roughly precedence order).

The backend remains the source of truth for the merged rule *text*
(`projectRules` from the sidecar); this module classifies the *sources* for
display. `features/agent/RulesDialog.tsx` opens from the composer's **Rules**
badge and shows the sources + merged rule text before a run — satisfying
*"Rules are visible before a run starts."*

## MCP host config

`lib/mcp-config.ts` parses Model Context Protocol server definitions:

- Reads `mcpServers` from a workspace `.zoc/mcp.json` and a user-level file
  (JSONC tolerated via `stripJsonComments`).
- **Transports**: `stdio` (command + args + env), `sse` (url), and streamable
  `http` (url). `detectTransport` honors an explicit `type`/`transport` and
  otherwise infers from `command`/`url`.
- **Merge**: `mergeMcpServers(user, workspace)` — workspace overrides user by id
  (documented precedence), sorted by id.
- `isToolAutoApproved(server, tool)` backs the `autoApprove` list so trusted
  tools skip the approval card; everything else routes through the existing
  tool-approval flow.

UI: `features/settings/sections/Mcp.tsx` (Settings → MCP Servers) reads
`.zoc/mcp.json` (in the desktop shell) and lists each server's transport,
command/url, scope, and auto-approve tools.

## Deferred (runtime / external — can't be verified in this environment)

These require a live runtime, external services, or a display and are
intentionally not stubbed:

- **Live MCP client** — spawning stdio servers, SSE/HTTP transports, the MCP
  handshake, tool discovery, and OAuth/token auth. Config + preview are ready;
  connected tools will flow through the existing approval cards.
- **Browser tool** — opening a local dev server and capturing screenshots needs
  a headless browser in the shell.
- **Web search tool** — needs network egress + a permission gate.
- **Image attachment / vision context** and **image generation** — depend on a
  vision-capable model and an image backend.
- **Skills, subagents, hooks** — local skill folders + picker, background
  research/reviewer agents with result merge, and tool/apply lifecycle hooks
  are larger runtime features tracked for a later pass.

## Tests

- `src/lib/__tests__/mcp-config.test.ts` — transport detection, stdio/url
  parsing, JSONC, invalid-drop, user/workspace merge precedence, auto-approve.
- `src/lib/__tests__/rules-sources.test.ts` — kind classification (incl. Windows
  separators), nested detection, ordering, summary.
- `src/__tests__/store.test.ts` — queue: hold-while-active, order, reorder
  (incl. out-of-range no-op), dequeue, clear, stop semantics.

Run: `node_modules/.bin/vitest run` from `apps/frontend`. Full suite: 270 green.
