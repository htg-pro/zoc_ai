# Requirements Document

## Introduction

This specification wires the existing, unwired MAP_FILES stage logic in `services/gateway/src/zocai_gateway/context/steering_compiler.py` (`MAP_FILES_INSTRUCTION`, `MapFilesEvent`, `select_map_files`, `build_read_files_payload`, `preapproved_writes`, `is_write_preapproved`) into the live 9-stage Agent-Mode FSM driven by `RunPipeline._run_agent()` in `run_pipeline.py`. Today the FSM advances through MAP_FILES and READ_FILES as bare, unobserved `fsm.advance()` calls, and the Run's model context comes only from `RagMatcher.extract()`; none of the MAP_FILES functions are called and none of their output reaches READ_FILES or APPLY_EDITS.

This feature makes MAP_FILES select a minimum set of files to read and declare files it will create or modify, surfaces that selection to the developer, feeds the selected files' content into READ_FILES with a per-file size cap, and lets APPLY_EDITS skip an approval interruption for paths already declared in the write plan.

The following scope boundaries were established during requirements clarification and constrain every requirement below:

- **Candidate source.** MAP_FILES selects from the Run's existing `RunContext` fragments (the RAG_Matcher's output already flowing through every Agent run), not from `hybrid_search()`. `hybrid_search()` requires a prebuilt BM25 index, embeddings, and a query embedder that nothing in `run_pipeline.py` constructs today; wiring that infrastructure is out of scope for this feature.
- **Event contract.** The "files this run will touch" card is a new, distinct `map-files` Event_Row and row component, added alongside (not merged into) the existing `read-files` Event_Row, which continues to represent the files READ_FILES actually reads.
- **Model call path.** MAP_FILES calls the Run's configured model provider through the same `model_runtime.generate_text` path already used by `think`, `structured_plan`, and `edit_plan`, not through the `ModelInterface` tier stubs (which always return empty text today).
- **Write pre-approval.** No per-write approval gate exists in `EditCoordinator.apply_edits` today; it writes every planned change unconditionally. This feature adds that gate. A planned change outside the declared write list halts the plan, retains already-applied changes, and blocks the run on a developer decision before continuing — mirroring the existing review-decision wait pattern used for review-before-apply runs.
- **Error handling.** A model-runtime failure, an unparseable selection response, or the File_Selector producing no response at all (including when no model provider is configured for the Run) fails the run closed (no retry), matching the existing `think`/`edit_plan` failure handling rather than the retry-once behavior used by `structured_plan`. This is a deliberate departure from `think`/`structured_plan`/`edit_plan`, which fall back to empty defaults when no provider is configured; MAP_FILES treats an unconfigured provider as fatal instead.

## Glossary

- **Run**: A single execution of an Agent-Mode task driven by the FSM.
- **FSM**: The 9-stage finite state machine governing a Run (INTAKE, ANALYZE, MAP_FILES, READ_FILES, PLAN_EDITS, APPLY_EDITS, RUN_CHECKS, SUMMARY, DONE), plus the off-happy-path HANDLE_ERROR, PAUSED, and ERROR_CLOSED stages.
- **Steering_Compiler**: The component in `context/steering_compiler.py` that compiles steering context and performs MAP_FILES file selection and READ_FILES content injection.
- **File_Selector**: The injectable callable that sends the MAP_FILES prompt to the Model_Runtime and returns its raw text response.
- **Model_Runtime**: The component that sends a prompt to the Run's configured model provider and returns generated text, raising a model-runtime error when the provider call fails.
- **RAG_Matcher**: The existing component that extracts code fragments relevant to the Run's task description.
- **Candidate_Fragment**: One fragment the RAG_Matcher extracted for the Run, presented to the File_Selector as a candidate file.
- **Read_List**: The validated, workspace-relative list of file paths a Run will read, capped at 8 entries.
- **Write_List**: The validated, workspace-relative list of file paths a Run declares it will create or modify.
- **Rationale**: The File_Selector's explanation for the selected Read_List and Write_List.
- **Map_Files_Event**: The Event_Row emitted after MAP_FILES completes, carrying the Read_List, the Write_List, and the Rationale.
- **Write_Allowlist**: The set of Write_List paths from a Run's Map_Files_Event that APPLY_EDITS may write without a developer decision.
- **Per_File_Token_Cap**: The fixed 2000-token limit applied to injected file content per file in READ_FILES.
- **Truncation_Marker**: The literal text `... [truncated]` appended to file content cut off at the Per_File_Token_Cap.
- **Approval_Event**: The Event_Row requesting a developer decision before APPLY_EDITS writes a planned change outside the Write_Allowlist.
- **Workspace_Root**: The confined root directory all Run file operations must resolve within.
- **Event_Contract**: The shared, type-safe SSE event schema (Python and TypeScript twins) defining every Event_Row kind a Run can emit.
- **Row_Registry**: The frontend mapping (`ROW_COMPONENTS`) from an Event_Row's type discriminator to exactly one rendering component.
- **Run_Feed**: The frontend component tree that renders a Run's received Event_Rows in emission order.
- **EditCoordinator**: The component in `edits.py` that applies planned changes during APPLY_EDITS.
- **Developer**: The human user operating the Run.

