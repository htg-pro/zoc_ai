# Requirements Document

## Introduction

This specification defines **Part 2 — Advanced Context Engine** for Zoc Studio: three related context capabilities in the FastAPI gateway (`services/gateway/src/zocai_gateway/`). The three capabilities are specified together because they share the retrieval stack, the shared Event_Contract, and the Agent-Mode FSM, but each is designed to remain **independently shippable**.

- **2.1 Semantic Workspace Indexer** — a hybrid lexical + semantic retriever over the workspace, backed by a local (no-API-key) embedding model, persisted to disk, kept current by incremental updates, and budgeted to the model context window. Retrieval-stack files: `context/rag_matcher.py` (ranking primitives), `workspace_index.py` (chunking, embeddings, incremental updates), and `context/token_gate.py` (budget enforcement).
- **2.2 Intelligent Context Compression** — sizes a conversation history to a model window by summarizing the middle of the conversation while preserving the system prompt, the most recent turns, and the current stage's tool results. File: `memory/matrix.py`.
- **2.3 File-Level Context Steering (MAP_FILES stage)** — wires the existing, unwired MAP_FILES logic into the live FSM so a Run selects a minimum read set, declares intended writes, surfaces the selection, injects capped file content, and pre-approves declared writes. File: `context/steering_compiler.py`.

### Relationship to existing code

Substantial machinery for these capabilities already exists in the repository and is treated as the current baseline, not as greenfield work:

- `context/rag_matcher.py` already provides `BM25Index`, `cosine_sim`, `rrf` (reciprocal rank fusion, default constant 60), `hybrid_rank`, and `hybrid_search`.
- `workspace_index.py` already provides `WorkspaceIndexer` with chunking (`IndexChunk`), a `WorkspaceEmbedder` protocol, a dependency-free `_HashEmbedder` fallback, incremental updates keyed on `fs://changed` events with a 2-second debounce, and hybrid retrieval via `query()`.
- `context/token_gate.py` already provides `fit_chunks` and `hybrid_search_within_budget`.
- `memory/matrix.py` already provides `ConversationMemory.compress(max_tokens)`, `ContextCompressedEvent`, tiktoken (`cl100k_base`) and 4-characters-per-token counting, and the preserve/summarize/idempotence algorithm.
- `context/steering_compiler.py` already provides `MAP_FILES_INSTRUCTION`, `MapFilesEvent`, `select_map_files`, `build_read_files_payload`, `preapproved_writes`, and `is_write_preapproved`, none of which are called by `run_pipeline.py` today.

The **net new** work this specification requires is therefore: a real local embedding model (§2.1 R1), on-disk index persistence and versioning (§2.1 R2), cold-start / missing-index / lazy-index behavior (§2.1 R6), wiring compression into the live Run (§2.2), wiring MAP_FILES into the live FSM (§2.3), and two additions to the shared Event_Contract — `map-files` and `context-compressed` (§2.2 R11, §2.3 R14, cross-cutting R17).

### Resolved decisions (from requirements clarification)

- **MAP_FILES candidate source (incremental, independently shippable).** MAP_FILES continues to source Candidate_Fragments from `RagMatcher.extract()` by default. WHERE a built semantic index exists for the Run's workspace and the Hybrid_Candidate_Source is enabled, MAP_FILES sources Candidate_Fragments from the Semantic_Indexer's hybrid search instead. Neither 2.1 nor 2.3 depends on the other to ship: with 2.1 absent, MAP_FILES uses the RAG_Matcher; with 2.3 absent, the Semantic_Indexer is still usable by other callers.
- **Two new Event_Contract kinds.** This specification adds `map-files` and `context-compressed` to the shared Event_Contract (the Python module `agent_events.py`, its TypeScript twin `agent-events.ts`, and the frontend `ROW_COMPONENTS` registry). `map-files` renders as a dedicated MapFiles row per the absorbed spec. `context-compressed` renders as a compact compression banner row; the design phase MAY instead treat it as a validated-but-non-rendered informational event (matching the existing `budget`, `recovery-attempt`, and `test-results` kinds), but MUST still add the kind to both language twins.

### Scope boundaries

