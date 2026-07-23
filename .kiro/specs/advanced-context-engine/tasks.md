# Implementation Plan: Advanced Context Engine (Part 2)

## Overview

This plan implements the three Part-2 context capabilities over the existing FastAPI gateway (`services/gateway/src/zocai_gateway/`) and the shared Event_Contract. It is **refactor-first**: the ranking primitives (`context/rag_matcher.py`), the token gate (`context/token_gate.py`), the compression algorithm (`memory/matrix.py` `ConversationMemory.compress`), and the MAP_FILES selection/injection logic (`context/steering_compiler.py`) already exist and are unit-tested. Those tasks **surface the design's correctness properties as tests and wire the existing logic into the live Run — they do not reimplement the algorithms.**

The net-new work is: a real local embedder + `load_embedder()` factory, an `IndexPersistence` component and load-vs-rebuild gating, cold-start/lazy indexing, best-effort compression wiring, fail-closed MAP_FILES / READ_FILES FSM wiring, an APPLY_EDITS write-allowlist gate, and the two additive Event_Contract kinds (`map-files`, `context-compressed`) across both language twins.

Ordering is bottom-up and test-driven: dependencies and the Event_Contract twins land first (so emitting code can depend on them), then 2.1 (embedder → persistence → indexer integration → cold-start/lazy), then 2.2 (compression), then 2.3 (selector + FSM wiring → READ_FILES injection → write-allowlist gate), then integration and regression. Test sub-tasks are marked optional (`*`) per the repo convention; core implementation and wiring are non-optional. Property tests use Hypothesis (Python, `@settings(max_examples>=100)`) and fast-check (frontend, `{ numRuns: 200 }`), each tagged `Feature: advanced-context-engine, Property {n}`.

## Tasks

