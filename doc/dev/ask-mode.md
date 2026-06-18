# Ask mode vs Agent mode

Zoc's agent panel has two primary conversation modes (the composer segmented
control): **Ask** and **Agent**. They share the same SSE run pipeline but must
present and behave very differently.

| | Ask | Agent |
|---|---|---|
| Intent | Read-only Q&A about the code | Build / refactor / edit / run |
| Tools | read/search only (`ASK_MODE_TOOLS`) | full tool set + approvals |
| Planner | skipped | runs |
| To-do checklist | disabled | enabled |
| Workflow cards | none (clean transcript) | analysis/plan/todo/tool/diff/review |
| Can change files | never | yes (review-before-apply) |
| Header | `Zoc Ask` · `Read-only answers` | `Zoc Agent` · `Auto run` |
| Autonomy control | hidden (shows `Read-only` pill) | visible |

The bug this fixes: Ask mode was read-only for *writes* but still planned,
wrote to-dos, and rendered Agent-run workflow cards — so a simple `hi` produced
a "Workspace analysis", "Plan", and "Respond to greeting" to-do.

## Backend

`services/agent/src/zoc_studio_agent/agent/orchestrator.py`
- `OrchestratorConfig` gained `enable_todos: bool = True` and
  `presentation_mode: str = "agent"`.
- The virtual `todo_write` tool schema is only exposed when `enable_todos`.
- The `todo_write` dispatch interception is gated on `enable_todos`: in Ask mode
  a stray `todo_write` call is swallowed (no `TodoUpdateEvent`) and the model is
  nudged to answer directly.
- `ASK_SYSTEM_PROMPT` is a read-only prompt: answer directly, no plan, no
  to-do, never claim files changed, suggest Agent mode for edits.

`services/agent/src/zoc_studio_agent/v1/agent_run.py`
- Computes `is_ask = payload.mode == "ask"` and builds the run config with
  `skip_planner=is_ask`, `enable_todos=not is_ask`, `allowed_tools=ASK_MODE_TOOLS`
  when Ask, and swaps in `ASK_SYSTEM_PROMPT`.

## Frontend

`apps/frontend/src/lib/store.ts`
- `consumeStream(stream, set, { mode })` captures the run mode at send time
  (passed from `sendUserMessage` via `runPayload.mode`).
- In Ask mode every workflow handler is a no-op: `contextLoading`,
  `contextReady`, `addToolCall`, `addDiff`, `setPlan`, `updatePlanStep`,
  `setTodos`, `addTestRun`, `addFinalSummary`, `setReviewRunId`,
  `setReviewValidation`. Assistant message streaming is always honored.

`apps/frontend/src/features/agent/AgentTimeline.tsx`
- `buildAskTranscript(items)` renders only `user_message`, `agent_message`,
  `clarification`, and `error` — so even stale Agent-run history from an earlier
  turn never shows as cards while Ask is selected.

`apps/frontend/src/features/agent/AgentPanel.tsx`
- Header title/subtitle are mode-aware (`Zoc Ask` / `Read-only answers` /
  `Answering…`).

`apps/frontend/src/features/agent/Composer.tsx`
- The autonomy control is replaced by a `Read-only` pill in Ask mode.

## Tests

- Backend: `services/agent/tests/test_orchestrator.py` —
  `test_ask_mode_skips_planner_and_emits_no_plan`,
  `test_ask_mode_swallows_stray_todo_write`,
  `test_agent_mode_still_plans_and_todos`.
- Frontend store: `apps/frontend/src/__tests__/store.test.ts` — Ask suppresses
  context/plan/todo/tool cards; Agent still creates plan + todo cards.
- Frontend render: `apps/frontend/src/__tests__/agent-panel-tools.test.tsx` —
  Ask renders a clean transcript and hides workflow cards even when stale items
  are present.

## Not changed

Plan and Debug modes are not yet distinct modes in the UI (the composer only
offers Ask/Agent). `presentation_mode` is carried through config so they can be
added without re-plumbing. Slash commands (`/review`, `/test`) remain Agent
operations and use the current store mode.