- **Supersedes `map-files-context-stage`.** This specification absorbs the in-progress `.kiro/specs/map-files-context-stage/` spec (requirements only; no design or tasks). The five MAP_FILES requirements carried forward as §2.3 preserve that spec's approved substance, adapted for the combined scope. The design and tasks phases treat `map-files-context-stage` as absorbed and produce no separate artifacts for it.
- **Model call path.** MAP_FILES selection and §2.2 summarization call the Run's configured provider through the `model_runtime.generate_text` path already used by `think`, `structured_plan`, and `edit_plan`, not through the `ModelInterface` tier stubs (which return empty text today).
- **Fail-closed MAP_FILES.** A model-runtime failure, an unparseable selection response, or the File_Selector producing no response (including no configured provider) fails the Run closed (no retry). This is a deliberate departure from `think`/`structured_plan`/`edit_plan`, which fall back to empty defaults.
- **Best-effort compression.** §2.2 compression is best-effort: WHERE compression is unavailable or its summarization call fails, the Run continues with the uncompressed history rather than failing.
- **Persistence location.** Semantic index artifacts are persisted under the user-home directory `~/.zoc-studio/indices/`. This is distinct from the workspace-relative `.zocai/` memory matrix directory, which this specification does not change.
- **Out of scope.** Rust-accelerated indexing (`crates/hotpath`), index sharding for very large monorepos, SSE backpressure, the Monaco/LSP work of Part 3 (`monaco-lsp-integration`), and the reasoning work of Part 1 (`agent-reasoning-engine`). This specification covers only capabilities 2.1, 2.2, and 2.3.

## Glossary

### Shared

- **Run**: A single execution of an Agent-Mode task driven by the FSM.
- **FSM**: The 9-stage finite state machine governing a Run (INTAKE, ANALYZE, MAP_FILES, READ_FILES, PLAN_EDITS, APPLY_EDITS, RUN_CHECKS, SUMMARY, DONE), plus the off-happy-path HANDLE_ERROR, PAUSED, and ERROR_CLOSED stages.
- **Stage**: One member of the FSM stage set (`stages.py` `Stage`).
- **Run_Pipeline**: The component in `run_pipeline.py` that drives a Run through the FSM stages.
- **Model_Runtime**: The component (`model_runtime.py`) that sends a prompt to the Run's configured model provider through `generate_text` and returns generated text, returning no text when no provider is configured and raising a model-runtime error when a configured provider call fails.
- **Local_Model**: A model served by the Local SLM tier, which ships no dedicated tokenizer.
- **Event_Bus**: The process-local publish/subscribe bus (`event_bus.py` `GatewayEventBus`).
- **FS_Changed_Event**: A `WorkspaceFilesChanged` event published on the Event_Bus `fs://changed` topic, carrying a session identifier and the changed workspace-relative paths.
- **Event_Contract**: The shared, type-safe SSE event schema defining every Event_Row kind a Run can emit, expressed as the Python module `agent_events.py` and its TypeScript twin `agent-events.ts`.
- **Event_Row**: One structured event kind streamed over the SSE bus, identified by its `type` discriminator.
- **Emit_Gate**: The component (`emit_gate.py`) that validates each payload against the Event_Contract via `AgentEventModel.model_validate`, forwarding conforming payloads and discarding non-conforming ones without closing the stream.
- **Row_Registry**: The frontend mapping (`ROW_COMPONENTS`) from an Event_Row's `type` discriminator to exactly one rendering component, required to be total over the rendered event kinds.
- **Run_Feed**: The frontend component tree (`AgentRunFeed.tsx`) that renders a Run's received Event_Rows in emission order.
- **Workspace_Root**: The confined root directory all Run file operations must resolve within.
- **Developer**: The human user operating the Run.

### 2.1 Semantic Workspace Indexer