## Requirements

### Requirement 1: Select Minimum Files to Read and Declare Files to Write

**User Story:** As a developer running an Agent-Mode task, I want the system to select the minimum set of files it needs to read and to declare which files it will create or modify, so that the run focuses its context on relevant files while I can see its intended scope.

#### Acceptance Criteria

1. WHEN the FSM enters the MAP_FILES stage, THE Steering_Compiler SHALL send the Run's task description and Candidate_Fragments to the File_Selector using the MAP_FILES_INSTRUCTION prompt.
2. THE Steering_Compiler SHALL source Candidate_Fragments for the File_Selector from the RAG_Matcher's fragments for the Run.
3. WHEN the File_Selector returns a response, THE Steering_Compiler SHALL parse a Read_List, a Write_List, and a Rationale from the response's "read", "write", and "rationale" fields.
4. IF a parsed Read_List or Write_List path resolves outside the Workspace_Root, THEN THE Steering_Compiler SHALL exclude that path from the Read_List or Write_List.
5. THE Steering_Compiler SHALL limit the validated Read_List to at most 8 paths.
6. IF the File_Selector produces no response for the Run, THEN THE FSM SHALL transition the Run to the ERROR_CLOSED stage.

### Requirement 2: Handle File-Selection Failures Safely

**User Story:** As a developer, I want file selection to fail safely when the model call fails or returns output the system cannot use, so that a bad model response does not silently corrupt the run or continue with incorrect files.

#### Acceptance Criteria

1. IF the File_Selector call raises a model-runtime error, THEN THE FSM SHALL transition the Run to the ERROR_CLOSED stage.
2. IF the File_Selector response cannot be parsed as a JSON object, THEN THE FSM SHALL transition the Run to the ERROR_CLOSED stage.
3. WHERE the parsed response contains an empty "read" list and an empty "write" list, THE Steering_Compiler SHALL proceed with an empty Read_List and an empty Write_List.
4. IF no model provider is configured for the Run, THEN THE FSM SHALL transition the Run to the ERROR_CLOSED stage.

### Requirement 3: Surface the File Selection to the Developer

**User Story:** As a developer, I want to see which files a run selected to read and write before it proceeds, so that I understand the run's intended scope.

#### Acceptance Criteria

1. WHEN file selection completes for a Run, THE Steering_Compiler SHALL emit a Map_Files_Event carrying the Read_List, the Write_List, and the Rationale.
2. THE Event_Contract SHALL define a "map-files" Event_Row kind carried by the Map_Files_Event.
3. WHEN the Run_Feed receives a "map-files" Event_Row, THE Row_Registry SHALL select a MapFilesRow component to render the Read_List, the Write_List, and the Rationale.
4. THE Row_Registry SHALL map exactly one component to the "map-files" Event_Row kind.

### Requirement 4: Inject Selected File Contents in READ_FILES with a Token Cap

**User Story:** As a developer, I want the files chosen by MAP_FILES to be read and added to the agent's working context, so that the agent has current file content without exceeding context limits.

#### Acceptance Criteria

1. WHEN the FSM enters the READ_FILES stage, THE Steering_Compiler SHALL read each path in the Read_List from the Workspace_Root.
2. THE Steering_Compiler SHALL inject each file read from the Read_List into the Run's context framed as "=== FILE: {path} ===\n{content}\n".
3. IF an injected file's content exceeds the Per_File_Token_Cap, THEN THE Steering_Compiler SHALL truncate the injected content to the Per_File_Token_Cap and SHALL append the Truncation_Marker.
4. IF a path in the Read_List cannot be read, THEN THE Steering_Compiler SHALL exclude that path from the injected context and SHALL continue reading the remaining paths in the Read_List.
5. WHEN the READ_FILES stage completes, THE Steering_Compiler SHALL emit a read-files Event_Row listing the paths successfully read.
6. THE Steering_Compiler SHALL include the injected file content in the prompt context used for the Run's PLAN_EDITS stage.

### Requirement 5: Pre-Approve Declared Write Paths During APPLY_EDITS

**User Story:** As a developer, I want files the run already declared it would create or modify to apply without an extra approval interruption, while unexpected file writes still require my confirmation, so that expected changes are not needlessly blocked.

#### Acceptance Criteria

1. THE EditCoordinator SHALL treat the Write_List carried by a Run's Map_Files_Event as the Run's Write_Allowlist.
2. WHEN APPLY_EDITS applies a planned change whose path is a member of the Write_Allowlist, THE EditCoordinator SHALL write the change.
3. IF APPLY_EDITS encounters a planned change whose path is not a member of the Write_Allowlist, THEN THE EditCoordinator SHALL halt before writing that change, SHALL retain changes already applied earlier in the same plan, and SHALL emit an Approval_Event naming the unapproved path.
4. WHILE a Run is halted for an unapproved write path, THE EditCoordinator SHALL wait for a developer decision on the Approval_Event before applying any further planned change.
5. WHEN a developer approves the pending Approval_Event, THE EditCoordinator SHALL write the named change and SHALL resume applying the remaining planned changes.
6. WHEN a developer rejects the pending Approval_Event, THE EditCoordinator SHALL transition the Run to the PAUSED stage.
