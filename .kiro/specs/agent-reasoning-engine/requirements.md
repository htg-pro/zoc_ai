# Requirements Document

## Introduction

This specification defines **Part 1 — Real Reasoning Engine** for the Zoc Studio agent: four related capabilities that make the agent reason before it acts, all operating inside the existing 9-stage Agent-Mode FSM driven by `RunPipeline._run_agent()` in `services/gateway/src/zocai_gateway/run_pipeline.py`. The four capabilities are:

- **1.1 Chain-of-Thought Scratchpad** — a private, bounded thinking step at INTAKE whose reasoning is extracted from `<think>...</think>`, surfaced as a collapsible thinking row, and injected as a scratchpad into the planning prompt.
- **1.2 Structured Plan Output** — a schema-validated `AgentPlan` (see `services/gateway/src/zocai_gateway/plan.py`) produced at PLAN_EDITS and surfaced as a step-by-step plan row before edits begin.
- **1.3 Self-Verification Loop** — parsing the RUN_CHECKS command output into a framework-aware result (see `services/gateway/src/zocai_gateway/verification.py`) and re-planning corrective edits on failure through the existing remediation loop (see `services/gateway/src/zocai_gateway/remediation.py`).
- **1.4 Multi-Step Reasoning (ReAct)** — replacing the single-shot APPLY_EDITS write with an iterative reason/act/observe loop that drives the agent toolset (see `services/gateway/src/zocai_gateway/toolsets.py`).

Investigation of the codebase found that capabilities 1.1, 1.2, and 1.3 are **already largely implemented** (`RuntimeAgentBrain.think`, `RuntimeAgentBrain.structured_plan`, `plan.py`, `verification.py`, `remediation.py`, `orchestrator.py`, and the thinking/plan/recovery event emission in `run_pipeline.py`), while **1.4 (the ReAct loop in APPLY_EDITS) is net-new** — `EditCoordinator.apply_edits` writes a pre-computed plan in a single deterministic pass today, and `model_runtime.generate_text` has no tool-calling surface. This document therefore states the intended, observable behavior of all four capabilities as one coherent feature, grounded in the real contracts already in the repository, so the already-built parts are captured as verifiable requirements and the net-new work is specified alongside them.

The following scope boundaries were established during requirements clarification and constrain every requirement below:

- **Grounding decision (minimal contract change).** The requirements are grounded in the contracts already present in the codebase rather than introducing new ones. The three points where the original feature description diverged from the code are resolved toward the existing contracts (see the three bullets below).
- **Fork 1 — recovery flow (1.3).** The self-verification recovery path uses the existing `RemediationLoop` + Execution_Budget behavior: auto-retry with a corrective `EditPlan` that differs from the prior plan and references the captured failure (one `RecoveryAttemptEvent` per attempt), defer to the Developer via an `approval` row when no differing correction can be produced, and freeze-and-hot-swap at the recovery ceiling. There is **no** `git reset --hard` "undo-all" / "continue-anyway" decision flow in scope.
- **Fork 2 — ReAct tool events (1.4).** ReAct tool activity is surfaced using the existing `edit-file` and `command` Event_Contract kinds. No new `tool-call` / `tool-result` event kinds are introduced.
- **Fork 3 — structured plan on the wire (1.2).** The structured `AgentPlan` is surfaced by mapping each `EditStep` onto the existing `PlanEvent` `items: PlanItem{id,label,status}` contract. The `PlanEvent` wire shape is **not** extended with structured step fields.
- **Event contract stability.** The reasoning engine emits only event kinds already defined in the shared Event_Contract (`packages/shared-types/python/shared_schema/agent_events.py` and its TypeScript twin). Every emitted event must pass the Emit_Gate's `AgentEventModel.model_validate` check and preserve camelCase wire aliases and the discriminated union.
- **Budget mechanism.** Recovery and file-iteration budgets are owned by the Orchestrator's Execution_Budget (`orchestrator.py`); there is no standalone `budget.py`/`BudgetLedger`. The recovery count is surfaced through the existing `BudgetEvent`.
- **Reused stage names.** The FSM stage names (INTAKE, ANALYZE, MAP_FILES, READ_FILES, PLAN_EDITS, APPLY_EDITS, RUN_CHECKS, SUMMARY, DONE, plus HANDLE_ERROR, PAUSED, ERROR_CLOSED) are reused exactly as defined in `stages.py`; the legal transition table is owned by `fsm.py`.
- **Out of scope.** MAP_FILES file selection and READ_FILES content injection are owned by the `map-files-context-stage` spec; LSP work is owned by `monaco-lsp-integration`. This spec covers only the four reasoning capabilities above.

