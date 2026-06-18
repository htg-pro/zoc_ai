# Implementation Plan: ZOC Agent Ecosystem Merge

## Overview

This plan executes the **agent-only merge**: graft the new ecosystem stream layer + Gateway "brain" into the preserved `apps/frontend` shell, re-point the Tauri sidecar to the Gateway, then retire the legacy `zoc_studio_agent` backend and all superseded duplicate modules behind per-language build gates.

The legacy **editor-support** features (integrated terminal/pty, code indexer/search, model-provider settings, sessions) are **OUT OF SCOPE** for this spec and are deferred to a follow-up. No task below implements those features. However, the dead-code / build-gate tasks MUST detect and resolve any surviving `apps/frontend` reference to a removed legacy endpoint — repoint it to a retained module or cleanly disable the dependent feature so the build stays green (Requirement 8.3).

The task order follows the design's migration discipline so the app never enters a broken state:
**preservation-branch-first → port new stream modules into `apps/frontend` → add Gateway launch entrypoint + R12 bind/auth guard → rewire Composer submit + AgentPanel row 3 → re-point Tauri sidecar/bundle → replace-before-delete the superseded legacy modules behind build gates → naming normalization → final green-build checkpoint.**

Languages (from the design, not pseudocode): TypeScript (frontend, fast-check), Python (Gateway, Hypothesis), Rust (Tauri shell). The seven Correctness Properties are realized as property-based tests — Properties 1–5 in TypeScript/fast-check under `apps/frontend`, Properties 6–7 in Python/Hypothesis under `services/gateway` — each a single property test, ≥100 iterations, tagged `Feature: zoc-agent-ecosystem-merge, Property {n}: {text}`. The carried-over Rebuild backend properties are NOT duplicated here.

## Tasks

- [x] 1. Migration setup and preservation guard
  - [x] 1.1 Add preservation-branch + replace-before-delete guard to the migration tooling
    - In `python/zocai_migration`, add a guard that aborts (non-zero exit) unless the committed `legacy-preservation` branch exists before any deletion step runs, and that enforces replace-before-delete ordering (a delete step refuses to run until its replacement module is present and imported).
    - Expose a single CLI entrypoint the later deletion tasks call so the discipline is centralized.
    - _Requirements: 7.5, 8.5, 11.3 (Rebuild-R13.2/R13.3/R13.4/R13.8)_

