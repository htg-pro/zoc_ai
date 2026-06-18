# Requirements Document

## Introduction

This specification defines the merge of two codebases that both exist in this repository's history into a single, clean, well-structured desktop application:

1. **zoc-studio** (the existing Tauri desktop app on branch `main`, the current working tree). It contributes a rich React/TypeScript frontend (Monaco editor, file tree, terminal, and a "Zoc Agent" side panel) and a Python FastAPI agent backend at `services/agent/src/zoc_studio_agent/`. This app currently runs as a Tauri desktop app with the Python agent bundled as a sidecar.
2. **zocai-ecosystem-rebuild** (the new 5-layer agent architecture, authoritative spec at `.kiro/specs/zocai-ecosystem-rebuild/` on branch `zocai-ecosystem-rebuild`). It contributes the FastAPI streaming gateway (`services/gateway`, ASGI app `zocai_gateway.app:app`), the Mode_Router, the Model_Allocator, the 9-stage execution FSM, the Context Bus, the three-tier Memory Matrix under `.zocai/`, the single ordered SSE event stream with eight typed event rows, the Diary worker, the parametric evolution engine (`python/zocai_evolution`), and model hot-swap with state preservation.

The merge goal, derived from the user's green/red annotated screenshot of the Zoc Agent panel, is: **preserve the existing app's agent panel UI/UX shell (the "green" chrome) while replacing the agent run area and its entire background "brain" (the "red" engine) with the new ecosystem architecture.** The existing panel chrome — header, model selector, composer, mode toggle, priority pill, send button — stays visually identical. The conversation/run feed inside it and the backend that drives it are replaced by the new gateway, Mode_Router, Allocator, FSM, Context Bus, Memory Matrix, the eight typed SSE event rows, Diary, hot-swap, and evolution engine.

Because both codebases share many same-named files and folders (`services/`, `packages/shared-types`, `apps/`, event/SSE modules, agent run logic), this specification additionally treats the merge as a deduplication and cleanup effort: the result MUST be one non-duplicated codebase with exactly one live agent backend and event system, no dead code from the superseded paths, all naming collisions resolved, and no competing background processes.