- **Semantic_Indexer**: The retrieval stack that scans, chunks, embeds, ranks, persists, and budgets workspace context, spanning `workspace_index.py` (`WorkspaceIndexer`), `context/rag_matcher.py` (ranking primitives), and `context/token_gate.py` (budget).
- **Code_Chunk**: One indexed span of a workspace file (`IndexChunk`: id, file, start line, end line, text).
- **Embedding_Model**: The local, no-API-key embedding model `fastembed` `BAAI/bge-small-en-v1.5`, run on CPU, implementing the `WorkspaceEmbedder` protocol.
- **Hash_Embedder**: The dependency-free deterministic fallback embedder (`_HashEmbedder`) used when the Embedding_Model is unavailable.
- **Embedder_Info**: The record of the active embedder's identity (`EmbedderInfo`: kind, model, dimension, fallback flag).
- **Embedding_Matrix**: The array of one Embedding_Vector per Code_Chunk, positionally aligned with the BM25_Index documents, persisted as `embeddings.npy`.
- **Embedding_Vector**: One Code_Chunk's embedding.
- **BM25_Index**: The lexical index over the Code_Chunks (`BM25Index`), persisted as `bm25.pkl`.
- **Query_Embedder**: The callable that embeds a query into the Embedding_Matrix vector space (`QueryEmbedder` / `embed_query`).
- **Hybrid_Search**: The retrieval operation (`hybrid_search`) fusing BM25 and semantic rankings via reciprocal rank fusion and returning the top ranked Code_Chunks.
- **Reciprocal_Rank_Fusion**: The rank-combination method (`rrf`) with fusion constant 60.
- **Token_Gate**: The budget enforcer (`token_gate.py` `fit_chunks` / `hybrid_search_within_budget`) that admits ranked Code_Chunks until the Context_Budget is reached.
- **Context_Budget**: The maximum token total, in tokens, allowed for the retrieved context payload.
- **Workspace_Hash**: The deterministic identifier derived from the absolute Workspace_Root path, used to locate that workspace's persisted index directory `~/.zoc-studio/indices/<workspace_hash>/`.
- **Index_Manifest**: The metadata persisted alongside the index files recording the Embedder_Info and the index schema version.
- **Index_Progress_Frame**: A `WorkspaceIndexProgress` event describing index build state (`index.started`, `index.progress`, `index.completed`, `index.error`).
- **Lazy_Index_Option**: The configuration option that defers index building until the first retrieval request for a workspace.

### 2.2 Intelligent Context Compression

- **Context_Compressor**: The component that sizes a conversation history to a model window (`memory/matrix.py` `ConversationMemory.compress`).
- **Conversation_History**: The ordered list of Messages sent to the model each turn.
- **Message**: One conversation message with a role (system, user, assistant, tool_result), content, and owning Stage.
- **System_Prompt**: The leading run of system Messages at the head of the Conversation_History.
- **Turn**: One user or assistant Message.
- **History_Token_Count**: The total token count across every Message's content.
- **Summarizer**: The callable that turns the rendered middle-of-conversation prompt into a summary string, backed by the Model_Runtime.
- **Compressed_History_Marker**: The literal prefix `[COMPRESSED HISTORY]` identifying the synthetic system Message that replaces the summarized middle.
- **Context_Compressed_Event**: The event carrying `original_tokens`, `compressed_tokens`, and `compression_ratio`, emitted after a history is compressed and surfaced over the Event_Contract as the `context-compressed` Event_Row.

### 2.3 File-Level Context Steering (MAP_FILES)

- **Steering_Compiler**: The component (`context/steering_compiler.py`) that performs MAP_FILES file selection and READ_FILES content injection.
- **File_Selector**: The injectable callable that sends the MAP_FILES prompt to the Model_Runtime and returns its raw text response.
- **RAG_Matcher**: The component (`context/rag_matcher.py`) that extracts code fragments relevant to the Run's task description via `extract()`.
- **Candidate_Fragment**: One fragment presented to the File_Selector as a candidate file, sourced from the RAG_Matcher or, when enabled and available, from Hybrid_Search.
- **Hybrid_Candidate_Source**: The option that lets MAP_FILES source Candidate_Fragments from the Semantic_Indexer's Hybrid_Search when a built index exists for the workspace.
- **Read_List**: The validated, workspace-relative list of file paths a Run will read, capped at 8 entries.
- **Write_List**: The validated, workspace-relative list of file paths a Run declares it will create or modify.
- **Rationale**: The File_Selector's explanation for the selected Read_List and Write_List.
- **Map_Files_Event**: The Event_Row emitted after MAP_FILES completes, carrying the Read_List, the Write_List, and the Rationale, surfaced over the Event_Contract as the `map-files` Event_Row.
- **Write_Allowlist**: The set of Write_List paths from a Run's Map_Files_Event that APPLY_EDITS may write without a Developer decision.
- **Per_File_Token_Cap**: The fixed 2000-token limit applied to injected file content per file in READ_FILES.
- **Truncation_Marker**: The literal text `... [truncated]` appended to file content cut off at the Per_File_Token_Cap.
- **Approval_Event**: The Event_Row requesting a Developer decision before APPLY_EDITS writes a planned change outside the Write_Allowlist.
- **EditCoordinator**: The component (`edits.py`) that applies planned changes during APPLY_EDITS.

## Requirements

## Part 2.1 — Semantic Workspace Indexer

### Requirement 1: Local Semantic Embedding Model

**User Story:** As a developer working offline, I want the workspace indexed by a local embedding model with no API key, so that semantic search works without external services or credentials.

#### Acceptance Criteria

