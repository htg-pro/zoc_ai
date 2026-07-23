# Implementation Plan: Editor Diagnostics & Inline Completions

## Overview

This plan implements the two capabilities in the approved design: **§3.2 LSP diagnostics into the Problems panel** (a net-new bridge over the existing LSP client + `diagnostics` store + `ProblemsPanel`) and **§3.3 inline AI completions** (a net-new Monaco `InlineCompletionsProvider` and a net-new `POST /v1/completions` Gateway route).

The design specifies concrete languages, so no implementation-language choice is required:

- **Frontend** work is **TypeScript** (`apps/frontend`), tested with **Vitest + fast-check** (Properties 1–10).
- **Gateway** work is **Python** (`services/gateway`), tested with **pytest + Hypothesis** (Properties 11–17).

The work is **refactor-first**: it reuses — and does not re-specify — the completed `monaco-lsp-integration` layer (transport/client/proxy), the existing `Diagnostic` model + `countBySeverity` (`problem-matchers.ts`), the `diagnostics` store slice (`setDiagnostics`/`clearDiagnostics`), `onFsChanged`/`fsStat` (`tauri-bridge.ts`), `openFile`/`input`/`setInput`/`setAgentMode`, `model_runtime` (`generate_text`/`generate_text_stream`), `auth.py` (`require_admission`/`is_request_admitted`), and the `app.py` SSE (`EventSourceResponse`) + per-run queue bridge pattern.

Ordering is incremental and test-driven: pure cores first (with their property tests), then the seams that consume them, ending with the wiring that integrates each net-new module so no code is left orphaned.

## Tasks

- [x] 1. §3.2 Diagnostics bridge — pure mapping core and derived helpers (net-new)
  - [x] 1.1 Implement the diagnostics-bridge pure mapping and key helpers
    - Create `apps/frontend/src/features/editor/lsp/diagnostics-bridge.ts`.
    - Define the `LspDiagnostic` interface and `LSP_SOURCE_PREFIX`, `lspSourceKey(uri)`, `isLspSourceKey(key)`.
    - Implement `mapSeverity(sev?)` (`1→error, 2→warning, 3→info, 4→hint`, missing `→ error`).
    - Implement `uriToFsPath(uri)` as the inverse of `toMonacoModelUri` (POSIX + Windows `file:///C:/…` forms, percent-decoding, non-`file:` passthrough).
    - Implement `mapLspDiagnostic(server, uri, d)` and `mapPublishedDiagnostics(server, uri, diags)` (line/column `+1`, `message` verbatim, `source` fallback to Server_Name, `code` = `String(code)` or unset).
    - Implement the pure `lspKeysForDeletedFiles(diagnostics, deletedPaths)`.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 2.1, 5.2, 5.3, 5.4_

  - [x]* 1.2 Write property test for LSP → Diagnostic mapping
    - In `apps/frontend/src/features/editor/lsp/__tests__/diagnostics-bridge.prop.test.ts` (fast-check, `numRuns >= 100`).
    - **Property 1: LSP → Diagnostic mapping is total and field-faithful**
    - **Validates: Requirements 1.1, 1.4, 1.5, 1.6, 1.7**

  - [x]* 1.3 Write property test for severity mapping
    - Same file `diagnostics-bridge.prop.test.ts` (fast-check, `numRuns >= 100`).
    - **Property 2: LSP severity maps by the fixed table, defaulting to error**
    - **Validates: Requirements 1.2, 1.3**

  - [x]* 1.4 Write property test for deleted-file key selection
    - Same file `diagnostics-bridge.prop.test.ts`; targets pure `lspKeysForDeletedFiles` (fast-check, `numRuns >= 100`).
    - **Property 5: Deleted-file cleanup clears only the named deleted LSP entries**
    - **Validates: Requirements 5.2, 5.3, 5.4**

  - [x] 1.5 Implement the Problems badge derivation
    - Create `apps/frontend/src/lib/problems-badge.ts` with `BadgeColor`, `ProblemsBadge`, and pure `problemsBadge(diagnostics)` (count = errors+warnings across all `lsp:*` and checker entries; color = error/warning/none; visible = count > 0).
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

  - [x]* 1.6 Write property test for the Problems badge
    - In `apps/frontend/src/lib/__tests__/problems-badge.prop.test.ts` (fast-check, `numRuns >= 100`).
    - **Property 4: Problems badge is an exact function of store contents**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6**

  - [x] 1.7 Implement the "fix errors" prompt builder
    - Create `apps/frontend/src/features/problems/fix-errors-prompt.ts` with pure `errorCount(diagnostics)` and `buildFixErrorsPrompt(file, diagnostics)` (names the file; enumerates only `error`-severity diagnostics with `line`, `column`, `message`; omits warning/info/hint).
    - _Requirements: 6.1, 6.2, 6.3_

  - [x]* 1.8 Write property test for the "fix errors" prompt builder
    - In `apps/frontend/src/features/problems/__tests__/fix-errors-prompt.prop.test.ts` (fast-check, `numRuns >= 100`).
    - **Property 6: "Run agent to fix N errors" enumerates only errors**
    - **Validates: Requirements 6.1, 6.2, 6.3**