- [x] 1. Add dependencies and extend the Event_Contract twins (additive, R17)
  - [x] 1.1 Add `numpy` (required) and `fastembed` (optional, guarded) to `services/gateway/pyproject.toml`
    - Add `numpy>=1.26` to `[project].dependencies` (required for `.npy` persistence)
    - Add a guarded optional group, e.g. `[project.optional-dependencies].embeddings = ["fastembed>=0.3"]`, so absence degrades to the hash fallback rather than failing the suite
    - _Requirements: 1.1, 2.2_
  - [x] 1.2 Add `map-files` and `context-compressed` kinds to the Python contract `packages/shared-types/python/shared_schema/agent_events.py`
    - Add both discriminators to the `EventType` literal
    - Add `MapFilesEvent` (`read_list`/`readList`, `write_list`/`writeList`, `rationale`) and `ContextCompressedEvent` (`original_tokens`/`originalTokens`, `compressed_tokens`/`compressedTokens`, `compression_ratio`/`compressionRatio`) as `BaseEvent` subclasses; add both to the `AgentEvent` discriminated union and `__all__`
    - Preserve every existing kind and field unmodified
    - _Requirements: 11.3, 14.2, 17.1, 17.2_
  - [x] 1.3 Add the twin `MapFilesEvent` and `ContextCompressedEvent` interfaces to `packages/shared-types/typescript/src/agent-events.ts`
    - Identical camelCase field names and `type` discriminators; add both to the `AgentEvent` union and add `"map-files"` and `"context-compressed"` to the `EventType` union
    - Leave every existing interface and the `AgentEvent` union order otherwise intact
    - _Requirements: 11.3, 14.2, 17.1, 17.2_
  - [x]* 1.4 Write the contract twin parity test
    - Assert `map-files` and `context-compressed` appear in both twins with identical discriminators and field sets, and that every previously existing kind and its fields remain present and unmodified (reuse the repo's schema-generation/parity check)
    - _Requirements: 17.1, 17.2_

- [x] 2. Render the new kinds in the frontend Row_Registry and validate the gate
  - [x] 2.1 Add a dedicated `MapFilesRow` and register it in `ROW_COMPONENTS` (`apps/frontend/src/features/agent/rows.tsx`)
    - Render `readList`, `writeList`, and `rationale`; tag the row `data-event-type="map-files"`; register it under `"map-files"`
    - Do NOT add `context-compressed` to `ROW_COMPONENTS` (validated-but-non-rendered, like `budget`/`recovery-attempt`/`test-results`), so the registry stays total over the rendered `EventType` set
    - _Requirements: 14.3, 14.4, 11.6_
  - [x]* 2.2 Extend the row-registry totality property test (`rows.dispatch.property.test.tsx`)
    - **Property 20: The row registry is total and injective over rendered kinds, and discards unknown types**
    - fast-check `{ numRuns: 200 }`; add `"map-files"` to the dispatch test's `EVENT_TYPES` pin so totality stays exact
    - **Validates: Requirements 14.3, 14.4, 17.4, 17.5**
  - [x]* 2.3 Extend the emit-gate conformance property test for the two new kinds
    - **Property 19: The emit gate forwards a payload iff it conforms to the Event_Contract**
    - Hypothesis `>=100` examples; assert conforming `map-files`/`context-compressed` payloads forward, non-conforming payloads are discarded with a contract-violation entry naming `type`, and the stream stays open
    - **Validates: Requirements 11.4, 11.5, 17.3**

- [x] 3. Checkpoint - Ensure all contract and registry tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement the local semantic embedding model (`workspace_index.py`)
  - [x] 4.1 Implement `FastEmbedEmbedder` and the `load_embedder()` factory
    - `FastEmbedEmbedder` over fastembed `BAAI/bge-small-en-v1.5` (dim 384) implementing the existing `WorkspaceEmbedder` protocol; `info` returns `EmbedderInfo(kind="fastembed", model="BAAI/bge-small-en-v1.5", dim=384, is_fallback=False)`
    - `load_embedder()` tries `FastEmbedEmbedder`, and on any import/load error returns `_HashEmbedder()` (which reports `is_fallback=True`); the factory records the chosen embedder so `EmbedderInfo` reflects reality
    - _Requirements: 1.1, 1.3, 1.4_
  - [x]* 4.2 Write unit tests for embedder-info reporting and model-load fallback
    - Real embedder reports `is_fallback=False`, kind `fastembed`, dim 384; a forced model-load failure returns `_HashEmbedder` with `is_fallback=True`
    - _Requirements: 1.1, 1.3, 1.4_
  - [x]* 4.3 Write property test for dimension-mismatch abort and rejection
    - **Property 2: Dimension mismatch aborts the build and rejects the search**
    - Hypothesis `>=100`; a build embedder returning a wrong-dimension vector raises via `_validate_embeddings`, publishes `index.error`, and stores no `IndexedWorkspace`; a query embedding of wrong dimension is rejected by `cosine_sim`
    - **Validates: Requirements 1.6, 3.7**

- [x] 5. Implement index persistence and the load-vs-rebuild gate (net-new `context/index_store.py`)
  - [x] 5.1 Implement `workspace_hash()`, `IndexManifest`, and the `IndexPersistence` component
    - `workspace_hash(root)` = first 32 hex chars of `sha256(abs_path)`; `IndexManifest(schema_version, embedder, chunk_count, created_at)`; `INDICES_ROOT = ~/.zoc-studio/indices`, `INDEX_SCHEMA_VERSION = 1`
    - `save(...)` writes `embeddings.npy` (numpy, native dtype), `bm25.pkl`, `chunks.json`, `manifest.json` via temp file + atomic `os.replace`, confined under `INDICES_ROOT`
    - `load(..., current_embedder)` returns the reconstructed chunks/embeddings/`BM25Index` only when the manifest's embedder and schema version both match and every artifact reads/parses; otherwise returns `None` (miss/mismatch/corruption incl. `pickle.UnpicklingError`) without raising
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_
  - [x]* 5.2 Write property test for workspace-hash determinism
    - **Property 1: Workspace hash is a deterministic function of the absolute path**
    - **Validates: Requirements 2.1**
  - [x]* 5.3 Write property test for persisted-file confinement
    - **Property 3: Every persisted index file is confined to the indices root**
    - **Validates: Requirements 2.4**
  - [x]* 5.4 Write property test for the load-vs-rebuild gate
    - **Property 5: Load-vs-rebuild gate matches on embedder and schema**
    - **Validates: Requirements 2.5, 2.6, 2.7**

- [x] 6. Integrate persistence and hybrid retrieval into `WorkspaceIndexer` (`workspace_index.py`)
  - [x] 6.1 Wire load-then-build and persist-after-build into `rebuild()`
    - `__init__` gains an injectable `persistence: IndexPersistence | None`; default `embedder=load_embedder()`
    - `rebuild()` first tries `persistence.load(workspace_root, current_embedder=self._embedder.info)`; on a hit it populates `_indexes[session_id]` and publishes `index.completed` without scanning; on a miss it runs the existing build path and then calls `persistence.save(...)`
    - Keep the in-memory session-keyed API intact
    - _Requirements: 2.2, 2.3, 2.5_
  - [x] 6.2 Persist incremental updates after a successful recompute
    - After `_replace_changed_file_chunks` recomputes the aligned chunk/embedding set and rebuilds the BM25 index, call `persistence.save(...)` for the workspace; leave the prior in-memory index untouched and publish `index.error` on incremental failure (existing behavior preserved)
    - _Requirements: 4.7, 4.8_
  - [x]* 6.3 Write unit tests for off-loop embedding and debounce coalescing
    - Embedding runs via `asyncio.to_thread` without blocking the event loop; overlapping `fs://changed` events within the window coalesce into a single incremental update after the 2-second debounce
    - _Requirements: 1.5, 4.2, 4.3_
  - [x]* 6.4 Write property test for chunk/embedding alignment
    - **Property 4: Chunks and embeddings stay positionally aligned**
    - Across change/delete incremental updates, `len(embeddings) == len(chunks) == bm25_index.document_count`, embedding N is chunk N, and deleted/emptied files leave no chunk
    - **Validates: Requirements 1.2, 4.5**
  - [x]* 6.5 Write property test for persistence round-trip ranking
    - **Property 6: Persistence round-trip preserves ranking order**
    - Persist then load reproduces an identical `hybrid_search` ordering over the same chunk set (deterministic embedder in the test)
    - **Validates: Requirements 2.8**
  - [x]* 6.6 Write property test for incremental path confinement
    - **Property 9: Incremental updates exclude paths outside the workspace**
    - Every changed path resolving outside the workspace (via `..` or absolute-elsewhere) is excluded by `_resolve_changed_files`
    - **Validates: Requirements 4.6**
  - [x]* 6.7 Extend the rag_matcher property tests for reciprocal rank fusion
    - **Property 7: Reciprocal rank fusion is deterministic and excludes non-positive scores**
    - Extend `tests/test_rag_matcher*.py`; asserts existing `rrf(k=60)` behavior (no code change)
    - **Validates: Requirements 3.2, 3.4, 3.5**
  - [x]* 6.8 Extend the rag_matcher property tests for the hybrid result-set contract
    - **Property 8: Hybrid search returns a bounded, descending, deterministic prefix**
    - Extend `tests/test_rag_matcher*.py`; at most `k` (default 20), non-increasing fused score, ascending-index tie-break, empty for `k <= 0` (no code change)
    - **Validates: Requirements 3.3, 3.8**
  - [x]* 6.9 Extend the token-gate property test for the budget prefix
    - **Property 10: The token gate keeps a ranking-order prefix within budget**
    - Extend `tests/test_token_gate_fit_property.py` for `fit_chunks`; retained chunks are a ranking prefix within budget, admission stops at the first overflow, non-positive/empty yields empty with total 0 (no code change)
    - **Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.6, 5.7**

- [x] 7. Implement cold-start, missing-index, and lazy indexing (`workspace_index.py`)
  - [x] 7.1 Add the per-workspace build-state guard and the lazy option
    - `__init__` gains `lazy: bool = False`; add a per-workspace build-state map (`idle | building | ready`)
    - `query()` returns `[]` when no index is ready (never raises, never blocks); when `lazy` is enabled, startup skips load/build and the first `query()` for a workspace with no build started triggers exactly one background build guarded by the existing per-session `asyncio.Lock`; when `lazy` is disabled, startup loads-or-builds eagerly
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_
  - [x]* 7.2 Write unit tests for cold-start, lazy, and in-progress behavior
    - Empty result on cold start; exactly one build initiated on the first lazy query; empty result while a build is in progress; `index.started`/`index.progress`/`index.completed` emitted during a build; `index.error` on failure with the prior index retained
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.6, 6.7_

- [x] 8. Checkpoint - Ensure all Semantic Workspace Indexer tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Wire best-effort context compression into the Run
  - [x] 9.1 Implement the `runtime_summarizer` adapter over `model_runtime.generate_text` (`memory/matrix.py`)
    - A `Summarizer` that calls `generate_text(request.model_copy(update={"prompt": prompt}), timeout=60.0)` and raises `CompressionError` when no text is produced (no provider / empty), keeping the existing `model_summarizer` for tests
    - _Requirements: 9.1, 9.4_
  - [x] 9.2 Seed a `ConversationMemory` and add best-effort `_maybe_compress` to `RunPipeline` (`run_pipeline.py`)
    - Seed a `ConversationMemory` at run start with the system prompt (`Role.SYSTEM`) and the expanded user prompt (`Role.USER`), appending assistant/tool_result messages tagged with their `Stage`
    - Before each provider-backed brain call, run `_maybe_compress(memory, allocation.context_window)`: set `summarizer = runtime_summarizer(self.request)` only when a provider is configured, catch `CompressionError`/`ModelRuntimeError` to continue with the uncompressed history, and emit the `context-compressed` contract event on success
    - _Requirements: 9.5, 9.6, 11.1_
  - [x]* 9.3 Write unit tests for best-effort compression continuation
    - No provider → summarizer `None` → `CompressionError` caught → uncompressed continuation; a summarizer call failure → uncompressed continuation; a successful summary → compressed history and a single `context-compressed` emission
    - _Requirements: 9.4, 9.5, 9.6_
  - [x]* 9.4 Write property test for local token counting and additivity
    - **Property 11: Local token counting is char/4 rounded up and additive over the history**
    - `tests/test_context_compression_property.py`; asserts existing `count_tokens`/`count_history_tokens` (no code change)
    - **Validates: Requirements 7.2, 7.4**
  - [x]* 9.5 Write property test for the compression trigger threshold
    - **Property 12: Compression triggers exactly at the 0.7 threshold**
    - **Validates: Requirements 8.1, 8.2**
  - [x]* 9.6 Write property test for compression preservation
    - **Property 13: Compression preserves the prompt, recent turns, and current-stage tool results**
    - **Validates: Requirements 8.3, 8.4, 8.5, 8.6**
  - [x]* 9.7 Write property test for compression idempotence
    - **Property 14: Compression is idempotent**
    - **Validates: Requirements 10.1, 10.2, 10.3**
  - [x]* 9.8 Write property test for the compression event bounds
    - **Property 15: The compression event reports consistent, bounded counts**
    - **Validates: Requirements 11.1, 11.2**

- [x] 10. Checkpoint - Ensure all Context Compression tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Wire MAP_FILES selection into the live FSM (fail-closed)
  - [x] 11.1 Implement the `runtime_file_selector` adapter (`context/steering_compiler.py`)
    - A `FileSelector` over `generate_text(request.model_copy(update={"prompt": prompt}), timeout=120.0)` that raises `MapFilesError` when no text is produced (no provider / empty response), keeping the existing `model_file_selector` for tests
    - _Requirements: 12.7, 13.4_
  - [x] 11.2 Replace the bare `for _ in range(4): fsm.advance()` with explicit MAP_FILES wiring in `RunPipeline._run_agent` (`run_pipeline.py`)
    - Advance INTAKE→ANALYZE→MAP_FILES; choose the candidate source (RAG via `self.rag_matcher.extract(prompt)` by default; `WorkspaceIndexer.query(...)` when the `Hybrid_Candidate_Source` flag is enabled and a built index exists); call `select_map_files(task, candidates, select=runtime_file_selector(...), workspace_root=...)`
    - On no response / `ModelRuntimeError` / unparseable JSON / no provider, call `fsm.fail(...)` → `ERROR_CLOSED`; on success (including empty read/write lists) emit the `map-files` event and advance MAP_FILES→READ_FILES
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 13.1, 13.2, 13.3, 14.1_
  - [x]* 11.3 Write unit tests for the fail-closed FSM transitions
    - No provider, model-runtime error, unparseable response, and no response each transition the Run to `ERROR_CLOSED`; a well-formed empty read+write response proceeds; the candidate source switches to hybrid search only when the flag is enabled and an index exists
    - _Requirements: 12.7, 13.1, 13.2, 13.3, 13.4_
  - [x]* 11.4 Write property test for MAP_FILES confinement and read-list cap
    - **Property 16: File selection confines paths to the workspace and caps the read list**
    - `tests/test_map_files_selection_property.py`; every retained read/write path resolves within the workspace and the read list is capped at 8
    - **Validates: Requirements 12.5, 12.6**

- [x] 12. Inject selected file contents in READ_FILES and thread them into PLAN_EDITS (`run_pipeline.py`)
  - [x] 12.1 Build the read-files payload and thread it through `RunContext`
    - Advance MAP_FILES→READ_FILES; call `build_read_files_payload(read_list, self.toolset.read_file, token_cap=2000)`; add a `read_files_payload: str` field to `RunContext` consumed by `_agent_system_prompt`/`_structured_plan_system_prompt`; emit the `read-files` event listing paths read; continue to PLAN_EDITS even when the `read-files` emission fails
    - _Requirements: 15.1, 15.2, 15.5, 15.6, 15.7_
  - [x]* 12.2 Write property test for READ_FILES framing, cap, and skip
    - **Property 17: READ_FILES injection is framed, per-file capped, and skips unreadable files**
    - `tests/test_read_files_injection_property.py`; each read file is framed `=== FILE: {path} ===`, capped at 2000 tokens with the truncation marker when exceeded, and unreadable paths contribute no block while the rest still inject
    - **Validates: Requirements 15.2, 15.3, 15.4**

- [x] 13. Implement the APPLY_EDITS write-allowlist gate (`edits.py`, `run_pipeline.py`)
  - [x] 13.1 Add the Write_Allowlist gate and approval waiter to `EditCoordinator` (`edits.py`)
    - Inject `write_allowlist: frozenset[str]` (from `preapproved_writes(map_files_event)`) and a `wait_for_approval` waiter mirroring the existing `_wait_for_review_decision` pattern
    - In-allowlist paths are written; the first out-of-allowlist path halts before writing, retains already-applied changes, and emits an `ApprovalEvent` naming the exact path; approve → write the named change and resume the remaining plan; extend `ApplyOutcome` with a needs-approval / rejected outcome
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5_
  - [x] 13.2 Map the approval outcome onto wait/resume/PAUSED in `RunPipeline` (`run_pipeline.py`)
    - Thread the `map-files` write allowlist and the review-decision waiter into the `EditCoordinator`; on rejection, transition the Run to the `PAUSED` stage
    - _Requirements: 16.6_
  - [x]* 13.3 Write unit tests for the approval wait/resume/PAUSED flow
    - In-allowlist write proceeds; an out-of-allowlist path halts with an `ApprovalEvent` and retains prior applied changes; approval resumes the remaining plan; rejection moves the Run to `PAUSED`
    - _Requirements: 16.3, 16.4, 16.5, 16.6_
  - [x]* 13.4 Write property test for the write-allowlist gate
    - **Property 18: The write allowlist admits declared paths and halts on undeclared ones**
    - `tests/test_write_allowlist_property.py`
    - **Validates: Requirements 16.2, 16.3**

- [x] 14. Checkpoint - Ensure all MAP_FILES / READ_FILES / APPLY_EDITS tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. Integration tests and full-suite regression
  - [x]* 15.1 Write a skip-if-absent real `fastembed` load integration test
    - Load the real `BAAI/bge-small-en-v1.5` embedder (skip when `fastembed` is not installed); assert dim 384 and `is_fallback=False`
    - _Requirements: 1.1_
  - [x]* 15.2 Write a persist→reopen reuse integration test
    - Build and persist an index, then a fresh `WorkspaceIndexer` loads the persisted artifacts (no rescan) and reproduces the query ordering across the reopen
    - _Requirements: 2.5, 2.8_
  - [x]* 15.3 Write an end-to-end MAP_FILES→READ_FILES→PLAN_EDITS→APPLY_EDITS integration test
    - Drive a full Agent run through `RunPipeline` with a stubbed provider, exercising the candidate source, read-files injection into PLAN_EDITS, and the write-allowlist gate
    - _Requirements: 12.1, 14.1, 15.6, 16.2_

- [x] 16. Final checkpoint - Ensure the full suite is green
  - Run the gateway suite (`pytest` under `services/gateway`, Hypothesis at >=100 examples), the frontend suite (`vitest --run` for the fast-check registry property), `ruff`/`mypy`, the TypeScript build, and the two-twin parity check. Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation and wiring tasks are never optional.
- **Refactor-first:** tasks 6.7, 6.8, 6.9 (ranking/budget) and 9.4–9.8 (compression) assert behavior of existing, unit-tested code and expect **no algorithm changes** — they surface the design's correctness properties as executable tests.
- Each task references specific requirement sub-clauses for traceability; each property sub-task names its design Property number and the requirements it validates.
- The Event_Contract twins (1.2, 1.3) land before any emitting code (9.2 emits `context-compressed`, 11.2 emits `map-files`), so the emit path always has a conforming schema.
- `context-compressed` is validated-but-non-rendered (not added to `ROW_COMPONENTS`); only `map-files` gets a dedicated row, matching the design decision.
- Property tests use Hypothesis (Python, >=100 examples) and fast-check (frontend, 200 runs); each correctness property is implemented by exactly one property-based test.
- Checkpoints validate each capability incrementally before the next is wired in.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "4.1", "5.1", "9.1", "11.1", "13.1"] },
    { "id": 1, "tasks": ["1.4", "2.1", "2.3", "4.2", "4.3", "5.2", "6.1", "6.7", "9.2", "9.4"] },
    { "id": 2, "tasks": ["2.2", "5.3", "6.2", "6.8", "9.3", "9.5", "11.2"] },
    { "id": 3, "tasks": ["5.4", "6.3", "6.4", "6.5", "6.6", "6.9", "7.1", "9.6", "11.3", "11.4", "12.1"] },
    { "id": 4, "tasks": ["7.2", "9.7", "12.2", "13.2", "13.4"] },
    { "id": 5, "tasks": ["9.8", "13.3"] },
    { "id": 6, "tasks": ["15.1", "15.2", "15.3"] }
  ]
}
```