## Glossary

### Components (SHALL subjects)

- **Reasoning_Engine**: The collective set of reasoning behaviors specified here, layered onto the Agent-Mode run path in `run_pipeline.py`.
- **Thinking_Layer**: The private chain-of-thought step (`RuntimeAgentBrain.think` plus its wiring in `RunPipeline._run_agent`) that runs before planning.
- **Model_Runtime**: The synchronous model adapter in `model_runtime.py` (`generate_text`) that sends a prompt to the Agent_Run's configured provider and returns generated text.
- **Structured_Planner**: The planning step (`RuntimeAgentBrain.structured_plan`) that produces a schema-validated Agent_Plan at PLAN_EDITS.
- **Verifier**: The framework-aware output parser in `verification.py` (`parse_verify_result`) that turns a check command result into a Verify_Result.
- **Remediation_Loop**: The RUN_CHECKS-outcome handler in `remediation.py` (`RemediationLoop`) that drives HANDLE_ERROR recovery.
- **Orchestrator**: The run-scoped budget owner in `orchestrator.py` that enforces the Execution_Budget and retains/resumes run state.
- **ReAct_Loop**: The net-new iterative reason/act/observe executor that drives APPLY_EDITS via the Agent_Toolset (replacing the single-shot apply).
- **Agent_Toolset**: The workspace-confined `FullToolset` in `toolsets.py` exposing `read_file`, `write_file`, `make_dir`, and `run_shell`.
- **Agent_FSM**: The 9-stage finite state machine in `fsm.py` that owns legal stage transitions.
- **Gateway**: The single ordered emit boundary in `RunPipeline` (`_emit`) that stamps and forwards every event.
- **Emit_Gate**: The SSE validation gate (`AgentEventModel.model_validate`) that admits only Event_Contract-conforming events.
- **Developer**: The human user operating the Agent_Run.

### Data and terms

- **Agent_Run**: A single execution of an Agent-Mode task driven by the Agent_FSM.
- **Stage**: A state of the Agent_FSM (INTAKE, ANALYZE, MAP_FILES, READ_FILES, PLAN_EDITS, APPLY_EDITS, RUN_CHECKS, SUMMARY, DONE, HANDLE_ERROR, PAUSED, ERROR_CLOSED).
- **Thinking_Request**: The separate, token-bounded Model_Runtime request the Thinking_Layer issues (bounded to 1024 completion tokens).
- **Thinking_System_Prompt**: The system prompt instructing the model to wrap all reasoning in `<think>...</think>` and output nothing after the closing tag.
- **Thinking_Response**: The raw text the Model_Runtime returns for a Thinking_Request.
- **Scratchpad**: The text extracted from the first `<think>...</think>` block of a Thinking_Response.
- **Thinking_Event**: The collapsible `thinking` Event_Contract row carrying the Scratchpad, its gist, and elapsed time.
- **Agent_Plan**: The `AgentPlan` model (`plan.py`): an ordered list of Edit_Steps, an optional Verification_Command, and a Confidence.
- **Edit_Step**: One `EditStep`: a workspace-relative file, an Action, a Rationale, and an optional list of Search_Replace pairs.
- **Action**: One of `create`, `modify`, `delete`, `rename`.
- **Rationale**: The one-sentence reason attached to an Edit_Step.
- **Search_Replace**: A `SearchReplace` pair of exact `search` and `replace` strings.
- **Verification_Command**: The optional command an Agent_Plan proposes for validating its edits.
- **Confidence**: A float between 0 and 1 inclusive carried by an Agent_Plan.
- **Plan_Event**: The `plan` Event_Contract row carrying `items: PlanItem`.
- **Plan_Item**: One live to-do item `{id, label, status}` inside a Plan_Event.
- **Plan_Update_Event**: The `plan-update` row that patches a Plan_Item's status.
- **Summary_Event**: The `summary` row carrying the human-facing run summary.
- **Verify_Result**: The `VerifyResult` value `{passed, failures, output}` produced by the Verifier.
- **Test_Results_Event**: The `test-results` row carrying the project test command outcome (status, command, source, passed, failed, exitCode, outputTail, durationMs, timedOut).
- **Failure_Record**: The captured failed command, exit code, and truncated log recorded on a recovery.
- **Edit_Plan**: The `EditPlan` (`edits.py`) of reasoning plus ordered `PlannedChange`s used by remediation comparison.
- **Recovery_Attempt_Event**: The `recovery-attempt` row carrying `{attempt >= 1, failures}`.
- **Approval_Event**: The `approval` row requesting a Developer decision.
- **Execution_Budget**: The Orchestrator's cumulative counters and ceilings (`Budget`).
- **Error_Recoveries**: The cumulative count of HANDLE_ERROR entries.
- **Error_Ceiling**: The fixed error-recovery ceiling of 3.
- **File_Ceiling**: The fixed file-iteration ceiling of 20.
- **Budget_Event**: The `budget` row carrying `{tokensUsed, tokenLimit, iterations, recoveries}`.
- **Context_Window**: The token window sized by the Model_Allocator for the Agent_Run; the Budget_Event `tokenLimit`.
- **Hot_Swap**: The freeze-and-upshift to a higher Model_Tier that preserves run state (`HotSwapCoordinator`).
- **Model_Tier**: The selected model tier (local-slm, edge, cloud).
- **ReAct_System_Prompt**: The system prompt instructing the model to think before each Tool_Call, use the previous Tool_Observation to choose the next action, respond with text only when done, and treat the Agent_Plan steps as a progress checklist.
- **Tool_Call**: A model-requested invocation of an Agent_Toolset operation during the ReAct_Loop.
- **Tool_Observation**: The recorded result of executing a Tool_Call.
- **Tool_History**: The accumulated conversation of Tool_Calls and Tool_Observations within one APPLY_EDITS run.
- **Edit_File_Event**: The `edit-file` row naming an applied change (path, diff, adds, dels, status).
- **Command_Event**: The `command` row naming a shell/verification command and its outcome.
- **Event_Contract**: The shared, type-safe SSE event schema (Python and TypeScript twins) defining every event kind an Agent_Run can emit.
- **Workspace_Root**: The confined root directory all Agent_Run file operations must resolve within.