- [x] 2. Port the new stream layer into `apps/frontend`
  - [x] 2.1 Port the single SSE client `useAgentStream.ts`
    - Source `apps/workbench/src/useAgentStream.ts` (via `git show zocai-ecosystem-rebuild:apps/workbench/src/useAgentStream.ts`) into `apps/frontend/src/features/agent/useAgentStream.ts` as the single frontend SSE client; rewrite `@llama-studio/shared-types` imports to `@zoc-studio/shared-types`.
    - Subscribe to `GET /v1/agent/events` on mount; keep the append-only, seq-ordered `mergeEventBySeq`/`mergeEvents` fold (drop duplicate `seq`, never mutate prior entries); add `parseFrame` returning `null` for non-conforming frames while keeping the stream open; rebuild from `GET /v1/agent/diary` trailing entries on a dropped stream before resuming live.
    - Keep the transport injectable (`createStream`, `recoverFromDiary`) so the existing Tauri `agentPort()`/`agentStatus()` readiness wait plugs in.
    - _Requirements: 3.1, 3.4, 3.5, 6.3, 11.1, 11.3_

  - [x]* 2.2 Write property test for feed ordering
    - **Property 1: Feed is append-only and seq-ordered** — for any sequence of contract events (including duplicates and out-of-order arrivals), folding through `mergeEventBySeq`/`mergeEvents` yields entries strictly ascending by `seq`, each `seq` at most once, and never mutates/replaces a previously present entry.
    - TypeScript + fast-check in `apps/frontend`, ≥100 iterations, tagged `Feature: zoc-agent-ecosystem-merge, Property 1: Feed is append-only and seq-ordered`.
    - **Validates: Requirements 3.4**

  - [x] 2.3 Port the typed row components `rows.tsx` and restyle to zoc-studio tokens
    - Source `apps/workbench/src/rows.tsx` into `apps/frontend/src/features/agent/rows.tsx`; rewrite `@llama-studio/shared-types` imports to `@zoc-studio/shared-types`.
    - Provide exactly one row component per Event_Row kind (`IntentRow`, `ThinkingRow`, `ReadFilesRow`, `EditFileRow`, `CommandRow`, `SummaryBlock`, `ApprovalRow`, `DoneRow`) and the total `ROW_COMPONENTS` registry (8 entries) plus `isRecognizedEvent`.
    - Restyle the ported `feed-row` markup with existing zoc-studio tokens (`--zoc-ember`, `--zoc-info`, `--zoc-row-bg`, `--zoc-row-border`) so the feed visually matches the panel, one-component-per-type.
    - _Requirements: 3.2, 3.3, 3.7, 1.5, 11.1, 11.3_

  - [x]* 2.4 Write property test for row-component dispatch
    - **Property 2: Each event type maps to exactly one row component** — for any of the eight Event_Contract types, `ROW_COMPONENTS` selects exactly one distinct component, the registry is total over `EventType` with exactly eight entries, and rendering a recognized event uses the component mapped to its discriminator.
    - TypeScript + fast-check in `apps/frontend`, ≥100 iterations, tagged `Feature: zoc-agent-ecosystem-merge, Property 2: Each event type maps to exactly one row component`.
    - **Validates: Requirements 3.2, 3.3**

  - [x]* 2.5 Write property test for unrecognized-event discard
    - **Property 3: Unrecognized event types leave the feed unaltered** — for any payload whose `type` is not one of the eight recognized kinds, `isRecognizedEvent` is false and the rendered feed is identical to the feed before the payload arrived.
    - TypeScript + fast-check in `apps/frontend`, ≥100 iterations, tagged `Feature: zoc-agent-ecosystem-merge, Property 3: Unrecognized event types leave the feed unaltered`.
    - **Validates: Requirements 3.5**

  - [x] 2.6 Port the run-feed body `AgentRunFeed.tsx`
    - Adapt `apps/workbench/src/AgentFeed.tsx` into `apps/frontend/src/features/agent/AgentRunFeed.tsx`; it consumes `useAgentStream`, selects one component from `ROW_COMPONENTS` per event, appends in emission order without altering prior rows, discards unrecognized types, and keeps the 100 ms render budget with the skip-or-late-with-warning fallback.
    - Render rows inside the existing run region so the Panel_Shell is untouched.
    - _Requirements: 3.2, 3.3, 3.4, 3.5, 3.7_

  - [x]* 2.7 Write snapshot test that rows mount inside the run region
    - Assert the new rows mount inside the run region (grid row 3) and the surrounding Panel_Shell DOM is unchanged.
    - _Requirements: 3.7_