- [x] 2. §3.2 Diagnostics bridge — stateful effects and LSP client interception
  - [x] 2.1 Implement `createDiagnosticsBridge` effects
    - Extend `apps/frontend/src/features/editor/lsp/diagnostics-bridge.ts` with `DiagnosticsBridgeDeps`, `DiagnosticsBridge`, and `createDiagnosticsBridge(deps)`.
    - `onPublishDiagnostics(server, uri, diags)`: non-empty → `setDiagnostics(lspSourceKey(uri), mapPublishedDiagnostics(...))`; empty → `clearDiagnostics(lspSourceKey(uri))`; mutate only that one URI key.
    - fs cleanup: subscribe via `onFsChanged`, confirm deletion with `fsStat(path).exists === false` (treat `null` as "cannot confirm"), clear `lspKeysForDeletedFiles(getDiagnostics(), deleted)`; `dispose()` unsubscribes so later events are ignored.
    - _Requirements: 2.2, 2.3, 2.4, 2.5, 5.1, 5.2, 5.3, 5.4, 5.5, 7.1_

  - [x]* 2.2 Write property test for per-URI replace/isolation
    - Same file `diagnostics-bridge.prop.test.ts`; drive `onPublishDiagnostics` against injected `setDiagnostics`/`clearDiagnostics`/`getDiagnostics` spies or a real store (fast-check, `numRuns >= 100`).
    - **Property 3: Per-URI LSP diagnostics replace and isolate**
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5**

  - [x] 2.3 Wire the publishDiagnostics middleware in the LSP client
    - Refine `apps/frontend/src/features/editor/lsp/lsp-client.ts`: add optional `onPublishDiagnostics` to `LspClientDeps`; thread `deps` into `defaultCreateLanguageClient` and add `clientOptions.middleware.handleDiagnostics(uri, diagnostics, next)` that calls `deps.onPublishDiagnostics?.(server, uri.toString(), diagnostics)` in a `try` and always calls `next(uri, diagnostics)` in a `finally` to preserve native squiggles.
    - _Requirements: 1.1, 2.6_

  - [x]* 2.4 Write unit test for the middleware wiring
    - In `apps/frontend/src/features/editor/lsp/__tests__/lsp-client-diagnostics.test.ts`: assert `onPublishDiagnostics` is called with the stringified URI and that `next` is invoked even when the hook throws.
    - _Requirements: 1.1_

