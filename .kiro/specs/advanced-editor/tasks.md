# Implementation Plan: Advanced Editor Features (Part 8)

## Progress (2026-07-24)

- **8.2 gateway route — DONE + verified.** `services/gateway/src/zocai_gateway/routes/inline.py`:
  `InlineEditRequest`, pure `build_inline_edit_prompt` (replacement-only system
  prompt + selection/context/instruction), `strip_code_fences`, and
  `stream_inline_edit_events` (SSE `token`* then one `done` carrying the
  fence-stripped replacement; temperature 0.1, max_tokens 512; fails quiet).
  Registered at `POST /v1/agent/inline-edit` behind `require_admission` in
  `app.py`. `test_inline_edit.py` (7): prompt, fences, ordered-tokens-then-done,
  fence-stripped done, empty-stream terminal, loopback-admitted, non-loopback-
  rejected. Full gateway suite **797 passed**; ruff + mypy clean.

## Tasks

- [x] 1. §8.2 Inline ⌘K edit — **DONE + verified**
  - [x] 1.1 Gateway `POST /v1/agent/inline-edit` route (`routes/inline.py`) + tests (7).
  - [x] 1.2 `features/agent/inline-edit-client.ts` `streamInlineEdit` (pure SSE
    `consumeInlineEditStream`, 10 tests) + `features/editor/InlineEditOverlay.tsx`
    (⌘K floating input → Monaco `DiffEditor` preview, Accept / Discard-Esc),
    mounted in `MonacoView.tsx`. Typecheck + eslint clean.
- [x] 2. §8.1 Multi-cursor agent edits — **DONE + verified**
  `features/editor/AgentEditAnimator.ts`: pure `computeEditPlan(text, edits)` →
  ordered `{range, insertText, decorationRange}[]` (14 tests incl. fast-check) +
  a thin animator (injected editor + clock; one-undo `executeEdits`, ~50ms green
  flash `.agent-edit-flash`, per-file toast). Editor-folder vitest green.

## Notes
- The verified deliverable is the gateway route (task 1.1). Tasks 1.2 and 2 are
  Monaco/DOM UI (visual), consuming the route + the `edit-file` events.