References to acceptance criteria in the `zocai-ecosystem-rebuild` spec are written as "Rebuild-RX.Y" (for example, Rebuild-R6.3 for that spec's Requirement 6, criterion 3).

## Glossary

- **Merged_App**: The single Tauri desktop application produced by this merge.
- **Agent_Panel**: The existing "Zoc Agent" side panel React component tree rooted at `apps/frontend/src/features/agent/AgentPanel.tsx`.
- **Panel_Shell**: The preserved "green" UI chrome of the Agent_Panel — the header with title and model selector, and the bottom Composer with its message input, Ask/Agent mode toggle, priority/autonomy pill, and send button.
- **Run_Feed**: The "red" conversation/progress region of the Agent_Panel (currently `AgentTimeline`) where agent activity is displayed; replaced to render the new typed event rows.
- **Gateway**: The new FastAPI streaming gateway from zocai-ecosystem-rebuild, ASGI app `zocai_gateway.app:app`, located at `services/gateway`.
- **Legacy_Agent_Backend**: The existing Python FastAPI agent backend at `services/agent/src/zoc_studio_agent/`, which the merge supersedes.
- **Mode_Router**: The Gateway component that routes a request to Ask_Mode or Agent_Mode.
- **Ask_Mode**: The read-only conversational execution path.
- **Agent_Mode**: The execution-capable path that runs the FSM.
- **Model_Allocator**: The Gateway component that selects a Model_Tier and allocates a context window.
- **FSM**: The 9-stage finite state machine that governs Agent_Mode execution (INTAKE, ANALYZE, MAP_FILES, READ_FILES, PLAN_EDITS, APPLY_EDITS, RUN_CHECKS, SUMMARY, DONE).
- **Context_Bus**: The Gateway context-enrichment component (RAG, steering rules, MCP extensions).
- **Memory_Matrix**: The three-tier local memory store under the workspace `.zocai/` directory.
- **Diary_Worker**: The non-blocking background worker that appends events to the Session Diary.
- **Event_Contract**: The type-safe SSE event schema shared between backend and frontend, owned by `packages/shared-types`.
- **Event_Row**: One of the eight typed event kinds: intent, thinking, read-files, edit-file, command, summary, approval, done.
- **SSE_Stream**: The single ordered Server-Sent Events stream the Gateway exposes for a run.
- **ApprovalRow**: The Run_Feed row component that presents approve and reject actions for an approval event.
- **Composer**: The existing message-entry component at `apps/frontend/src/features/agent/Composer.tsx`.
- **Sidecar**: The Python agent process bundled with and launched by the Tauri desktop shell.
- **Evolution_Engine**: The parametric evolution engine at `python/zocai_evolution`.
- **Single_Source_Of_Truth**: A concern (event schema, agent backend, SSE client, agent run loop) implemented in exactly one location in the Merged_App.
- **Dead_Code**: Source, modules, routes, or assets in the Merged_App that are never referenced by any live execution path after the merge.
- **External_Llama_Reference**: Any reference to the third-party `llama.cpp` / `llamacpp` library, which is external and not part of product renaming.
- **Developer**: The human user operating the Merged_App.

## Requirements

### Requirement 1: Preserve the Agent Panel UI/UX Shell (Green)

**User Story:** As a Developer, I want the existing Zoc Agent panel to look and behave exactly as before, so that the visual experience I rely on is unchanged after the backend is swapped.

#### Acceptance Criteria

1. THE Merged_App SHALL render the Panel_Shell header containing the "Zoc Agent" title and the model selector with the same layout, styling, and component structure as the pre-merge Agent_Panel.
2. THE Merged_App SHALL render the Composer containing the message input, the Ask/Agent mode toggle, the autonomy/priority pill, and the send button with the same layout, styling, and component structure as the pre-merge Composer.
3. WHEN the Developer types text into the Composer message input, THE Composer SHALL display the entered text using the pre-merge input behavior.
4. WHEN the Developer toggles between Ask and Agent in the Composer mode toggle, THE Composer SHALL update the selected mode indicator using the pre-merge toggle behavior.
5. THE Merged_App SHALL preserve the Panel_Shell CSS classes, color tokens, and spacing values used by the pre-merge Agent_Panel and Composer.
6. WHERE a Panel_Shell control existed in the pre-merge Agent_Panel, THE Merged_App SHALL retain that control in the merged Agent_Panel.

### Requirement 2: Replace the Agent Run Backend with the Ecosystem Gateway (Red)

**User Story:** As a Developer, I want the agent's "brain" to be the new ecosystem gateway, so that runs are driven by the Mode_Router, Model_Allocator, FSM, and Context Bus instead of the legacy backend.

#### Acceptance Criteria

1. WHEN the Developer submits a run from the Composer, THE Merged_App SHALL route the request to the Gateway and SHALL NOT route the request to the Legacy_Agent_Backend.
2. WHEN a run request is received, THE Gateway SHALL dispatch the request through the Mode_Router as specified in Rebuild-R2.1 and Rebuild-R3.1.
3. WHEN an Agent_Mode run is dispatched, THE Gateway SHALL drive the run through the 9-stage FSM in the order INTAKE, ANALYZE, MAP_FILES, READ_FILES, PLAN_EDITS, APPLY_EDITS, RUN_CHECKS, SUMMARY, DONE, consistent with Rebuild-R3.2.
4. WHEN a run is dispatched, THE Gateway SHALL select a Model_Tier and allocate a context window through the Model_Allocator consistent with Rebuild-R1.2.
5. WHEN a run is dispatched, THE Gateway SHALL enrich the prompt through the Context_Bus consistent with Rebuild-R8.
6. THE Merged_App SHALL expose the Gateway run, decision, events, and diary endpoints at the paths defined by the zocai-ecosystem-rebuild spec (`/v1/agent/run`, `/decision`, `/v1/agent/events`, `/diary`).

### Requirement 3: Run Feed Consumes the Eight Typed SSE Event Rows

**User Story:** As a Developer, I want the panel's run feed to render the new typed event stream, so that I see structured progress (intent, thinking, files, edits, commands, summary, approval, done) inside the existing panel.

#### Acceptance Criteria

1. WHEN the Agent_Panel mounts, THE Run_Feed SHALL subscribe to the Gateway SSE_Stream.
2. WHEN the Run_Feed receives an Event_Contract payload, THE Run_Feed SHALL render the row component corresponding to the payload's event-type discriminator.
3. THE Run_Feed SHALL provide one distinct row component for each of the eight Event_Row kinds: intent, thinking, read-files, edit-file, command, summary, approval, and done, consistent with Rebuild-R7.4.
4. THE Run_Feed SHALL append received Event_Rows in the order the Gateway emits them, consistent with Rebuild-R6.5, without altering previously rendered rows.
5. IF the Run_Feed receives a payload with an unrecognized event type, THEN THE Run_Feed SHALL discard the payload and SHALL NOT alter the rendered feed, consistent with Rebuild-R7.7.
6. WHEN the SSE_Stream emits the done Event_Row, THE Run_Feed SHALL display the run as completed and SHALL continue monitoring the SSE_Stream for late events for that run.
7. THE Run_Feed SHALL render each Event_Row within the existing Agent_Panel run region without modifying the Panel_Shell.

### Requirement 4: Ask versus Agent Mode Through the Existing Composer

**User Story:** As a Developer, I want the existing Ask/Agent toggle to drive the new gateway's mode routing, so that read-only questions and execution runs behave correctly through the same control.

#### Acceptance Criteria

1. WHEN the Developer submits a request WHILE the Composer mode toggle is set to Ask, THE Merged_App SHALL send the request to the Gateway with the mode field set to Ask.
2. WHEN the Developer submits a request WHILE the Composer mode toggle is set to Agent, THE Merged_App SHALL send the request to the Gateway with the mode field set to Agent.
3. WHILE Ask_Mode is active, THE Run_Feed SHALL render the Gateway's markdown text token chunks as specified in Rebuild-R2.2 and Rebuild-R6.6.
4. WHILE Agent_Mode is active, THE Run_Feed SHALL render the Gateway's structured Event_Rows as specified in Rebuild-R6.7.
5. IF the Developer submits empty or whitespace-only input through the Composer, THEN THE Merged_App SHALL reject the submission and SHALL NOT send a request to the Gateway, consistent with Rebuild-R7.9.

### Requirement 5: Approval Flow in the Existing ApprovalRow and Composer

**User Story:** As a Developer, I want to approve or reject agent actions from within the existing panel, so that the new gateway's approval gates are resolved through familiar controls.

#### Acceptance Criteria

1. WHEN the SSE_Stream emits an approval Event_Row, THE ApprovalRow SHALL present an approve action and a reject action, consistent with Rebuild-R7.5.
2. WHEN the Developer selects the approve action on an ApprovalRow, THE Merged_App SHALL send an approval decision to the Gateway `/decision` endpoint and SHALL disable both actions on that ApprovalRow, consistent with Rebuild-R7.8.
3. WHEN the Developer selects the reject action on an ApprovalRow, THE Merged_App SHALL send a rejection decision to the Gateway `/decision` endpoint and SHALL disable both actions on that ApprovalRow, consistent with Rebuild-R7.8.
4. WHEN the Gateway pauses a run for an exceeded execution budget, THE Run_Feed SHALL present the budget-exceeded approval as an ApprovalRow requiring Developer confirmation to continue, consistent with Rebuild-R4.3 and Rebuild-R4.4.

### Requirement 6: Single Live Agent Backend and Event System

**User Story:** As a Developer, I want exactly one agent backend and one event system running, so that two competing implementations do not run at once.

#### Acceptance Criteria

1. THE Merged_App SHALL route all agent runs to the Gateway as the single live agent backend.
2. THE Merged_App SHALL define the Event_Contract in exactly one location within `packages/shared-types` as the Single_Source_Of_Truth for SSE event types.
3. THE Merged_App SHALL provide exactly one SSE client implementation for consuming the Gateway SSE_Stream in the frontend.
4. THE Merged_App SHALL provide exactly one agent run loop driving Agent_Mode execution.
5. IF a request reaches the Legacy_Agent_Backend after the merge, THEN the Merged_App SHALL treat that path as removed and SHALL NOT execute a legacy agent run.
6. WHEN the Merged_App starts, THE Merged_App SHALL launch exactly one agent backend process.

### Requirement 7: Deduplication and Naming Collision Resolution

**User Story:** As a Developer, I want every same-named file and folder collision resolved, so that the merged repository has no duplicate implementations of the same concept.

#### Acceptance Criteria

1. THE Merged_App SHALL contain exactly one implementation for each shared concern, including the event/SSE system, the agent run loop, and the shared type definitions.
2. WHERE the two source codebases both define a file or folder for the same concern, THE Merged_App SHALL retain a single resolved file or folder for that concern.
3. THE Merged_App SHALL contain no two modules that both implement the SSE event stream.
4. THE Merged_App SHALL contain no two modules that both implement the agent run loop.
5. WHEN a naming collision between the two codebases is resolved, THE Merged_App SHALL produce a build that completes with a zero exit code in which every import resolves to the retained implementation.
6. THE `packages/shared-types` package SHALL export a single set of agent event type definitions used by both the Gateway and the frontend.

### Requirement 8: Dead Code Removal

**User Story:** As a Developer, I want the superseded legacy paths removed, so that the merged codebase contains no orphaned or unreachable code.

#### Acceptance Criteria

1. THE Merged_App SHALL contain no module from the Legacy_Agent_Backend that is unreachable from any live execution path.
2. WHEN the Gateway is wired in as the live backend, THE Merged_App SHALL remove the superseded Legacy_Agent_Backend agent run and event modules.
3. THE Merged_App SHALL contain no frontend module that references a removed Legacy_Agent_Backend endpoint.
4. THE Merged_App SHALL retain the build configuration files required for the remaining and new components to build, consistent with Rebuild-R13.5.
5. WHEN dead code removal completes, THE Merged_App SHALL build with a zero exit code for each affected language (Python, Rust, TypeScript), consistent with Rebuild-R13.6.

### Requirement 9: No Crashing or Orphaned Background Processes

**User Story:** As a Developer, I want no leftover background tasks competing or crashing, so that the merged app runs stably without orphaned workers.

#### Acceptance Criteria

1. WHEN the Merged_App starts, THE Merged_App SHALL start the Diary_Worker as the single background diary process, consistent with Rebuild-R9.3.
2. THE Merged_App SHALL NOT start any Legacy_Agent_Backend background watcher, reconciliation, or run task after the merge.
3. IF a background task from a superseded implementation is present, THEN the Merged_App SHALL remove that task and SHALL fail to start until removal of that task is confirmed.
4. WHILE the Merged_App is running, THE Merged_App SHALL run no two background tasks that perform the same concern concurrently.
5. WHEN the Merged_App shuts down, THE Merged_App SHALL terminate every background task it started without leaving an orphaned process.

### Requirement 10: Desktop and Sidecar Packaging Continues to Work

**User Story:** As a Developer, I want the merged app to keep running as a Tauri desktop app with the Python agent as a bundled sidecar, so that the delivery model is unchanged.

#### Acceptance Criteria

1. THE Merged_App SHALL run as a Tauri desktop application.
2. WHEN the Merged_App desktop shell starts, THE Merged_App SHALL launch the Gateway as a bundled Sidecar process.
3. WHEN the Sidecar process becomes ready, THE Merged_App SHALL connect the frontend to the Sidecar over its loopback port before issuing run requests, waiting for the readiness signal even when the Sidecar is already ready at startup.
4. IF connecting the frontend to the Sidecar fails after the Sidecar becomes ready, THEN THE Merged_App SHALL treat the failure as a fatal startup error and SHALL surface the connection failure to the Developer.
5. IF the Sidecar process fails to become ready within the startup timeout, THEN THE Merged_App SHALL surface a startup error identifying the Sidecar readiness failure.
6. THE Merged_App build SHALL produce a desktop installer that bundles the Gateway Sidecar.

### Requirement 11: Product Naming Consistency

**User Story:** As a Developer, I want consistent product naming across the merged codebase, so that the app identity is uniform without breaking external library references.

#### Acceptance Criteria

1. THE Merged_App SHALL use the product naming forms `zoc-studio`, `zoc_studio`, `ZOC_STUDIO`, and `@zoc-studio` for product identifiers in package names, module names, and namespaces.
2. THE Merged_App SHALL leave every External_Llama_Reference to `llama.cpp` and `llamacpp` unchanged.
3. WHERE a product identifier is renamed, THE Merged_App SHALL update all internal references to that identifier so the build resolves with a zero exit code.

### Requirement 12: Gateway Endpoint Security Consideration

**User Story:** As a Developer, I want the unauthenticated gateway endpoints flagged and constrained, so that the control and telemetry surface is not exposed beyond localhost without a decision.

#### Acceptance Criteria

1. THE Merged_App SHALL bind the Gateway control and telemetry endpoints (`/v1/agent/run`, `/decision`, `/v1/agent/events`, `/diary`) to the loopback interface by default.
2. WHERE the Gateway endpoints are configured to bind to a non-loopback interface, THE Merged_App SHALL require an authentication credential on the control and telemetry endpoints, and IF a non-loopback binding is configured without an authentication credential, THEN THE Merged_App SHALL prevent startup and emit a configuration error identifying the missing credential.
3. IF a request to a Gateway control or telemetry endpoint on a non-loopback binding lacks a valid authentication credential, THEN THE Gateway SHALL reject the request with an authorization error and SHALL NOT execute the requested operation.
4. WHILE the Gateway is bound to the loopback interface, THE Gateway SHALL accept control and telemetry requests regardless of whether an authentication credential is present.
5. THE Merged_App SHALL document the absence of authentication on the loopback-bound Gateway endpoints as a known security constraint.
