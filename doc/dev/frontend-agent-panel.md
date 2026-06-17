# Frontend: Agent Panel & Store

How the agent UI is wired. Read before changing `lib/store.ts` or anything in
`features/agent/`.

## Architecture: pure modules + thin store + views

The frontend follows a **pure-modules-first** design. Correctness-critical
logic lives in pure, unit-tested modules under `apps/frontend/src/lib/`; the
Zustand store wires side effects around them; React components render store
state.

```
features/agent/*.tsx   ← React views (Composer, AgentTimeline, ContextBar, …)
        │  useApp(selector)
        ▼
lib/store.ts           ← Zustand store: state + actions + SSE consumption
        │  delegates pure logic to …
        ▼
lib/run-machine.ts     run lifecycle reducer (idle→running→awaiting_review→…)
lib/event-ingest.ts    SSE ordering / stale-event decisions
lib/reconnect.ts       bounded reconnection policy
lib/diff-utils.ts      unified-diff parse/classify/review summary
lib/plan-progress.ts   todo/plan progress (done/total/ratio)
lib/composer-validate  message validation (1–10,000 chars)
lib/context-usage.ts   context window ratio + ≥90% warning
lib/session-query.ts   session group/filter/sort/search
lib/layout.ts          panel sizing + persistence
lib/format-elapsed.ts  HH:MM:SS
lib/reduced-motion.ts  prefers-reduced-motion helpers
```

Each pure module has a `__tests__/*.prop.test.ts` fast-check property suite.
**Put new correctness logic in a pure module with a property test**, then wire
it into the store/views — not inline in a component.

## Store essentials (`lib/store.ts`)

Access via `useApp((s) => s.field)`. Key agent-related state/actions:

| Concern | State / action |
|---------|----------------|
| Streaming flags | `streaming`, `isRunning`, `runId` |
| Send a message | `sendUserMessage(content)` |
| Queue while busy | `queuedMessage`, `queueUserMessage(content)` (released on terminal transition) |
| Pause/resume gate | `agentPaused`, `pauseAgent()`, `resumeAgent()` |
| Stop | `cancelStream()` |
| Mode | `agentMode` (`ask` / `agent`), `setAgentMode` |
| Autonomy | `autonomy`, `setAutonomy` |
| Review (isolated run) | `reviewRunId`, `reviewValidation`, `applyCurrentRun()`, `discardCurrentRun()` |
| Per-file patches | `pendingPatches`, `acceptAllForDiff(id)`, `rejectAllForDiff(id)`, `acceptHunk`, `rejectHunk` |
| SSE consumption | `consumeStream(...)`, `applyAgentEvent(...)` |
| Timeline data | `agentItems` (workflow items: messages, todos, tools, diffs, …) |

### Run-start ordering (bug #4)

`sendUserMessage` **aborts the previous stream's `AbortController` before**
assigning the new `runId`, so a stale stream's terminal cleanup can't clobber
the new run. Preserve this ordering if you refactor the send path.

### Queued message (R4.11 / R4.14)

If the user sends while a run is active, the Composer calls
`queueUserMessage(...)` instead of `sendUserMessage(...)`. When the active run
hits its terminal `finally`, the store releases the queued message and sends it
once. `cancelStream()` clears the queue.

### Event consumption while paused (bug #1)

`consumeStream` holds streamed events while `agentPaused` is true (busy-wait
gate), so pause genuinely stops the UI from advancing rather than just hiding a
spinner.

## Components (`features/agent/`)

- `AgentPanel.tsx` — header + run controls; reads autonomy/model from the store
  (no hardcoded values).
- `Composer.tsx` — message input, validation, Ask/Agent toggle, autonomy cycle,
  queue-while-running.
- `AgentTimeline.tsx` — the unified run feed. Groups a run's to-dos + activity +
  review into one `AgentRunCard`. Contains:
  - `DiffReviewCard` — per-file checkboxes, animated count-up `+adds −dels`,
    validation badges, smart Apply routing (atomic backend apply when all files
    selected + isolated run present; per-file Tauri apply otherwise).
  - Activity feed rows with kind icons and pass/fail badges.
  - `FinalSummaryBlock` — checkpoint rollback control (two-step confirm,
    in-progress disabling, 10s timeout, inline error retention).
- `ContextBar.tsx` — context-window usage (warns ≥90%) + a `todoProgress` task
  summary bar.

## Diff review (`features/diff/DiffReviewView.tsx`)

Full-screen side-by-side / inline review. Apply paths **await** the result and
report accurately (success / partial / failed) — they no longer assume success.
Per-file and per-hunk accept/reject go through the store.

## Styling tokens

The agent panel appearance is driven by `--zoc-*` CSS variables in
`apps/frontend/src/styles/globals.css` (full neutral scale + accent colors).
**Undefined tokens = broken UI** — if you reference a new token, define it
there first.

## Adding behavior — checklist

1. Pure logic → new/existing `lib/*.ts` module + `__tests__/*.prop.test.ts`.
2. Wire side effects in `store.ts`; keep selectors backward-compatible.
3. Render in a `features/agent/*.tsx` component using `useApp`.
4. If it consumes a new SSE event, handle it in `applyAgentEvent` (no-op until
   wired).
5. `node_modules/.bin/tsc --noEmit` and `node_modules/.bin/vitest run` must be
   green.