- [x] 3. Frontend agent transport and decision logic
  - [x] 3.1 Create the single agent transport `gateway-client.ts`
    - Create `apps/frontend/src/features/agent/gateway-client.ts` exporting `postAgentRun({input, mode}) → {runId}` (`POST /v1/agent/run`) and `postAgentDecision({runId, decision}) → void` (`POST /v1/agent/decision`); target canonical `/v1/agent/*` paths resolved against the loopback port.
    - This is the only agent transport; no second event-stream implementation.
    - _Requirements: 2.1, 2.6, 5.2, 5.3, 6.3_

  - [x] 3.2 Implement the Composer run-decision function `prepareAgentRun`
    - Add a pure `prepareAgentRun(input, mode)` helper (own module) that trims input, rejects empty/whitespace-only input (no request produced), and otherwise produces exactly one run request carrying the trimmed input and `mode` ∈ {ask, agent}. Reuse the existing `validateMessage`/`isSendableInput` guard as the single validation point.
    - _Requirements: 4.1, 4.2, 4.5_

  - [x]* 3.3 Write property test for Composer mode/validation mapping
    - **Property 4: Composer rejects empty input and otherwise sends the selected mode** — for any input string and any toggle in {ask, agent}, empty trimmed input produces/sends no run request; non-empty trimmed input produces exactly one run request carrying the trimmed input and a `mode` equal to the toggle.
    - TypeScript + fast-check in `apps/frontend`, ≥100 iterations, tagged `Feature: zoc-agent-ecosystem-merge, Property 4: Composer rejects empty input and otherwise sends the selected mode`.
    - **Validates: Requirements 4.1, 4.2, 4.5**

  - [x] 3.4 Wire the ApprovalRow decision to `/decision`
    - In `rows.tsx`, wire `ApprovalRow` so selecting approve or reject posts exactly one `postAgentDecision({runId, decision})`, disables BOTH actions on that row, and ignores subsequent selections; re-enable only on a transport error. Handle the budget-continuation approval through the same row/path (continue/stop verdict).
    - Remove reliance on the legacy `resolveApproval`/`retryApproval`; this is the single decision client.
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [x]* 3.5 Write property test for ApprovalRow decision
    - **Property 5: ApprovalRow decision disables both actions and posts the matching verdict** — for any approval Event_Row and any choice in {approve, reject}, selecting it posts exactly one decision to `/v1/agent/decision` carrying that verdict and the row's `runId`, disables both actions, and ignores subsequent selections.
    - TypeScript + fast-check in `apps/frontend`, ≥100 iterations, tagged `Feature: zoc-agent-ecosystem-merge, Property 5: ApprovalRow decision disables both actions and posts the matching verdict`.
    - **Validates: Requirements 5.2, 5.3**

- [x] 4. Wire the new stream layer into the preserved shell
  - [x] 4.1 Rewire the Composer submit path to the Gateway
    - Reduce the store's `sendUserMessage` to: validate via `prepareAgentRun` → `postAgentRun` → let `useAgentStream` drive the feed. Keep the Composer markup, classes, Ask/Agent pill, autonomy pill, and send/stop buttons unchanged; only the submit handler changes. Map the current toggle to the `mode` field; render text chunks while Ask is active and structured rows while Agent is active.
    - Do not route to any legacy transport.
    - _Requirements: 1.2, 1.3, 1.4, 2.1, 4.1, 4.2, 4.3, 4.4, 4.5, 6.5_

  - [x] 4.2 Replace AgentPanel row 3 with `AgentRunFeed`
    - In `AgentPanel.tsx`, replace `<AgentTimeline />` inside `AgentPanelBoundary` (grid row 3) with `<AgentRunFeed />`. Leave the header, model selector, control bar, `ContextBar`, error boundary, CSS classes, color tokens, and spacing verbatim.
    - _Requirements: 1.1, 1.5, 1.6, 3.1, 3.6, 3.7_

  - [x]* 4.3 Write example tests for mount/subscribe and mode rendering
    - Run_Feed subscribes exactly once on mount (R3.1); `done` marks the run complete while the stream keeps monitoring for late events (R3.6); Ask renders token-frame markdown (R4.3) and Agent renders structured rows (R4.4); submit targets `/v1/agent/run` with no legacy transport (R2.1, R6.5); ApprovalRow renders approve+reject for an approval event and a budget-continuation approval resolves via `/decision` (R5.1, R5.4).
    - _Requirements: 3.1, 3.6, 4.3, 4.4, 2.1, 6.5, 5.1, 5.4_

  - [x]* 4.4 Write UI-preservation snapshot tests
    - DOM-structure and class-list snapshots of `AgentPanel.tsx` header/control-bar and `Composer.tsx` asserting preserved layout, CSS classes, color tokens, spacing, and the full set of controls; assert the input echo and Ask/Agent toggle indicator behavior.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

- [x] 5. Checkpoint - frontend integration green
  - Ensure all tests pass and the TypeScript build is green (zero exit). Ask the user if questions arise.

