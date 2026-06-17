# Inline Edit (Cmd-K)

Select code in the editor, press **Cmd-K** (Ctrl-K), type an instruction, and
the model rewrites just that selection. The result appears as a reviewable diff
you Apply or Reject in place — Cursor's most-used feature.

## Flow

```
select code → Cmd-K → type instruction → Enter
   │
   ├─ capture {selection, offsets, language, prefix/suffix}   (MonacoView command)
   ├─ POST /v1/sessions/{id}/inline-edit                       (single LLM call, no tool loop)
   ├─ splice rewritten selection back into the file            (lib/inline-edit.spliceText)
   ├─ build a whole-file unified diff                          (lib/inline-edit.buildInlineEditPatch)
   └─ queue as a pendingPatch → inline diff banner → Apply / Reject
```

It deliberately reuses the existing **pendingPatches → diff preview → applyPatch**
infrastructure, so the change lands through the same validated Tauri write path
as agent edits.

## Backend

- `modes/inline_edit.py::run_inline_edit` — one `provider.chat()` call with a
  focused system prompt; returns only the replacement text. `strip_code_fence`
  defensively unwraps a stray Markdown fence.
- `v1/inline_edit.py` — `POST /sessions/{id}/inline-edit` → `InlineEditResult
  { edited }`. Resolves the session provider, or an ad-hoc OpenAI-compatible
  provider when bring-your-own creds (`api_key`+`base_url`+`model`) are sent.
- `InlineEditResult` added to the shared schema (Python + generated TS).

## Frontend

- `lib/inline-edit.ts` (pure, property-tested) — `spliceText`,
  `surroundingContext`, `stripCodeFence`, `buildInlineEditPatch` (via the `diff`
  package).
- `lib/agent-client.ts` — `inlineEdit(sessionId, req)` (maps camelCase creds to
  the snake_case route body).
- `lib/store.ts` — `inlineEdit` UI state + `openInlineEdit` / `closeInlineEdit`
  / `submitInlineEdit` (calls the client, splices, queues the patch).
- `features/editor/MonacoView.tsx` — registers the editor-scoped Cmd-K command
  (so it doesn't collide with the global Cmd-K palette) that captures the
  selection and opens the prompt.
- `features/editor/InlineEditPrompt.tsx` — the floating Cmd-K input overlay.
- `features/editor/EditorArea.tsx` — the proposed-edit banner now has inline
  **Apply** / **Reject** (also improves agent-proposed patches).

## Tests

- Backend `tests/test_inline_edit.py` (3): fence stripping, route round-trip,
  fence-strip via the route.
- Frontend `lib/__tests__/inline-edit.prop.test.ts` (5): splice identity/clamp,
  context window bounds, fence idempotence, patch build/null.

Backend 196 / frontend 120 green; `tsc` + `ruff` clean.

## Notes / future
- After Apply, the Tauri fs watcher refreshes the buffer; in browser preview
  the write is a no-op.
- Possible follow-ups: stream the edit for large selections, a "diff inline in
  the editor gutter" preview, and multi-selection edits.