## Requirements

### Requirement 1: Private Chain-of-Thought Thinking Before Planning

**User Story:** As a developer, I want the agent to reason privately about the task before it plans or acts, so that its plan benefits from an explicit thinking step instead of jumping straight to tool calls.

#### Acceptance Criteria

1. WHEN an Agent_Run enters the INTAKE stage, THE Thinking_Layer SHALL issue a Thinking_Request to the Model_Runtime that is bounded to 1024 completion tokens and carries the Thinking_System_Prompt.
2. THE Thinking_Layer SHALL issue the Thinking_Request as a request separate from the planning and execution requests.
3. WHEN the Model_Runtime returns a non-empty Thinking_Response, THE Thinking_Layer SHALL extract the text between the first `<think>` tag and the first `</think>` tag that follows it as the Scratchpad.
4. WHEN a Scratchpad is extracted, THE Gateway SHALL inject the Scratchpad into the PLAN_EDITS system prompt context.
5. WHEN a Scratchpad is extracted, THE Gateway SHALL emit a Thinking_Event carrying the Scratchpad text, a collapsible flag set to true, and the elapsed time in milliseconds measured from issuing the Thinking_Request to receiving the Thinking_Response.
6. THE Reasoning_Engine SHALL complete the Thinking_Layer step before the Agent_FSM transitions from INTAKE to ANALYZE.
7. IF no model provider is configured for the Agent_Run, THEN THE Thinking_Layer SHALL produce no Scratchpad and THE Gateway SHALL emit no Thinking_Event.
8. IF no model provider is configured for the Agent_Run, THEN THE Agent_FSM SHALL transition the Agent_Run from INTAKE to ANALYZE.

### Requirement 2: Keep Raw Thinking Private and Fail Closed on Malformed Thinking

**User Story:** As a developer, I want the raw private reasoning kept out of user-facing output and a malformed thinking response to stop the run safely, so that internal reasoning never leaks and a broken thinking step does not corrupt the run.

#### Acceptance Criteria