- [x] 6. Add the Gateway launch entrypoint and R12 bind/auth guard
  - [x] 6.1 Implement `GatewaySettings` and `enforce_bind_policy`
    - In `services/gateway/src/zocai_gateway`, add `GatewaySettings` (host default `127.0.0.1`, port, optional `auth_token` from env) with `is_loopback()` and `enforce_bind_policy()` that raises a configuration error naming the missing credential when a non-loopback host is configured without an auth token.
    - _Requirements: 12.1, 12.2_

  - [x]* 6.2 Write property test for Gateway startup bind policy
    - **Property 6: Gateway startup bind policy** — for any (host, credential) pair, the bind-policy check refuses to start (raising a config error identifying the missing credential) iff the host is non-loopback and no credential is configured; otherwise startup proceeds.
    - Python + Hypothesis in `services/gateway`, ≥100 iterations, tagged `Feature: zoc-agent-ecosystem-merge, Property 6: Gateway startup bind policy`.
    - **Validates: Requirements 12.2**

  - [x] 6.3 Implement the request-admission auth dependency
    - Add a FastAPI dependency (own `auth.py` module) guarding the control/telemetry routes: on a non-loopback binding, reject requests lacking a valid credential with `401` before the handler runs; on loopback, accept with or without a credential.
    - _Requirements: 12.3, 12.4_

  - [x]* 6.4 Write property test for Gateway request admission
    - **Property 7: Gateway request admission policy** — for any binding and any presented credential (absent/invalid/valid), a request is admitted iff the binding is loopback or the credential is valid; a non-admitted request is rejected with an authorization error and the operation does not execute.
    - Python + Hypothesis in `services/gateway`, ≥100 iterations, tagged `Feature: zoc-agent-ecosystem-merge, Property 7: Gateway request admission policy`.
    - **Validates: Requirements 12.3, 12.4**

  - [x] 6.5 Add the launch entrypoint with readiness handshake
    - Create `services/gateway/src/zocai_gateway/scripts/launch.py`: load `GatewaySettings.from_env()`, call `enforce_bind_policy()`, bind loopback-or-configured (OS-assigned port if 0), print `ZOC_STUDIO_AGENT_PORT=<port>` to stdout (flush), then `uvicorn.run(create_app(workspace_root=...))`. Preserve the existing `/health` contract so the Tauri supervisor's poll loop works unchanged.
    - _Requirements: 10.2, 10.3, 12.1, 12.2_

  - [x] 6.6 Document the loopback no-auth constraint
    - In `services/gateway/README.md`, document that loopback-bound endpoints accept requests without authentication as a known security constraint.
    - _Requirements: 12.5_

  - [x]* 6.7 Write smoke test for default loopback bind
    - Assert default Gateway settings bind to the loopback interface and that the README documents the loopback no-auth constraint.
    - _Requirements: 12.1, 12.5_

- [x] 7. Re-point the Tauri sidecar and bundle to the Gateway
  - [x] 7.1 Re-point `bundle_sidecar.py` to the Gateway
    - In `scripts/bundle_sidecar.py`, change `SERVICE` to `services/gateway`, `ENTRY` to `.../zocai_gateway/scripts/launch.py`, `--collect-submodules` to `zocai_gateway` (+ `zocai_evolution`, `shared_schema`), keeping the output binary name `zoc-studio-agent-<triple>`.
    - _Requirements: 10.2, 10.6_

  - [x] 7.2 Re-point the Tauri `externalBin` to the Gateway
    - In `tauri.conf.json`, keep `binaries/zoc-studio-agent` (now the Gateway). Leave `sidecar.rs` unchanged since the handshake prefix and `/health` contract are preserved.
    - _Requirements: 10.1, 10.2, 10.6_

  - [x] 7.3 Update `prepare_tauri_build.sh` to bundle the Gateway
    - In `scripts/prepare_tauri_build.sh`, keep step [1/3] frontend build; make step [3/3] bundle the Gateway sidecar; keep the clean-by-default PyInstaller behavior so a stale sidecar is never shipped.
    - _Requirements: 10.6_

  - [x]* 7.4 Write integration tests for the sidecar lifecycle
    - Handshake success → ready; post-readiness connection failure is fatal and surfaced (R10.4); readiness timeout is surfaced (R10.5); the supervisor spawns exactly one sidecar (R6.6); the four Gateway routes exist and stream the expected content-types, and SSE streams in order (R2.6).
    - _Requirements: 10.2, 10.3, 10.4, 10.5, 6.6, 2.6_