- [x] 3. §3.2 Editor navigation, Problems panel, and badge surfaces (refine)
  - [x] 3.1 Add exact-position reveal to editor-actions
    - Refine `apps/frontend/src/lib/editor-actions.ts`: add `revealPosition(line, column)` (calls `revealLineInCenter` + `setPosition` + `focus`), plus a pending-target buffer with `requestReveal(path, line, column)` and `takePendingReveal(path)` (single-consume; stale path discarded).
    - _Requirements: 3.2, 3.3_

  - [x]* 3.2 Write unit test for reveal + pending buffer
    - In `apps/frontend/src/lib/__tests__/editor-actions-reveal.test.ts`: assert `revealPosition` fires the three editor calls; `requestReveal`/`takePendingReveal` buffer and consume once; a different-path request discards a stale target.
    - _Requirements: 3.2, 3.3_

  - [x] 3.3 Refine MonacoView marker mirror and pending reveal
    - Refine `apps/frontend/src/features/editor/MonacoView.tsx`: change the diagnostics→marker effect to iterate store entries and skip `lsp:`-prefixed keys (native markers own LSP squiggles); on mount and on active-file change, call `takePendingReveal(file.path)` and `revealPosition(...)` when a target is present.
    - _Requirements: 2.6, 3.2, 3.3_

  - [x] 3.4 Refine ProblemsPanel entry navigation and per-file fix action
    - Refine `apps/frontend/src/features/problems/ProblemsPanel.tsx`: on diagnostic-entry click, `openFile(abs)` then navigate (already-active file → `revealPosition(d.line, d.column)`; otherwise `requestReveal(abs, d.line, d.column)`); for each file group with `errorCount >= 1`, render a "Run agent to fix N errors" button that calls `buildFixErrorsPrompt`, `setInput(prompt)` (replace draft), and `setAgentMode("agent")`, leaving the draft editable and unsent.
    - _Requirements: 3.1, 3.4, 6.1, 6.2, 6.4, 6.5, 6.6_

  - [x]* 3.5 Write integration tests for the Problems panel
    - In `apps/frontend/src/features/problems/__tests__/ProblemsPanel.test.tsx`: coexistence rendering of an `lsp:<uri>` entry and a `typescript` checker entry under one file group each showing its own `source` (R2.6); entry click calls `openFile` + reveal and re-activates an already-open file without reload (R3.1–R3.4); the fix action replaces `input`, calls `setAgentMode("agent")`, and dispatches no run (R6.4–R6.6); checker diagnostics render and the empty state shows when the store is empty (R7.3, R7.4).
    - _Requirements: 2.6, 3.1, 3.2, 3.3, 3.4, 6.4, 6.5, 6.6, 7.3, 7.4_

  - [x] 3.6 Consume the badge derivation in the dock and status bar
    - Refine `apps/frontend/src/components/layout/BottomDock.tsx` and `apps/frontend/src/components/layout/StatusBar.tsx` to read `problemsBadge(useApp(s => s.diagnostics))` and render count/color/visibility from it (status bar keeps its split error/warning glyphs driven by the same counts).
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

  - [x]* 3.7 Write unit test for the badge surfaces
    - In `apps/frontend/src/components/layout/__tests__/problems-badge-surfaces.test.tsx`: seed the store with mixed `lsp:*` and checker entries and assert the dock pill / status-bar indicator reflect the derived count, color, and visibility.
    - _Requirements: 4.2, 4.3, 4.4, 4.5_

- [x] 4. §3.2 Wire the diagnostics bridge into the editor LSP lifecycle
  - [x] 4.1 Instantiate and connect the bridge
    - Refine `apps/frontend/src/features/editor/useLspLifecycle.ts`: build `createDiagnosticsBridge({ setDiagnostics, clearDiagnostics, getDiagnostics, onFsChanged, fsStat })` from the store actions and `tauri-bridge`, pass `onPublishDiagnostics: bridge.onPublishDiagnostics` into `createLspClient(deps)`, and call `bridge.dispose()` in the effect cleanup.
    - _Requirements: 1.1, 5.1, 5.5, 7.1, 7.2_

  - [x]* 4.2 Write integration test for wiring and deleted-file cleanup
    - In `apps/frontend/src/features/editor/__tests__/useLspLifecycle-diagnostics.test.ts`: with no connected server, no `lsp:*` keys are created and checker entries are untouched (R7.1, R7.2); an `fs://changed` event for a confirmed-deleted file clears its `lsp:*` entry, and events after `dispose()` leave the store unchanged (R5.1, R5.5).
    - _Requirements: 5.1, 5.5, 7.1, 7.2_