1. THE Gateway SHALL expose content derived from a Thinking_Response only as the Scratchpad carried by the Thinking_Event and as the internal PLAN_EDITS scratchpad context.
2. THE Gateway SHALL exclude the Scratchpad and the raw Thinking_Response from the Summary_Event.
3. THE Thinking_Layer SHALL discard any Thinking_Response text outside the first `<think>...</think>` block.
4. IF the Model_Runtime returns a non-empty Thinking_Response that contains no complete `<think>...</think>` block (including a response with an opening `<think>` but no matching closing `</think>`), THEN THE Agent_FSM SHALL transition the Agent_Run to the ERROR_CLOSED stage.
5. IF the Thinking_Request fails with a model-runtime error, or does not return within a 60-second timeout, THEN THE Agent_FSM SHALL transition the Agent_Run to the ERROR_CLOSED stage.

### Requirement 3: Structured Plan Output With Schema Enforcement

**User Story:** As a developer, I want the plan produced as a validated structured object instead of free-form prose, so that planning is machine-checkable and drives the rest of the run reliably.

#### Acceptance Criteria

1. WHEN an Agent_Run reaches the PLAN_EDITS stage, THE Structured_Planner SHALL request an Agent_Plan from the Model_Runtime against the AgentPlan JSON schema.
2. WHERE the configured provider supports a structured response format, THE Structured_Planner SHALL pass the AgentPlan JSON schema to the Model_Runtime as the response format.
3. WHERE the configured provider does not support a structured response format, THE Structured_Planner SHALL append the AgentPlan JSON schema to the system prompt and SHALL validate the returned response against the AgentPlan JSON schema.
4. THE Structured_Planner SHALL constrain the Agent_Plan to an ordered list of Edit_Steps, an optional Verification_Command, and a Confidence between 0 and 1 inclusive.
5. THE Structured_Planner SHALL constrain each Edit_Step to a workspace-relative file path, an Action of create, modify, delete, or rename, a Rationale, and an optional list of Search_Replace pairs.
6. IF an Edit_Step file path is empty or contains only whitespace, is absolute, or contains a parent-directory ("..") segment, THEN THE Structured_Planner SHALL reject the Agent_Plan as failing AgentPlan validation.

### Requirement 4: Validate the Structured Plan and Retry Once

**User Story:** As a developer, I want one automatic correction attempt when the model returns an invalid plan, so that a single malformed response does not needlessly fail the run while repeated failure still stops safely.

#### Acceptance Criteria

1. IF the Model_Runtime returns a non-empty response to the initial plan request that fails AgentPlan validation, THEN THE Structured_Planner SHALL re-issue the request exactly one time with the AgentPlan validation error appended to the prompt.
2. IF the re-issued response also fails AgentPlan validation or is empty, THEN THE Agent_FSM SHALL transition the Agent_Run to the ERROR_CLOSED stage.
3. WHEN the Model_Runtime returns an empty response to the initial plan request because no model provider is configured for the Agent_Run, THE Structured_Planner SHALL produce an Agent_Plan with no Edit_Steps and a Confidence of 1.

### Requirement 5: Surface the Structured Plan as a Plan Row

**User Story:** As a developer, I want to see a step-by-step plan card before edits begin, so that I understand what the agent intends to do and can watch each step complete.

#### Acceptance Criteria

1. WHEN an Agent_Plan is produced, THE Gateway SHALL emit one Plan_Event before the APPLY_EDITS stage applies any change.
2. THE Gateway SHALL represent each Edit_Step in the Agent_Plan as exactly one Plan_Item within the Plan_Event, list the Plan_Items in the same order as the Agent_Plan Edit_Steps, assign each Plan_Item an id that uniquely identifies the Edit_Step it represents within the Plan_Event, and set each Plan_Item initial status to pending.
3. THE Gateway SHALL emit the Plan_Event using the existing Plan_Event contract without adding fields to that contract.
4. THE Gateway SHALL set each Plan_Item label to include the Edit_Step Action, the Edit_Step file, and the Edit_Step Rationale.
5. IF an Edit_Step Rationale is empty or contains only whitespace, THEN THE Gateway SHALL set that Edit_Step's Plan_Item label to include the Edit_Step Action and the Edit_Step file only.
6. WHEN an Edit_Step is successfully applied during the APPLY_EDITS stage, THE Gateway SHALL emit a Plan_Update_Event carrying the id of the Plan_Item that represents that Edit_Step and a status of done.
7. IF an Edit_Step is not successfully applied during the APPLY_EDITS stage, THEN THE Gateway SHALL NOT emit a Plan_Update_Event that sets that Edit_Step's Plan_Item to a status of done.