- [x] 8. Checkpoint - backend and packaging green
  - Ensure all tests pass and the Python and Rust builds are green (zero exit). Ask the user if questions arise.

- [x] 9. Remove superseded legacy modules behind build gates
  - [x] 9.1 Consolidate the Event_Contract in `packages/shared-types`
    - Edit `packages/shared-types/typescript/src/index.ts` to remove the legacy `AgentEvent` agent-run union (and types used only by retired agent modules) and re-export `agent-events.ts`; apply the same treatment to `packages/shared-types/python/shared_schema/models.py` re-exporting `agent_events.py`. Retain types still used by surviving UI until separately addressed. `agent-events.ts` (+ `agent_events.py`) is the single source of truth.
    - _Requirements: 6.2, 6.6, 7.1, 7.6, 8.2_

  - [x] 9.2 Delete superseded frontend agent modules and resolve dead endpoint references
    - Delete `AgentTimeline.tsx`, `lib/sse.ts`, `lib/seq-cursor.ts`, `lib/reconnect.ts`, and strip the agent run/event/approval transport from `lib/agent-client.ts` (leaving only the new transport + `useAgentStream`).
    - Scan all surviving `apps/frontend` modules for references to removed legacy agent endpoints; for each, repoint to a retained module or cleanly disable the dependent feature so no frontend module references a removed endpoint and the build stays green. (Editor-support features remain out of scope — disable cleanly, do not implement.)
    - _Requirements: 6.3, 6.4, 8.1, 8.2, 8.3_

  - [x] 9.3 Delete the legacy agent backend `services/agent`
    - Remove the `zoc_studio_agent` run/event/approval/reconcile/state/modes/v1 agent modules and its `scripts/launch.py`, so only the Gateway emit gate + FSM implement the SSE stream and run loop.
    - _Requirements: 6.1, 6.4, 6.5, 7.3, 7.4, 8.1, 8.2, 9.2_

  - [x] 9.4 Delete the `apps/workbench` reference scaffold
    - Remove `apps/workbench` after its three modules are ported; `apps/frontend` is the single product app.
    - _Requirements: 7.1, 7.2, 8.1_

  - [x] 9.5 Conditionally retire `crates/hotpath`
    - After the legacy agent is removed, run a reference scan + `cargo build`; if no surviving live path references `crates/hotpath`, delete the crate and remove its `binaries/zoc-studio-hotpath` `externalBin` entry and any hotpath staging in `prepare_tauri_build.sh`; otherwise retain it for editor-support only and keep its entry.
    - _Requirements: 8.1, 8.4, 8.5_

  - [x] 9.6 Delete superseded `python/llama_studio_neural` if present
    - If `python/llama_studio_neural` exists on `main`, delete it as superseded by `zocai_evolution`.
    - _Requirements: 8.1, 11.1_

  - [x] 9.7 Run the single-source-of-truth, dead-code, and background-process reference scans
    - Reference scans assert: exactly one SSE Event_Contract (`agent-events.ts`), one SSE client (`useAgentStream.ts`), one agent run loop (Gateway FSM/Orchestrator); no residual `events/bus.py`, `runs.py`, `lib/sse.ts`, `AgentTimeline.tsx`; no live import of any removed legacy module; no frontend reference to a removed legacy endpoint; no superseded legacy background watcher/reconciler/run task wired at startup. Per-language build gates (`pnpm -w build` / `tsc -b`; `import zocai_gateway.app` + Gateway test collection; `cargo build`) each return zero exit.
    - _Requirements: 6.2, 6.3, 6.4, 7.1, 7.3, 7.4, 7.5, 8.1, 8.2, 8.3, 8.5, 9.2, 9.3_

  - [x]* 9.8 Write integration test for the background-process inventory
    - Assert exactly one Diary_Worker and one idle-evolution loop start, both stop cleanly on shutdown with no orphaned process, and the supervisor runs exactly one sidecar backend.
    - _Requirements: 9.1, 9.4, 9.5, 6.6_