1. WHERE the Embedding_Model is available, THE Semantic_Indexer SHALL embed each Code_Chunk with `BAAI/bge-small-en-v1.5` on CPU at index time and SHALL set the Embedder_Info fallback flag to false.
2. THE Semantic_Indexer SHALL produce exactly one Embedding_Vector per Code_Chunk and SHALL assemble them into the Embedding_Matrix such that the Embedding_Vector at position N is the embedding of the same Code_Chunk indexed as document N in the BM25_Index.
3. IF the Embedding_Model cannot be loaded, THEN THE Semantic_Indexer SHALL embed Code_Chunks with the Hash_Embedder and SHALL set the Embedder_Info fallback flag to true.
4. THE Semantic_Indexer SHALL record the active embedder kind, model identifier, and vector dimension in the Embedder_Info.
5. WHEN embedding a batch of Code_Chunks, THE Semantic_Indexer SHALL run the embedding work off the gateway event-loop thread without blocking that thread.
6. IF the Embedding_Model returns an Embedding_Vector whose dimension differs from the vector dimension recorded in the Embedder_Info, THEN THE Semantic_Indexer SHALL abort the index build, SHALL surface an embedding error identifying the dimension mismatch, and SHALL NOT produce an Embedding_Matrix for that build.

### Requirement 2: Index Persistence and Versioning

**User Story:** As a developer, I want the semantic index persisted to disk and reused across restarts, so that reopening a workspace does not require a full re-index.

#### Acceptance Criteria

1. THE Semantic_Indexer SHALL derive the Workspace_Hash deterministically from the absolute Workspace_Root path, such that the same absolute Workspace_Root path always yields the same Workspace_Hash.
2. WHEN a workspace index build completes, THE Semantic_Indexer SHALL persist the Embedding_Matrix to `~/.zoc-studio/indices/<workspace_hash>/embeddings.npy` and the BM25_Index to `~/.zoc-studio/indices/<workspace_hash>/bm25.pkl`.
3. WHEN a workspace index build completes, THE Semantic_Indexer SHALL persist an Index_Manifest recording the Embedder_Info and the index schema version in the same `<workspace_hash>` directory.
4. THE Semantic_Indexer SHALL confine every persisted index file within the `~/.zoc-studio/indices/` directory.
5. WHEN the Semantic_Indexer starts for a workspace whose persisted Index_Manifest exists and records an Embedder_Info and index schema version that both equal the current configuration, THE Semantic_Indexer SHALL load the persisted Embedding_Matrix and BM25_Index instead of rebuilding the index.
6. IF a persisted Index_Manifest records an Embedder_Info or index schema version that differs from the current configuration, THEN THE Semantic_Indexer SHALL rebuild the index from the workspace.
7. IF loading a persisted Index_Manifest, Embedding_Matrix, or BM25_Index fails because the file is absent, cannot be read, or cannot be parsed into a valid structure, THEN THE Semantic_Indexer SHALL rebuild the index from the workspace.
8. FOR ALL built indices, persisting the Embedding_Matrix and BM25_Index and then loading them SHALL reconstruct an index that, for any query and identical chunk set, produces a Hybrid_Search result ordering identical to the ordering produced by the pre-persistence index (round-trip property).

### Requirement 3: Hybrid Ranking

**User Story:** As a developer, I want search results that combine keyword and semantic relevance, so that retrieval finds both exact-term and conceptually related code.

#### Acceptance Criteria

1. WHEN Hybrid_Search is invoked with a query, THE Semantic_Indexer SHALL compute BM25 scores over the BM25_Index and cosine similarities over the Embedding_Matrix for that query.
2. THE Semantic_Indexer SHALL fuse the BM25 ranking and the semantic ranking using Reciprocal_Rank_Fusion with fusion constant 60.
3. THE Semantic_Indexer SHALL return at most the requested number of Code_Chunks, ordered by descending fused score, defaulting to 20 when no result count is provided.
4. THE Semantic_Indexer SHALL break fused-score ties by ascending Code_Chunk index so the ranking is deterministic.
5. IF a Code_Chunk receives neither a positive BM25 score nor a positive semantic score, THEN THE Semantic_Indexer SHALL exclude that Code_Chunk from the fused results, treating a zero score as non-positive.
6. THE Query_Embedder SHALL embed the query into the same vector dimension as the Embedding_Matrix.
7. IF the query embedding dimension differs from the Embedding_Matrix dimension, THEN THE Semantic_Indexer SHALL reject the search with a dimension-mismatch error.
8. IF the requested result count is zero or negative, THEN THE Semantic_Indexer SHALL return an empty result set.