- [x] 5. Checkpoint — §3.2 diagnostics complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. §3.3 Gateway model-runtime stop parameter and pure completion helpers
  - [x] 6.1 Thread an optional stop sequence through the streaming call
    - Refine `services/gateway/src/zocai_gateway/model_runtime.py`: add `stop: Sequence[str] | None = None` to `generate_text_stream`, forwarding it as `"stop"` in the OpenAI-compatible payload (and Anthropic `stop_sequences` on that provider's bounded non-streaming branch). Keep it backward-compatible (existing callers pass nothing).
    - _Requirements: 11.4, 11.5_

  - [x]* 6.2 Write regression test for the stop parameter
    - In `services/gateway/tests/test_completions_stop_forwarding.py`: assert `stop` is placed in the request payload when provided and that omitting it leaves existing callers' payloads unchanged.
    - _Requirements: 11.4_

  - [x] 6.3 Implement the completions request model and pure helpers
    - Create `services/gateway/src/zocai_gateway/routes/completions.py` (FastAPI-free core): `CompletionRequest` (Pydantic, `filePath` alias, prefix/suffix may be `""`), `model_supports_fim(provider, model)` (conservative id allowlist, default `False`), `build_fim_prompt(prefix, suffix)` (`<PRE>{}<SUF>{}<MID>`), `build_fallback_prompt(prefix, suffix, language)`, `completion_stop_sequences(language)` (≥1), and `CompletionCache` (`get`/`put`, 30 s TTL, stores non-empty only, reads do not refresh age).
    - _Requirements: 11.1, 11.2, 11.3, 13.1, 11.4, 14.1, 14.2, 14.3, 14.4, 14.5_

  - [x]* 6.4 Write property test for prompt selection
    - In `services/gateway/tests/test_completions_prompts_property.py` (Hypothesis, ≥100 examples).
    - **Property 11: Prompt selection matches model FIM capability**
    - **Validates: Requirements 11.3, 13.1**

  - [x]* 6.5 Write property test for request validation
    - In `services/gateway/tests/test_completions_validation_property.py`; drive `CompletionRequest` with a spy `model_runtime` to prove no model call on invalid input (Hypothesis, ≥100 examples).
    - **Property 13: Invalid requests are rejected without calling the model**
    - **Validates: Requirements 11.2**

  - [x]* 6.6 Write property test for the completion cache
    - In `services/gateway/tests/test_completions_cache_property.py`; include boundary examples at the 30 s TTL (Hypothesis, ≥100 examples).
    - **Property 15: The completion cache returns fresh non-empty entries and never stores empties**
    - **Validates: Requirements 14.1, 14.2, 14.3, 14.4, 14.5**

- [x] 7. §3.3 Gateway completions endpoint handler and streaming
  - [x] 7.1 Implement the completions handler core and SSE streaming
    - Extend `services/gateway/src/zocai_gateway/routes/completions.py` with the `POST /v1/completions` handler: build an `AgentRunRequest` (temperature 0.1, max 128 tokens) with the FIM or fallback prompt; on a fresh non-empty cache hit stream it with no model call; otherwise run `generate_text_stream(req, on_token=push, stop=completion_stop_sequences(language))` in a worker thread whose `on_token` pushes onto an `asyncio.Queue` via `loop.call_soon_threadsafe` (the `app.py` `_Run._put` pattern); emit one `token` SSE event per chunk and exactly one distinct `done` terminal in a `finally`; `cache.put` iff non-empty; handle resilience (`None` / error-before-first-token → immediate empty terminal; error-after-tokens → stop + terminal; no error event).
    - _Requirements: 11.5, 12.1, 12.2, 12.3, 12.4, 13.2, 13.3, 14.1, 14.2, 14.3, 14.5, 16.1, 16.2, 16.5_

  - [x]* 7.2 Write property test for fixed completion parameters
    - Same file `services/gateway/tests/test_completions_prompts_property.py`; capture the `AgentRunRequest`/`stop` passed to a spy `model_runtime` on both FIM and fallback paths (Hypothesis, ≥100 examples).
    - **Property 12: Model is always called with the fixed completion parameters**
    - **Validates: Requirements 11.4, 13.2**

  - [x]* 7.3 Write property test for the SSE token/terminal protocol
    - In `services/gateway/tests/test_completions_stream_property.py`; drive the handler with a fake token generator (Hypothesis, ≥100 examples).
    - **Property 14: The SSE stream carries ordered token events and exactly one distinct terminal**
    - **Validates: Requirements 12.1, 12.2, 12.3, 12.4, 13.3**

  - [x]* 7.4 Write property test for quiet failure
    - Same file `services/gateway/tests/test_completions_stream_property.py`; use a fake `model_runtime` that returns `None` or raises before/after the first token (Hypothesis, ≥100 examples).
    - **Property 17: The endpoint fails quietly to an empty, error-free stream**
    - **Validates: Requirements 16.1, 16.2, 16.5**

- [x] 8. §3.3 Register the completions route behind admission
  - [x] 8.1 Register the route and construct the process-wide cache
    - Refine `services/gateway/src/zocai_gateway/app.py`: register the `POST /v1/completions` route with `dependencies=[Depends(require_admission)]`, construct one `CompletionCache` on `app.state` (like the other registries), and add no new listening interface.
    - _Requirements: 15.1, 15.4_

  - [x]* 8.2 Write property test for admission-gated model invocation
    - In `services/gateway/tests/test_completions_admission_property.py`; reuse `is_request_admitted` and a spy `model_runtime` (Hypothesis, ≥100 examples).
    - **Property 16: The endpoint invokes the model only for admitted requests**
    - **Validates: Requirements 15.2, 15.3, 15.5**

  - [x]* 8.3 Write integration tests for admission wiring and end-to-end streaming
    - In `services/gateway/tests/test_completions_endpoint.py`: assert the route declares `Depends(require_admission)` on the existing app with no extra listener, a loopback request is admitted and a non-loopback tokenless request is rejected (R15.1, R15.4); drive it with a fake token generator and assert the client receives ordered `token` events then one `done` on both the FIM and fallback paths (R12, R13.3).
    - _Requirements: 15.1, 15.4, 12.1, 12.3, 13.3_

- [x] 9. Checkpoint — Gateway completions endpoint complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. §3.3 Frontend inline completions provider and client, wired into Monaco
  - [x] 10.1 Implement the streaming completions client
    - Create `apps/frontend/src/lib/completions-client.ts` with `streamCompletion(body, onToken, signal)`: an abortable `fetch` `POST` to `${v1}/completions` (resolving the loopback port like `agent-client.ts`) that parses the SSE `ReadableStream`, distinguishing `event: token` (`{"text": …}` → `onToken`) from the distinct `event: done` terminal, and swallowing `AbortError`/network errors quietly.
    - _Requirements: 11.1, 12.1, 12.2, 12.3, 16.3_

  - [x]* 10.2 Write unit test for the completions client
    - In `apps/frontend/src/lib/__tests__/completions-client.test.ts`: feed a fake SSE body and assert tokens arrive in order, `done` resolves the call, and an aborted request rejects/settles quietly with no further `onToken`.
    - _Requirements: 12.1, 12.2, 12.3, 16.3_

  - [x] 10.3 Implement the inline completions provider
    - Create `apps/frontend/src/features/editor/inline-completions.ts` with `InlineCompletionsDeps` and `createInlineCompletionsProvider(monaco, deps)`. Expose pure helpers for testability: the debounce trigger (400 ms; a keystroke restarts it; both-empty automatic trigger makes no request), the cursor-window builder (prefix ≤500 / suffix ≤200 + language + path), and the ghost-text accumulator. Implement `AbortController` + monotonic `requestSeq` cancellation/stale-discard, first-token ghost text + "Tab to accept" hint, per-token growth, and empty/failed → no ghost text.
    - _Requirements: 8.2, 8.3, 8.4, 9.1, 9.2, 9.3, 10.1, 10.2, 16.3_

  - [x]* 10.4 Write property test for debounce
    - In `apps/frontend/src/features/editor/__tests__/inline-completions.prop.test.ts` using Vitest fake timers (fast-check, `numRuns >= 100`).
    - **Property 7: Debounce collapses a keystroke burst to one trailing request**
    - **Validates: Requirements 8.2, 8.3, 8.4**

  - [x]* 10.5 Write property test for the request window
    - Same file `inline-completions.prop.test.ts`; targets the cursor-window builder (fast-check, `numRuns >= 100`).
    - **Property 8: Request payload is bounded to the cursor window**
    - **Validates: Requirements 9.1**

  - [x]* 10.6 Write property test for cancellation/stale discard
    - Same file `inline-completions.prop.test.ts`; drive with a fake `streamCompletion` (fast-check, `numRuns >= 100`).
    - **Property 9: Cancelled or superseded responses never render**
    - **Validates: Requirements 9.2, 9.3**

  - [x]* 10.7 Write property test for ghost-text accumulation
    - Same file `inline-completions.prop.test.ts` (fast-check, `numRuns >= 100`).
    - **Property 10: Ghost text equals the ordered concatenation of received tokens; empty renders nothing**
    - **Validates: Requirements 10.2, 16.3**

  - [x] 10.8 Register the provider in MonacoView
    - Refine `apps/frontend/src/features/editor/MonacoView.tsx`: in `handleMount` after `captureMonaco(monaco)`, build `createInlineCompletionsProvider(monaco, { streamCompletion })` and call `monaco.languages.registerInlineCompletionsProvider({ pattern: "**" }, provider)`, disposing on unmount.
    - _Requirements: 8.1_

  - [x]* 10.9 Write integration tests for registration and ghost-text accept/dismiss
    - In `apps/frontend/src/features/editor/__tests__/inline-completions-monaco.test.tsx`: mounting MonacoView registers the provider once against the captured Monaco instance (R8.1); with ghost text shown, Tab inserts the buffered text (caret at end, hint dismissed, no tab char) and typing another character dismisses without inserting (R10.1, R10.3, R10.4).
    - _Requirements: 8.1, 10.1, 10.3, 10.4_

- [x] 11. Final checkpoint — full feature integration
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; every non-`*` task is core implementation or wiring and must be implemented.
- Each task references specific requirement sub-clauses for traceability; property tasks additionally cite the design property they implement.
- Property-based tests use **fast-check** (frontend, Vitest, `numRuns >= 100`; Vitest fake timers for Property 7) and **Hypothesis** (gateway, ≥100 examples, with explicit boundary examples at the 30 s cache TTL and the 500/200 truncation limits). Each correctness property is implemented by a **single** property-based test tagged `Feature: editor-diagnostics-completions, Property N: <property text>`.
- SSE/resilience gateway properties drive the route with a **spy/fake `model_runtime`** so no real model is called.
- Regression bar: the existing frontend (Vitest) and gateway (pytest) suites stay green; the `generate_text_stream` signature change is backward-compatible.
- Checkpoints validate incrementally; the plan produces design/planning artifacts and code only — no deployment, user testing, or manual end-to-end runs.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.5", "1.7", "3.1", "6.1", "6.3", "10.1", "10.3"] },
    { "id": 1, "tasks": ["2.1", "2.3", "3.3", "3.4", "3.6", "7.1", "1.2", "1.6", "1.8", "3.2", "6.2", "6.4", "6.5", "6.6", "10.2", "10.4"] },
    { "id": 2, "tasks": ["4.1", "8.1", "10.8", "1.3", "3.5", "3.7", "7.2", "7.3", "10.5"] },
    { "id": 3, "tasks": ["1.4", "2.4", "4.2", "7.4", "8.2", "8.3", "10.6", "10.9"] },
    { "id": 4, "tasks": ["2.2", "10.7"] }
  ]
}
```
