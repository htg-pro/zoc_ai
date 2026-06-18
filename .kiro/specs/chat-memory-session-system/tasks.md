# Implementation Plan: Chat Memory & Session System

## Overview

This plan threads a backend-issued `run_id` through the agent event envelope,
replaces the three drifting frontend sequence cursors with a single authority,
adds two pure frontend modules (`seq-cursor.ts`, `session-lifecycle.ts`), fixes
local-timezone day bucketing in `session-query.ts`, and clarifies/enforces the
session-scoped recall contract on the backend.

The work is ordered so the **pure, dependency-free modules** are built and
property-tested first (shared-type field, `seq-cursor.ts`, `session-lifecycle.ts`,
`localDayIndex`, the extended `decideIngest`), then wired into the stateful
modules (`run-machine.ts`, `agent-client.ts`, `store.ts`), and finally the
backend `run_id` threading and recall contract are completed end to end.

Languages are fixed by the existing monorepo: **TypeScript** for the frontend
(`apps/frontend`, `packages/shared-types/typescript`) tested with
**vitest + fast-check**, and **Python** for the backend
(`services/agent`, `packages/shared-types/python`) tested with
**pytest + hypothesis**.

## Tasks

- [x] 1. Extend the shared `AgentEvent` envelope with an optional `run_id`
  - [x] 1.1 Add optional `run_id` to the TypeScript and Python event base types
    - In `packages/shared-types/typescript/src/index.ts`, add `run_id?: string | null;` to the `AgentEventBase` interface so every event subtype inherits it (backward compatible — absent/null means "belongs to the active run").
    - In `packages/shared-types/python/shared_schema/models.py`, add `run_id: str | None = None` to the `AgentEventBase` pydantic model so all event subclasses serialize an optional `run_id`.
    - Keep both definitions in sync; do not change `seq`/`session_id` semantics.
    - _Requirements: 1.2, 1.7_

  - [x] 1.2 Write unit tests for the extended event envelope
    - Assert a TS event object without `run_id` still type-checks and round-trips through JSON.
    - Assert the Python `AgentEventBase` (and one subclass, e.g. `MessageEvent`) defaults `run_id` to `None` and serializes/deserializes it via `model_dump`/parse.
    - _Requirements: 1.2, 1.7_

- [x] 2. Build the single sequence-cursor authority (`seq-cursor.ts`, NEW, pure)
  - [x] 2.1 Implement `seq-cursor.ts` with `initialCursor`, `onRunStart`, `advance`, `subscribeCursor`
    - Create `apps/frontend/src/lib/seq-cursor.ts` exporting `SeqCursor { highestSeq, activeRunId }`.
    - `initialCursor()` returns `{ highestSeq: 0, activeRunId: null }`.
    - `onRunStart(cursor, runId)` returns `{ highestSeq: cursor.highestSeq, activeRunId: runId }` — the seq floor is **preserved, never reset to 0**.
    - `advance(cursor, seq)` returns `{ ...cursor, highestSeq: Math.max(cursor.highestSeq, seq) }` (monotonic non-decreasing).
    - `subscribeCursor(cursor)` returns `Math.max(0, cursor.highestSeq)` to mirror `reconnect.ts`.
    - _Requirements: 1.4, 1.5_

  - [x] 2.2 Write property test: seq floor preserved across run starts
    - **Property 5: Seq floor preserved across run starts**
    - **Validates: Requirements 1.5**
    - Place in `apps/frontend/src/lib/__tests__/seq-cursor.prop.test.ts`; ∀ cursor, runId: `onRunStart(c, runId).highestSeq === c.highestSeq` and `activeRunId === runId`.

  - [x] 2.3 Write property test: advance is monotonic non-decreasing
    - **Property 4 (seq monotonicity portion): `advance` never lowers `highestSeq`**
    - **Validates: Requirements 1.4**
    - ∀ cursor, seq: `advance(c, seq).highestSeq === Math.max(c.highestSeq, seq)`; folding any permutation of a seq multiset yields the same final `highestSeq`.