### Requirement 4: Incremental Index Updates

**User Story:** As a developer editing files, I want the index to update only the changed files, so that it stays current without the cost of a full rebuild.

#### Acceptance Criteria

1. WHEN the Semantic_Indexer initializes for a workspace, THE Semantic_Indexer SHALL subscribe to FS_Changed_Events on the Event_Bus `fs://changed` topic.
2. WHEN an FS_Changed_Event is received for an indexed workspace, THE Semantic_Indexer SHALL record the changed paths and SHALL start a 2-second debounce interval.
3. WHILE a debounce interval for a workspace is active, WHEN a further FS_Changed_Event for that workspace is received, THE Semantic_Indexer SHALL add the event's changed paths to the pending set for that workspace and SHALL restart the debounce interval.
4. WHEN a debounce interval for a workspace elapses, THE Semantic_Indexer SHALL re-chunk and re-embed only the Code_Chunks of the changed files accumulated in that workspace's pending set.
5. WHEN incremental re-embedding completes, THE Semantic_Indexer SHALL replace each changed file's prior Code_Chunks and Embedding_Vectors in the Embedding_Matrix with the newly produced Code_Chunks and Embedding_Vectors, SHALL remove the prior Code_Chunks and Embedding_Vectors of any changed file that produces no Code_Chunk (including a deleted file), and SHALL rebuild the BM25_Index over the updated Code_Chunk set, keeping Code_Chunks and Embedding_Vectors positionally aligned.
6. IF a changed path resolves outside the Workspace_Root, THEN THE Semantic_Indexer SHALL exclude that path from the incremental update.
7. WHEN an incremental update changes a persisted index, THE Semantic_Indexer SHALL update the persisted `embeddings.npy` and `bm25.pkl` for that Workspace_Hash.
8. IF re-chunking, re-embedding, or rebuilding the BM25_Index fails during an incremental update for a workspace, THEN THE Semantic_Indexer SHALL leave that workspace's previously loaded Code_Chunks, Embedding_Matrix, and BM25_Index unchanged and SHALL publish an `index.error` Index_Progress_Frame for that workspace.

### Requirement 5: Context Budget Enforcement

**User Story:** As a developer, I want retrieved context capped to the model's window, so that the most relevant chunks are included without overflowing the context budget.

#### Acceptance Criteria

1. WHEN Hybrid_Search results are prepared for a Run's context, THE Semantic_Indexer SHALL pass the ranked Code_Chunks through the Token_Gate in ranking order.
2. WHILE the running token total remains less than or equal to the Context_Budget, THE Token_Gate SHALL admit the next Code_Chunk in ranking order into the retained Code_Chunk list.
3. IF admitting the next Code_Chunk in ranking order would make the running token total exceed the Context_Budget, THEN THE Token_Gate SHALL stop admission and SHALL NOT admit that Code_Chunk or any lower-ranked Code_Chunk.
4. WHEN admission completes, THE Token_Gate SHALL return the retained Code_Chunk list together with a total-tokens count equal to the sum of the token counts of the retained Code_Chunks, and this total-tokens count SHALL be less than or equal to the Context_Budget.
5. IF the Context_Budget is zero or negative, THEN THE Token_Gate SHALL return an empty retained Code_Chunk list with a total-tokens count of 0.
6. THE Token_Gate SHALL preserve the Hybrid_Search ranking order in the retained Code_Chunk list.
7. IF the Hybrid_Search returns no Code_Chunks and the Context_Budget is positive, THEN THE Token_Gate SHALL return an empty retained Code_Chunk list with a total-tokens count of 0.

### Requirement 6: Cold Start, Missing Index, and Lazy Indexing

**User Story:** As a developer opening a workspace, I want retrieval to behave predictably before an index exists, so that a Run is never blocked or crashed by a missing or building index.

#### Acceptance Criteria