### Requirement 6: Parse and Report Verification Results

**User Story:** As a developer, I want verification command output turned into a structured pass/fail result with named failures, so that the agent and I can see exactly what failed across common test runners.

#### Acceptance Criteria

1. WHEN the RUN_CHECKS stage completes a verification command, THE Verifier SHALL parse the command, its output, and its exit code into a Verify_Result carrying a passed flag, a failures list, and the output.
2. WHEN the verification exit code is zero, THE Verifier SHALL set the Verify_Result passed flag to true and the failures list to empty.
3. IF the verification exit code is non-zero, THEN THE Verifier SHALL set the Verify_Result passed flag to false and SHALL populate the failures list with up to 50 distinct failure lines detected from pytest, jest, cargo test, and go test output.
4. IF the verification exit code is non-zero AND no framework failure line is detected, THEN THE Verifier SHALL record one generic failure naming the command and its exit code.
5. WHEN a project test command has been detected and run as the verification for an Agent_Run's edits, THE Gateway SHALL emit a Test_Results_Event carrying a status of pass when the Verify_Result passed flag is true and fail otherwise, the command, the source, the passed count, the failed count, the exit code, the output tail, the duration in milliseconds, and the timed-out flag.
6. IF no project test command is detected for the Agent_Run, THEN THE Gateway SHALL omit the Test_Results_Event.

### Requirement 7: Self-Verification Recovery Loop

**User Story:** As a developer, I want the agent to re-plan corrective edits when verification fails instead of giving up, so that recoverable failures are fixed automatically within a bounded budget.

#### Acceptance Criteria

1. WHEN a Verify_Result reports passed, THE Remediation_Loop SHALL transition the Agent_Run from RUN_CHECKS to SUMMARY.
2. IF a Verify_Result reports not passed AND the Error_Recoveries count is below the Error_Ceiling, THEN THE Remediation_Loop SHALL transition the Agent_Run from RUN_CHECKS to HANDLE_ERROR and SHALL increment the Error_Recoveries count by one.
3. WHEN the Remediation_Loop enters HANDLE_ERROR, THE Remediation_Loop SHALL capture the failed command, its exit code, and its output into a Failure_Record.
4. WHEN the Remediation_Loop requests a correction, THE Remediation_Loop SHALL build the fix context from the original task, the applied plan steps, and the verification output truncated to 2000 characters.
5. IF a corrective Edit_Plan differs from the prior Edit_Plan by at least one edit operation AND references the captured Failure_Record, THEN THE Remediation_Loop SHALL transition the Agent_Run from HANDLE_ERROR to PLAN_EDITS and SHALL re-run verification.
6. WHEN the Remediation_Loop transitions the Agent_Run into HANDLE_ERROR, THE Gateway SHALL emit a Recovery_Attempt_Event carrying an attempt number equal to the current Error_Recoveries count and the Verify_Result failures list.
7. IF the correction request does not yield a corrective Edit_Plan that both differs from the prior Edit_Plan by at least one edit operation and references the captured Failure_Record, THEN THE Agent_FSM SHALL transition the Agent_Run to the PAUSED stage and THE Gateway SHALL emit an Approval_Event deferring the decision to the Developer.
8. IF a Verify_Result reports not passed AND the Error_Recoveries count equals the Error_Ceiling, THEN THE Orchestrator SHALL freeze the Agent_Run, retain its run state, and initiate a Hot_Swap to a higher Model_Tier.

### Requirement 8: Multi-Step ReAct Execution in APPLY_EDITS

**User Story:** As a developer, I want complex tasks executed as an iterative reason/act/observe loop rather than a single edit pass, so that the agent can use each observation to decide its next action until the work is done.

#### Acceptance Criteria