- [x] 10. Normalize product naming
  - [x] 10.1 Normalize product identifiers to the zoc-studio forms
    - Rewrite `@llama-studio/...` imports to `@zoc-studio/...` (package name `@zoc-studio/shared-types`); rename any remaining `llama_studio_*` Python product identifiers to `zoc_studio_*`/`zocai_*`. Retain `zocai_gateway`/`zocai_evolution`/`zocai_migration` as-is. Leave every `llama.cpp`/`llamacpp` External_Llama_Reference unchanged (provider, env var, runtime json, enum value, Tauri longDescription).
    - _Requirements: 11.1, 11.2, 11.3_

  - [x]* 10.2 Run the naming reference-scan gate
    - Assert no `@llama-studio` product import remains and that every `llama.cpp`/`llamacpp` reference is preserved against an allowlist; confirm per-language builds resolve with zero exit after renames.
    - _Requirements: 11.1, 11.2, 11.3_

- [x] 11. Checkpoint - final per-language build gates green
  - Ensure all tests pass and TypeScript, Python, and Rust builds each complete with a zero exit code. Ask the user if questions arise.

- [x] 12. Final setup/config smoke verification
  - [x]* 12.1 Write setup/config smoke tests
    - Assert the `.zocai/` stores are created on first run and that the installer/build bundles the Gateway as the `zoc-studio-agent` sidecar.
    - _Requirements: 10.1, 10.6_

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation tasks are never optional.
- Each task references the specific requirement sub-clauses it satisfies for traceability.
- Order honors replace-before-delete: the new stream layer, Gateway entrypoint, and sidecar re-point land and are wired (tasks 1–8) before any superseded module is removed (task 9); naming normalization (task 10) runs last before the final build gate.
- Properties 1–5 are TypeScript/fast-check in `apps/frontend`; Properties 6–7 are Python/Hypothesis in `services/gateway`; each property is one property-based test at ≥100 iterations. The carried-over Rebuild backend properties (Mode_Router, FSM order, Allocator, channel discipline, diary FIFO) are validated by the Rebuild suite and are not duplicated here.
- Non-PBT verification is covered by snapshot tests (UI preservation), example tests (mount/subscribe, ask vs agent, approval flow), integration tests (gateway endpoints, sidecar handshake/readiness, single backend, background-process inventory), smoke tests (loopback default, installer bundle, `.zocai/` creation), and reference-scan + build-gate tasks that enforce single-source-of-truth, dead-code removal, and naming.
- Editor-support features (terminal/pty, indexer/search, provider settings, sessions) are out of scope; task 9.2 cleanly disables or repoints surviving references rather than implementing them.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "2.3", "3.1", "3.2", "6.1", "6.6", "7.1", "7.2", "7.3"] },
    { "id": 1, "tasks": ["2.2", "2.4", "2.5", "2.6", "3.3", "3.4", "4.1", "6.2", "6.3", "6.5"] },
    { "id": 2, "tasks": ["2.7", "3.5", "4.2", "6.4", "6.7", "7.4"] },
    { "id": 3, "tasks": ["4.3", "4.4"] },
    { "id": 4, "tasks": ["9.1", "9.2", "9.3", "9.4", "9.5", "9.6"] },
    { "id": 5, "tasks": ["10.1"] },
    { "id": 6, "tasks": ["9.7", "9.8", "10.2", "12.1"] }
  ]
}
```