1. WHEN a Run requests retrieval for a workspace that has no in-memory index and no matching persisted index, THE Semantic_Indexer SHALL return an empty result set without raising an error and without aborting the Run.
2. WHERE the Lazy_Index_Option is enabled, THE Semantic_Indexer SHALL skip building and loading the index for a workspace at startup.
3. WHERE the Lazy_Index_Option is enabled, WHEN the first retrieval request for a workspace is received and no index build for that workspace has yet been initiated, THE Semantic_Indexer SHALL initiate exactly one index build for that workspace.
4. WHILE an index build for a workspace is in progress, WHEN a Run requests retrieval for that workspace, THE Semantic_Indexer SHALL return an empty result set without blocking the Run on the build.
5. WHERE the Lazy_Index_Option is disabled, WHEN a workspace is opened at startup, THE Semantic_Indexer SHALL make the workspace index available by loading the matching persisted index if one exists, or otherwise building the index.
6. WHILE an index build for a workspace is in progress, THE Semantic_Indexer SHALL publish Index_Progress_Frames for build start, ongoing progress, and successful completion.
7. IF an index build for a workspace fails, THEN THE Semantic_Indexer SHALL continue publishing Index_Progress_Frames until the failing build stops, SHALL then publish an `index.error` Index_Progress_Frame, and SHALL leave any previously loaded index for that workspace unchanged.

## Part 2.2 — Intelligent Context Compression

### Requirement 7: Conversation Token Counting

**User Story:** As a developer, I want conversation size measured accurately per model family, so that compression triggers on true token cost rather than a guess.

#### Acceptance Criteria

1. WHERE the Run's model is a GPT-family model (any model that is not a Local_Model), THE Context_Compressor SHALL count each Message content's tokens as the number of tokens produced by encoding that content with the tiktoken `cl100k_base` encoding.
2. WHERE the Run's model is a Local_Model, THE Context_Compressor SHALL count each Message content's tokens as its character count divided by 4 with any remaining characters rounded up to one additional token, and SHALL count 0 tokens for empty content.
3. IF the tiktoken `cl100k_base` encoding cannot be loaded, THEN THE Context_Compressor SHALL count GPT-family Message content tokens using the same 4-characters-per-token estimate (character count divided by 4, remainder rounded up, and 0 for empty content) rather than failing.
4. THE Context_Compressor SHALL compute the History_Token_Count as the sum, over every Message in the Conversation_History, of that Message content's token count under the counting strategy selected for the Run's model, and SHALL yield a History_Token_Count of 0 for an empty Conversation_History.

### Requirement 8: Compression Trigger and Preservation

**User Story:** As a developer, I want large histories compressed while recent and load-bearing context is kept, so that the model retains what it needs to continue the task.

#### Acceptance Criteria

1. WHEN the Context_Compressor is invoked with a maximum-token limit and the History_Token_Count is below 0.7 times that limit, THE Context_Compressor SHALL return the Conversation_History unchanged.
2. WHEN the Context_Compressor is invoked with a maximum-token limit and the History_Token_Count is greater than or equal to 0.7 times that limit, THE Context_Compressor SHALL compress the Conversation_History.
3. WHEN compressing, THE Context_Compressor SHALL preserve all System_Prompt Messages at the beginning of the Conversation_History.
4. WHEN compressing, THE Context_Compressor SHALL preserve the most recent 4 user-and-assistant Turns, or all user-and-assistant Turns if fewer than 4 exist.
5. WHEN compressing, THE Context_Compressor SHALL preserve every tool_result Message belonging to the current Stage.
6. WHEN compressing, THE Context_Compressor SHALL replace the Messages that are neither preserved nor part of the System_Prompt with a single system Message beginning with the Compressed_History_Marker.
7. IF, after preserving the System_Prompt Messages, the most recent user-and-assistant Turns, and the current Stage's tool_result Messages, no Messages remain to be replaced, THEN THE Context_Compressor SHALL return the Conversation_History unchanged.

### Requirement 9: Middle-Section Summarization

**User Story:** As a developer, I want the summarized middle to retain the facts I need, so that file names, errors, and decisions survive compression.

#### Acceptance Criteria

1. WHEN summarizing the middle section, THE Context_Compressor SHALL request a summary from the Run's configured provider through the Model_Runtime generate_text operation.
2. THE Context_Compressor SHALL instruct the Summarizer to summarize the coding conversation in 200 words or fewer while preserving all file names, error messages, and decisions made.
3. WHEN the Summarizer returns a summary for a Run, THE Context_Compressor SHALL place the summary into the single system Message immediately after the Compressed_History_Marker.
4. IF compression is required but no Summarizer is configured for the Run, THEN THE Context_Compressor SHALL signal a compression error to the caller.
5. IF the Context_Compressor signals a compression error for a Run, OR a configured Summarizer call fails for the Run, THEN THE Run_Pipeline SHALL continue the Run with the uncompressed Conversation_History.
6. WHEN the Summarizer returns a summary for a Run, THE Run_Pipeline SHALL continue the Run with the compressed Conversation_History.

### Requirement 10: Compression Idempotence