- [x] 3. Build the session lifecycle resolver (`session-lifecycle.ts`, NEW, pure)
  - [x] 3.1 Implement `resolveSessionIntent` and its types
    - Create `apps/frontend/src/lib/session-lifecycle.ts` exporting `LifecycleTrigger`, `SessionIntent`, `LifecycleInput`, and `resolveSessionIntent`.
    - `new-chat` → `{ kind: "fresh" }` regardless of session list or `lastActiveId`.
    - `app-open` → `{ kind: "resume", sessionId: lastActiveId }` only when `lastActiveId` names an existing session, else `{ kind: "fresh" }`.
    - `select` → `{ kind: "select", sessionId }` when `selectedId` names an existing session, else `{ kind: "fresh" }`.
    - `delete-active` → `{ kind: "fresh" }` always.
    - Pure and deterministic; no I/O, no clock, no globals.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 3.2 Write property test: a fresh session never auto-resumes
    - **Property 6: A fresh session never auto-resumes a prior session**
    - **Validates: Requirements 2.1**
    - In `apps/frontend/src/lib/__tests__/session-lifecycle.prop.test.ts`; ∀ session lists, `lastActiveId`: `resolveSessionIntent({trigger:"new-chat", …}).kind === "fresh"`.

  - [x] 3.3 Write property test: resume only on explicit existing pointer
    - **Property 7: Resume only on explicit existing pointer**
    - **Validates: Requirements 2.2**
    - ∀ inputs: a `resume` result implies trigger was `app-open` AND `lastActiveId` names a session in the list; otherwise `app-open` yields `fresh`.

  - [x] 3.4 Write unit tests for `select` and `delete-active` fallbacks
    - `select` with a present id → `select`; with absent/empty → `fresh`.
    - `delete-active` → `fresh` regardless of remaining sessions / `lastActiveId`.
    - _Requirements: 2.3, 2.4, 2.5_

- [x] 4. Fix local-timezone day bucketing in `session-query.ts`
  - [x] 4.1 Implement `localDayIndex` and rewire `groupSessions`
    - In `apps/frontend/src/lib/session-query.ts`, add `localDayIndex(iso: string, tzOffsetMinutes: number): number` that returns `Number.NEGATIVE_INFINITY` on `NaN` parse, else `Math.floor((t - tzOffsetMinutes * 60_000) / MS_PER_DAY)`.
    - Thread a `tzOffsetMinutes` argument into `groupSessions` and compute `nowDay` from the injected `now` using the **same** offset, so Today/Yesterday/Earlier are consistent with the display clock; never read the host clock or env timezone inside these functions.
    - Preserve the half-open `[00:00, 24:00)` local-day boundary and keep all four buckets always present.
    - Update existing `groupSessions` call sites to pass the display offset.
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [x] 4.2 Write property test: day bucketing consistent with display timezone
    - **Property 8: Day-bucketing consistent with display timezone**
    - **Validates: Requirements 3.1**
    - In `apps/frontend/src/lib/__tests__/session-query.prop.test.ts` (extend existing file); ∀ iso, offset: `localDayIndex` is deterministic, two timestamps in the same local day share an index, consecutive local days differ by exactly 1, and every non-pinned session lands in exactly one labeled bucket.

  - [x] 4.3 Write unit tests for `localDayIndex` boundary and NaN cases
    - Local-midnight is the first instant of its day; one ms before is the prior day.
    - Unparseable `updated_at` → `NEGATIVE_INFINITY` → "Earlier", without throwing or affecting other sessions.
    - _Requirements: 3.3, 3.4_

- [x] 5. Extend event ingestion to discard cross-run events (`event-ingest.ts`)
  - [x] 5.1 Add `activeRunId` to `IngestState` and the cross-run discard rule
    - In `apps/frontend/src/lib/event-ingest.ts`, change `decideIngest` to accept the full `AgentEvent` and an `IngestState` that now includes `activeRunId: string | null`.
    - First rule: if `event.run_id != null && st.activeRunId != null && event.run_id !== st.activeRunId` → `"discard"` (leaving `highestSeq`/`activeRunId`/`boundMessageId` untouched at the caller).
    - Preserve existing rules in order: stale (`seq <= highestSeq`) discard, stopped discard, paused buffer, else apply.
    - Update internal callers/types accordingly (keep `eventSeq`, `eventEntryId`, `upsertById`, `drainBuffer` behavior intact).
    - _Requirements: 1.2, 1.7_

  - [x] 5.2 Write property test: cross-run events are discarded
    - **Property 2: Cross-run events are discarded**
    - **Validates: Requirements 1.2**
    - In `apps/frontend/src/lib/__tests__/event-ingest.prop.test.ts` (extend existing); ∀ event `e`, state: `e.run_id != null && e.run_id !== activeRunId ⟹ decideIngest(e, st) === "discard"`.

  - [x] 5.3 Write property test: idempotent, non-decreasing ingestion
    - **Property 4: Seq monotonicity / idempotent ingestion**
    - **Validates: Requirements 1.4**
    - Feed streams with duplicates and reorderings through `decideIngest` + `advance`; assert each event id applied at most once, re-delivery is discarded, and `highestSeq` is non-decreasing.

  - [x] 5.4 Write property test: `upsertById` order and identity
    - **Property 9: upsertById order/identity**
    - **Validates: Requirements 1.6**
    - ∀ entries, entry: result is ordered ascending by `seq` (ties by id), contains `entry` exactly once, and replacing by id does not duplicate.