1. WHEN an Agent_Run enters the APPLY_EDITS stage, THE ReAct_Loop SHALL iterate for at most 30 steps, where each step comprises exactly one Model_Runtime request and the execution of the Tool_Calls that request returns.
2. WHILE the ReAct_Loop is iterating, THE ReAct_Loop SHALL build each request from the ReAct_System_Prompt, the Agent_Plan, and the accumulated Tool_History, and SHALL call the Model_Runtime with the Agent_Toolset available.
3. WHEN the Model_Runtime returns a response whose finish reason is not stop and that contains one or more Tool_Calls, THE ReAct_Loop SHALL execute each Tool_Call through the Agent_Toolset in the order the Model_Runtime returned them and SHALL append the resulting Tool_Observation of each Tool_Call to the Tool_History.
4. WHEN the Model_Runtime returns a response whose finish reason is stop, THE ReAct_Loop SHALL stop iterating without executing any Tool_Call contained in that response.
5. WHEN every Edit_Step in the Agent_Plan is satisfied, meaning the ReAct_Loop has executed a successful Tool_Call that applies that Edit_Step's Action to that Edit_Step's file, THE ReAct_Loop SHALL stop iterating and SHALL ignore any remaining content in the current response.
6. THE ReAct_System_Prompt SHALL instruct the model to reason before each Tool_Call, to use the previous Tool_Observation to choose the next action, to respond with text only when finished, and SHALL present the Agent_Plan steps as a progress checklist.
7. IF the ReAct_Loop reaches its 30th step without every Edit_Step being satisfied and without the Model_Runtime having returned a stop finish reason, THEN THE ReAct_Loop SHALL stop iterating without issuing a further Model_Runtime request.
8. IF the Model_Runtime returns a response whose finish reason is not stop and that contains no Tool_Call, THEN THE ReAct_Loop SHALL stop iterating.

### Requirement 9: ReAct Observability and Workspace Confinement

**User Story:** As a developer, I want each ReAct tool action shown as a trace row and confined to my workspace, so that I can follow what the agent did and trust it cannot touch files outside the project.

#### Acceptance Criteria

1. WHEN the ReAct_Loop executes a file-writing Tool_Call, THE Gateway SHALL emit an Edit_File_Event naming the path and diff of the change.
2. WHEN the ReAct_Loop executes a shell or verification Tool_Call, THE Gateway SHALL emit a Command_Event naming the executed command and reporting whether the command succeeded or failed together with the output it produced.
3. THE Reasoning_Engine SHALL surface ReAct tool activity only as Edit_File_Event and Command_Event kinds already defined in the Event_Contract.
4. THE ReAct_Loop SHALL execute every Tool_Call exclusively through the Agent_Toolset.
5. IF the Agent_Toolset resolves a Tool_Call target to a path outside the Workspace_Root, THEN THE Agent_Toolset SHALL reject the operation without performing any read, write, or command execution on that target, SHALL surface the rejection as the Tool_Observation, and SHALL allow the ReAct_Loop to continue without aborting the run.
6. IF the Agent_Toolset resolves a Tool_Call target within the Workspace_Root but the operation fails for a reason unrelated to the Workspace_Root boundary, THEN THE Agent_Toolset SHALL surface the underlying error as the Tool_Observation and SHALL allow the ReAct_Loop to continue without aborting the run.

### Requirement 10: Budget, Context-Budget, and Event-Contract Compliance

**User Story:** As a developer, I want thinking, recovery, and ReAct execution to respect the run's existing budgets and event contract, so that the reasoning engine cannot run away, exceed context limits, or break the shared frontend contract.

#### Acceptance Criteria

1. WHEN the ReAct_Loop successfully applies a file-mutating Tool_Call that creates, modifies, deletes, or renames a workspace file, THE Orchestrator SHALL increment the Execution_Budget file-iteration count by one.
2. IF the file-iteration count has reached the File_Ceiling of 20, THEN THE Orchestrator SHALL transition the Agent_Run to the PAUSED stage before applying the next file-mutating Tool_Call.
3. THE Reasoning_Engine SHALL exclude the Thinking_Request tokens from the Agent_Run's context-budget usage.
4. WHEN the Execution_Budget's token usage, file-iteration count, or Error_Recoveries count changes, THE Gateway SHALL emit a Budget_Event carrying the tokens used, a token limit equal to the allocated Context_Window, the file-iteration count, and the Error_Recoveries count.
5. THE Emit_Gate SHALL validate every emitted event against the Event_Contract discriminated union before the event reaches the SSE bus.
6. THE Gateway SHALL stamp every emitted event with a monotonically increasing sequence number on a single ordered stream, each sequence number strictly greater than the previously emitted event's sequence number.
7. WHEN the Orchestrator transitions the Agent_Run to the PAUSED stage at the File_Ceiling, THE Gateway SHALL emit an Approval_Event requiring Developer confirmation.
8. IF an event fails validation against the Event_Contract discriminated union, THEN THE Emit_Gate SHALL block that event from reaching the SSE bus.