**User Story:** As a developer, I want repeated compression to be safe, so that an already-compressed history is never re-summarized or double-counted.

#### Acceptance Criteria

1. WHEN the Context_Compressor compresses a Conversation_History that already contains a system Message beginning with the Compressed_History_Marker, THE Context_Compressor SHALL return a Conversation_History identical to the input Conversation_History, containing the same Messages in the same order with identical content.
2. WHEN the Context_Compressor compresses a Conversation_History that already contains a system Message beginning with the Compressed_History_Marker, THE Context_Compressor SHALL emit no Context_Compressed_Event.
3. WHEN the Context_Compressor compresses a Conversation_History that is the output of a previous compression performed with the same maximum-token limit, THE Context_Compressor SHALL return a Conversation_History identical to that previous output, containing the same Messages in the same order with identical content.

### Requirement 11: Context Compressed Event

**User Story:** As a developer, I want to see when my context was compressed and by how much, so that I understand why earlier turns are summarized.

#### Acceptance Criteria

1. WHEN the Context_Compressor compresses a Conversation_History, THE Context_Compressor SHALL emit a Context_Compressed_Event carrying `original_tokens` as a positive integer, `compressed_tokens` as a non-negative integer not exceeding `original_tokens`, and `compression_ratio`.
2. THE Context_Compressor SHALL set `compression_ratio` to `compressed_tokens` divided by `original_tokens`, yielding a value between 0 and 1 inclusive.
3. THE Event_Contract SHALL define a `context-compressed` Event_Row kind, carrying `original_tokens`, `compressed_tokens`, and `compression_ratio`, in the Python contract and its TypeScript twin.
4. WHEN the Emit_Gate validates a conforming `context-compressed` payload, THE Emit_Gate SHALL forward it to the SSE sink.
5. IF the Emit_Gate receives a `context-compressed` payload that does not conform to the Event_Contract, THEN THE Emit_Gate SHALL reject the payload without forwarding it to the SSE sink.
6. WHERE the `context-compressed` Event_Row kind is rendered by the Run_Feed, THE Row_Registry SHALL map exactly one component to it.

## Part 2.3 — File-Level Context Steering (MAP_FILES Stage)

### Requirement 12: Select Minimum Files to Read and Declare Files to Write

**User Story:** As a developer running an Agent-Mode task, I want the system to select the minimum set of files it needs to read and to declare which files it will create or modify, so that the Run focuses its context on relevant files while I can see its intended scope.

#### Acceptance Criteria

1. WHEN the FSM enters the MAP_FILES stage, THE Steering_Compiler SHALL send the Run's task description and Candidate_Fragments to the File_Selector using the MAP_FILES_INSTRUCTION prompt.
2. WHERE the Hybrid_Candidate_Source is enabled and a built index exists for the Run's workspace, THE Steering_Compiler SHALL source Candidate_Fragments from the Semantic_Indexer's Hybrid_Search results.
3. WHERE the Hybrid_Candidate_Source is disabled or no built index exists for the Run's workspace, THE Steering_Compiler SHALL source Candidate_Fragments from the RAG_Matcher's fragments for the Run.
4. WHEN the File_Selector returns a response, THE Steering_Compiler SHALL parse a Read_List, a Write_List, and a Rationale from the response's `read`, `write`, and `rationale` fields.
5. IF a parsed Read_List or Write_List path resolves outside the Workspace_Root, THEN THE Steering_Compiler SHALL exclude that path from the Read_List or Write_List.
6. THE Steering_Compiler SHALL limit the validated Read_List to at most 8 paths.
7. IF the File_Selector produces no response for the Run, THEN THE FSM SHALL transition the Run to the ERROR_CLOSED stage.

### Requirement 13: Handle File-Selection Failures Safely

**User Story:** As a developer, I want file selection to fail safely when the model call fails or returns output the system cannot use, so that a bad model response does not silently corrupt the Run or continue with incorrect files.

#### Acceptance Criteria

1. IF the File_Selector call raises a model-runtime error, THEN THE FSM SHALL transition the Run to the ERROR_CLOSED stage.
2. IF the File_Selector response cannot be parsed as a JSON object, THEN THE FSM SHALL transition the Run to the ERROR_CLOSED stage.
3. WHERE the parsed response contains an empty `read` list and an empty `write` list, THE Steering_Compiler SHALL proceed with an empty Read_List and an empty Write_List.
4. IF no model provider is configured for the Run, THEN THE FSM SHALL transition the Run to the ERROR_CLOSED stage.

### Requirement 14: Surface the File Selection to the Developer