- [x] 6. Checkpoint - Ensure all pure-module tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Bind runs to messages in `run-machine.ts`
  - [x] 7.1 Add `boundMessageId` to `RunState` and carry it on `start`
    - In `apps/frontend/src/lib/run-machine.ts`, add `boundMessageId: string | null` to `RunState` (init `null`) and extend the `start` action with `boundMessageId: string`.
    - On `start`, set `runId` to the backend id and record `boundMessageId`; delegate the seq floor to the shared cursor (do not strand stale events as new — stop relying on the local `highestSeq` reset for cross-run correctness).
    - On terminal transitions, keep clearing `runId`; leave `boundMessageId` as-is for the completed run record.
    - If `start` is dispatched with no bound user message available, leave `boundMessageId` null and do not begin an active run (caller-enforced; reducer must not invent a binding).
    - _Requirements: 1.1, 1.3, 1.8_

  - [x] 7.2 Write property test: a started run answers the most-recent user message
    - **Property 1: A started run answers the most-recent user message**
    - **Validates: Requirements 1.1**
    - In `apps/frontend/src/lib/__tests__/run-machine.prop.test.ts` (extend existing); ∀ send sequences: after `start`, `boundMessageId` equals the id of the last appended user message (ties resolved to highest id).

  - [x] 7.3 Write property test: single active run
    - **Property 3: Single active run**
    - **Validates: Requirements 1.3**
    - ∀ action sequences: at most one run is `running`/`paused`, and `start` yields exactly that one.

  - [x] 7.4 Write unit test: no user message leaves binding unset
    - A `start` with no available user message keeps `boundMessageId` null and does not produce an active run.
    - _Requirements: 1.8_

- [x] 8. Wire the single seq cursor into `agent-client.ts`
  - [x] 8.1 Replace the `lastSeq` map usage with the shared `SeqCursor` authority
    - In `apps/frontend/src/lib/agent-client.ts`, source the `since_seq` for `openEventsSse` from `subscribeCursor(cursor)` instead of the standalone `lastSeq` map, so the resubscribe cursor matches what ingestion has applied.
    - Update `pumpSse` to advance the shared cursor via `advance` rather than mutating a private map; preserve the existing reconnect behavior (`nextReconnect`, `MAX_RECONNECTS`).
    - Keep the `__setLastSeq`/`__resetLastSeq` test hooks working (or replace with cursor equivalents) so existing tests can seed the cursor.
    - _Requirements: 1.4, 1.5_

  - [x] 8.2 Write unit tests for cursor-driven resubscribe
    - Assert `since_seq` on (re)subscribe equals `subscribeCursor(cursor)` after applying events, and that a run start preserves the floor (no replay of stale low-seq events).
    - _Requirements: 1.4, 1.5_

- [x] 9. Wire association + lifecycle + cursor into `store.ts`
  - [x] 9.1 Bind the run to the just-sent message in `sendUserMessage`
    - In `apps/frontend/src/lib/store.ts`, append the user message with a stable id first, abort the previous stream, POST `/agent/run`, then dispatch `start` with the backend `run_id` and `boundMessageId = userMsg.id`.
    - Feed incoming events through the extended `decideIngest` (with `activeRunId`) so events from a prior run are discarded; advance the shared cursor on apply.
    - _Requirements: 1.1, 1.2, 1.3, 1.7_

  - [x] 9.2 Replace `sessions[0]` auto-resume with `resolveSessionIntent`
    - Replace the unconditional `const first = sessions[0]` auto-select in the load path with a call to `resolveSessionIntent`, persisting `lastActiveId` in `localStorage` (alongside the existing `PINNED_SESSIONS_KEY` pattern) and acting on the returned `fresh`/`resume`/`select` intent.
    - Route the "new chat" and "delete active" UI actions through the resolver so they yield `fresh`.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 9.3 Pass the display timezone offset into `groupSessions`
    - At the store/selector boundary, compute the display offset (e.g. `-new Date().getTimezoneOffset()`) once and pass it (with the injected `now`) into `groupSessions`, keeping the grouping functions pure.
    - _Requirements: 3.1, 3.2, 3.3_

  - [x] 9.4 Write integration test: "type hi after hello" ignores the prior run
    - Drive `sendUserMessage` against a mock SSE that replays a prior run's `done`/`message` events tagged with the old `run_id`; assert only the new run's output renders and `boundMessageId` matches the "hi" message.
    - _Requirements: 1.1, 1.2, 1.7_

  - [x] 9.5 Write integration test: opening a new chat never auto-resumes
    - With several existing sessions and a set `lastActiveId`, assert `new-chat` produces a clean session and no prior session is selected.
    - _Requirements: 2.1_