**User Story:** As a developer, I want to see which files a Run selected to read and write before it proceeds, so that I understand the Run's intended scope.

#### Acceptance Criteria

1. WHEN file selection completes for a Run, THE Steering_Compiler SHALL emit a Map_Files_Event carrying the Read_List, the Write_List, and the Rationale.
2. THE Event_Contract SHALL define a `map-files` Event_Row kind, carried by the Map_Files_Event, in the Python contract and its TypeScript twin.
3. WHEN the Run_Feed receives a `map-files` Event_Row, THE Row_Registry SHALL select a single MapFiles component to render the Read_List, the Write_List, and the Rationale.
4. THE Row_Registry SHALL map exactly one component to the `map-files` Event_Row kind.

### Requirement 15: Inject Selected File Contents in READ_FILES with a Token Cap

**User Story:** As a developer, I want the files chosen by MAP_FILES to be read and added to the agent's working context, so that the agent has current file content without exceeding context limits.

#### Acceptance Criteria

1. WHEN the FSM enters the READ_FILES stage, THE Steering_Compiler SHALL read each path in the Read_List from the Workspace_Root.
2. THE Steering_Compiler SHALL inject each file read from the Read_List into the Run's context framed as `=== FILE: {path} ===` followed by the file content.
3. IF an injected file's content exceeds the Per_File_Token_Cap, THEN THE Steering_Compiler SHALL truncate the injected content to the Per_File_Token_Cap and SHALL append the Truncation_Marker.
4. IF a path in the Read_List cannot be read, THEN THE Steering_Compiler SHALL exclude that path from the injected context and SHALL continue reading the remaining paths in the Read_List.
5. WHEN the READ_FILES stage completes successfully, THE Steering_Compiler SHALL emit a `read-files` Event_Row listing the paths successfully read.
6. THE Steering_Compiler SHALL include the injected file content in the prompt context used for the Run's PLAN_EDITS stage.
7. IF emitting the `read-files` Event_Row fails, THEN THE Run_Pipeline SHALL continue the Run to the PLAN_EDITS stage.

### Requirement 16: Pre-Approve Declared Write Paths During APPLY_EDITS

**User Story:** As a developer, I want files the Run already declared it would create or modify to apply without an extra approval interruption, while unexpected file writes still require my confirmation, so that expected changes are not needlessly blocked.

#### Acceptance Criteria

1. THE EditCoordinator SHALL treat the Write_List carried by a Run's Map_Files_Event as the Run's Write_Allowlist.
2. WHEN APPLY_EDITS applies a planned change whose path is a member of the Write_Allowlist, THE EditCoordinator SHALL write the change.
3. IF APPLY_EDITS encounters a planned change whose path is not a member of the Write_Allowlist, THEN THE EditCoordinator SHALL halt before writing that change, SHALL retain changes already applied earlier in the same plan, and SHALL emit an Approval_Event naming the exact path of the change that triggered the halt.
4. WHILE a Run is halted for an unapproved write path, THE EditCoordinator SHALL wait for a Developer decision on the Approval_Event before applying any further planned change.
5. WHEN a Developer approves the pending Approval_Event, THE EditCoordinator SHALL write the named change and SHALL resume applying the remaining planned changes.
6. WHEN a Developer rejects the pending Approval_Event, THE EditCoordinator SHALL transition the Run to the PAUSED stage.

## Cross-Cutting Requirements

### Requirement 17: Event Contract Stability

**User Story:** As a maintainer, I want the two new event kinds added consistently across both language twins and the frontend registry, so that the Gateway and frontend cannot drift and existing runs keep working.

#### Acceptance Criteria

1. THE Event_Contract SHALL define both the `map-files` and `context-compressed` Event_Row kinds in the Python module `agent_events.py` and its TypeScript twin `agent-events.ts`, such that each kind has the same `type` discriminator and the same set of fields in both modules.
2. WHEN the `map-files` and `context-compressed` kinds are added to the Event_Contract, THE Event_Contract SHALL retain every existing Event_Row kind and its fields without modification or removal.
3. IF a payload does not conform to the Event_Contract, THEN THE Emit_Gate SHALL discard the payload, SHALL record a contract-violation entry naming the payload's `type`, and SHALL keep the SSE stream open.
4. THE Row_Registry SHALL map each Event_Row kind it renders to exactly one rendering component.
5. IF the Run_Feed receives an Event_Row whose `type` is not present in the Row_Registry, THEN THE Run_Feed SHALL discard that Event_Row without altering previously rendered rows.