- [x] 10. Checkpoint - Ensure frontend wiring tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Mint and stamp `run_id` on the backend
  - [x] 11.1 Mint a `run_id` for every run and return it from `POST /agent/run`
    - In `services/agent/src/zoc_studio_agent/v1/agent_run.py`, compute `run_id = (payload.run_id or uuid4().hex)` for **all** runs (not just isolated/review runs) and include `"run_id": run_id` in the JSON response.
    - Thread `run_id` into the run context so every event published for this run can carry it.
    - _Requirements: 1.2, 1.7_

  - [x] 11.2 Stamp `run_id` on every emitted event via the event bus
    - In `services/agent/src/zoc_studio_agent/events/bus.py`, ensure events published for a run carry the owning `run_id` (use the new `AgentEventBase.run_id` field); keep `next_seq(session_id)` as the sole monotonic seq source, orthogonal to `run_id`.
    - Ensure the SSE `/events` handler in `agent_run.py` serializes `run_id` in the `data:` payload (it already dumps the full model — verify no field is stripped).
    - _Requirements: 1.2, 1.7_

  - [x] 11.3 Write unit/integration tests for run_id minting and stamping
    - In `services/agent/tests/test_v1_routes.py` (or a new `test_run_id.py`), assert `POST /agent/run` returns a `run_id`, and that events streamed for that run carry the same `run_id` while `seq` stays monotonic.
    - _Requirements: 1.2, 1.7_

- [x] 12. Enforce and test the session-scoped recall contract (`agent/recall.py`)
  - [x] 12.1 Document and assert the recall scoping/exclusion/ordering contract
    - In `services/agent/src/zoc_studio_agent/agent/recall.py`, confirm `MessageVectorStore.query` filters strictly by `session_id`, applies `exclude_message_ids`, returns at most `top_k` hits sorted by descending score, and returns `[]` when `top_k <= 0`.
    - Confirm `RecallService.recall` returns `[]` for empty/whitespace queries and drops hits below `cfg.min_score` (default 0.15); add docstring notes pinning these guarantees. Make only the minimal code changes needed if any guarantee is not already met.
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [x] 12.2 Write property test: recall session isolation
    - **Property 10: Recall session isolation**
    - **Validates: Requirements 4.1**
    - In `services/agent/tests/test_recall_properties.py`; with hypothesis-generated vectors across ≥2 sessions, `recall(s, …)` returns only hits stored under `s`.

  - [x] 12.3 Write property test: recall excludes the working window
    - **Property 11: Recall excludes the working window**
    - **Validates: Requirements 4.2**
    - ∀ query, exclusion set X: no returned hit's `message_id ∈ X`, and all returned scores `>= min_score`.

  - [x] 12.4 Write unit tests for empty-query, top_k, and ordering edges
    - Empty/whitespace query → `[]`; `top_k <= 0` → `[]`; results ordered by descending score and capped at `top_k`.
    - _Requirements: 4.3, 4.4, 4.5_

- [x] 13. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation sub-tasks are never optional.
- Each task references specific requirement clauses (R1.x–R4.x) for traceability, and every property sub-task names the design property (P1–P11) and the requirement it validates.
- Pure, dependency-free modules (shared-type field, `seq-cursor.ts`, `session-lifecycle.ts`, `localDayIndex`, extended `decideIngest`) are built and property-tested before being wired into `run-machine.ts`, `agent-client.ts`, and `store.ts`, then the backend `run_id` threading and recall contract complete the slice.
- Property tests use fast-check + vitest on the frontend and hypothesis + pytest on the backend, per the design's Testing Strategy.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "3.1", "4.1", "12.1"] },
    { "id": 1, "tasks": ["1.2", "2.2", "2.3", "3.2", "3.3", "3.4", "4.2", "4.3", "5.1", "11.1", "12.2", "12.3", "12.4"] },
    { "id": 2, "tasks": ["5.2", "5.3", "5.4", "7.1", "11.2"] },
    { "id": 3, "tasks": ["7.2", "7.3", "7.4", "8.1", "11.3"] },
    { "id": 4, "tasks": ["8.2", "9.1"] },
    { "id": 5, "tasks": ["9.2"] },
    { "id": 6, "tasks": ["9.3"] },
    { "id": 7, "tasks": ["9.4", "9.5"] }
  ]
}
```
