# Implementation Plan: Agent Reasoning Engine (Part 1)

## Overview

This plan turns the `agent-reasoning-engine` design into incremental coding steps for the gateway package (`services/gateway/src/zocai_gateway/`). It follows the design's central framing:

- Capabilities **1.1 (thinking)**, **1.2 (structured plan)**, and **1.3 (self-verification)** are **already built**. For these we make only the two small refinements the design calls out and then **lock the behavior to the requirements with property-based and unit tests** — we do not reimplement them.
- Capability **1.4 (ReAct)** is **net-new**: extend the toolset, add a model-runtime tool-calling surface, build the `ReActExecutor`, and wire it into `APPLY_EDITS` behind a strategy seam that **defaults to `SINGLE_PASS`** so the change is additive and instantly reversible.

Ordering is test-driven and incremental: refine + cover the built code first (lowest risk), then build the net-new pieces bottom-up (toolset → model tool surface → ReAct executor → strategy seam → wiring), with tests placed next to the code they exercise and integration/regression wiring last so no code is left orphaned.

Conventions used throughout:
- Property tests use Hypothesis with `@settings(max_examples=200)` (`deadline=None` for filesystem-touching properties), one test per property, tagged with a comment `Feature: agent-reasoning-engine, Property N: <text>` and a `**Validates: Requirements X.Y**` line.
- No new Event_Contract kinds or fields are introduced; every emitted event must pass `EmitGate`.
- Sub-tasks marked `*` are test/coverage tasks and are optional for a faster MVP; core implementation sub-tasks are never optional.

## Tasks

- [x] 1. Refine the private thinking boundary and lock its behavior
  - [x] 1.1 Refine the `<think>` boundary in `RuntimeAgentBrain.think`
    - In `run_pipeline.py`, change `RuntimeAgentBrain.think` so it distinguishes "no complete `<think>...</think>` block" (raise → routed to `ERROR_CLOSED` by the `_run_agent` try/except) from "a complete but empty/whitespace block" (return `""` → proceed to ANALYZE with no `ThinkingEvent`, like the no-provider path)
    - Add a helper (e.g. `_has_think_block`) or adjust `_extract_thinking`/`_THINK_BLOCK_RE` usage so `think` no longer conflates an empty extraction with a missing block; keep the empty-response (no provider) path returning `""`
    - _Requirements: 1.3, 2.4_
  - [x]* 1.2 Write property test for scratchpad extraction
    - New test file exercising `_extract_thinking` over arbitrary text
    - **Property 1: Scratchpad extraction isolates the first think block**
    - **Validates: Requirements 1.3, 2.3**
  - [x]* 1.3 Write property test for fail-closed on malformed thinking
    - Drive `_run_agent`/`RuntimeAgentBrain.think` with non-empty responses lacking a complete block (including unclosed `<think>`); assert the run reaches `ERROR_CLOSED`
    - **Property 3: Malformed thinking fails closed**
    - **Validates: Requirements 2.4**
  - [x]* 1.4 Write property test for thinking privacy
    - Assert no event other than the `thinking` row carries the raw scratchpad, and the `summary` text never contains it
    - **Property 2: Raw thinking never leaks beyond the thinking row**
    - **Validates: Requirements 2.1, 2.2**
  - [x]* 1.5 Write property test for scratchpad injection into the planning prompt
    - Assert `_structured_plan_system_prompt`/`_agent_system_prompt` built for a run contain any non-empty scratchpad text
    - **Property 4: Scratchpad is injected into the planning prompt**
    - **Validates: Requirements 1.4**
  - [x]* 1.6 Write property test for thinking-event fidelity
    - Assert the emitted `thinking` event carries the scratchpad, has `collapsible=true`, non-negative `elapsedMs`, and precedes the ANALYZE stage event of the same run
    - **Property 5: Thinking event fidelity**
    - **Validates: Requirements 1.5, 1.6**
  - [x]* 1.7 Write unit tests for thinking bounds, isolation, and failure modes
    - Extend `tests/test_reasoning_engine.py`: 1024-token bound + thinking prompt; thinking issued as a separate call; no-provider yields no scratchpad/event yet still advances INTAKE→ANALYZE; `ModelRuntimeError` and the 60s timeout both reach `ERROR_CLOSED`
    - _Requirements: 1.1, 1.2, 1.7, 1.8, 2.5_

- [x] 2. Lock the structured-plan schema and validation
  - [x]* 2.1 Write property test for AgentPlan schema and path safety
    - New test file over candidate plans against `plan.AgentPlan`/`EditStep` validators (confidence range, ordered well-formed steps, relative/non-`..`/non-empty file paths)
    - **Property 6: AgentPlan schema and path safety enforcement**
    - **Validates: Requirements 3.4, 3.5, 3.6**
  - [x]* 2.2 Write unit tests for structured planning control flow
    - Extend `tests/test_reasoning_engine.py`: schema passed as `response_format` vs embedded in the prompt (`provider == "anthropic"`); exactly-one retry with the validation error appended; double-failure/empty-retry → `ERROR_CLOSED`; no-provider → `AgentPlan(steps=[], confidence=1.0)`
    - _Requirements: 3.1, 3.2, 3.3, 4.1, 4.2, 4.3_

- [x] 3. Confirm the plan-row mapping and lock its coverage
  - [x] 3.1 Make `edit-{index}` items the authoritative per-EditStep representation
    - In `run_pipeline.py` `_emit_plan`, keep the scaffold items but ensure each `EditStep` maps to exactly one `edit-{index}` `PlanItem` (1-based, unique, in plan order, `status="pending"`); add the blank-rationale branch so the label is `"{Action} {file}"` when the rationale is empty/whitespace and `"{Action} {file}: {Rationale}"` otherwise; add no fields to `PlanEvent`
    - Confirm the single-pass `edit-{index}` → `_emit_plan_update(..., "done")` path in `_plan_check_loop` fires only for successfully applied steps (ReAct-mode step satisfaction is handled in task 10.3)
    - _Requirements: 5.2, 5.3, 5.4, 5.5_
  - [x]* 3.2 Write property test for one-to-one plan-item mapping
    - **Property 7: Structured plan maps one-to-one onto plan items**
    - **Validates: Requirements 5.2, 5.4, 5.5**
  - [x]* 3.3 Write property test that the plan row precedes any edit
    - **Property 8: The plan row precedes any edit**
    - **Validates: Requirements 5.1**
  - [x]* 3.4 Write property test that plan-update done is emitted exactly for applied steps
    - **Property 9: Plan-update done is emitted exactly for applied steps**
    - **Validates: Requirements 5.6, 5.7**

- [x] 4. Lock verification parsing and reporting
  - [x]* 4.1 Write property test for verify-result totality and pass semantics
    - Over arbitrary command/output/exit-code into `verification.parse_verify_result`
    - **Property 10: Verify result totality and pass semantics**
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4**
  - [x]* 4.2 Write property test for the test-results event
    - Assert `run_pipeline._emit_test_results` mirrors the `ProjectTestResult` (status iff exit 0, command/source/counts/exitCode/outputTail/durationMs/timedOut)
    - **Property 11: Test-results event reflects the outcome**
    - **Validates: Requirements 6.5**
  - [x]* 4.3 Write unit test for test-results omission
    - New test: a workspace with no detected project test command emits no `test-results` event
    - _Requirements: 6.6_

- [x] 5. Lock the self-verification recovery loop
  - [x]* 5.1 Write property test for verification outcome routing
    - Over `remediation.RemediationLoop.on_checks_complete`: pass → SUMMARY; fail below ceiling → HANDLE_ERROR with recoveries +1
    - **Property 12: Verification outcome routes the run**
    - **Validates: Requirements 7.1, 7.2**
  - [x]* 5.2 Write property test for failure-capture fidelity
    - **Property 13: Failure capture fidelity**
    - **Validates: Requirements 7.3**
  - [x]* 5.3 Write property test for fix-context bounding
    - Assert `RuntimeAgentBrain.remediation_plan` includes at most the last 2000 chars of the verification output
    - **Property 14: Fix context bounds the verification output**
    - **Validates: Requirements 7.4**
  - [x]* 5.4 Write property test for accept-or-defer remediation
    - Use `diff_plans` + `plan_references_failure`; new file name (e.g. `test_remediation_accept_or_defer_property.py`) to avoid colliding with existing suites
    - **Property 15: Remediation is accepted only when it differs and references the failure, else defers**
    - **Validates: Requirements 7.5, 7.7**
  - [x]* 5.5 Write property test for the recovery-attempt event
    - **Property 16: Recovery-attempt event reports the attempt**
    - **Validates: Requirements 7.6**
  - [x]* 5.6 Write unit test for hot-swap at the recovery ceiling
    - New test: force `error_recoveries` to `ERROR_CEILING` with a still-failing check; assert `_preserve_and_swap` freezes, retains state, and drives `HotSwapCoordinator` to a higher tier
    - _Requirements: 7.8_

- [x] 6. Lock budget, emit-gate, and sequencing invariants
  - [x]* 6.1 Write property test that thinking tokens are excluded from the budget
    - Vary thinking-response size; assert `budget` event `tokensUsed` is unchanged
    - **Property 24: Thinking tokens are excluded from the context budget**
    - **Validates: Requirements 10.3**
  - [x]* 6.2 Write property test that budget events mirror counters and window
    - Over `run_pipeline._emit_budget`
    - **Property 25: Budget events mirror the live counters and window**
    - **Validates: Requirements 10.4**
  - [x]* 6.3 Write property test that the emit gate admits iff conforming
    - Over `emit_gate.EmitGate.emit`; new file name to avoid colliding with existing conformance suites
    - **Property 26: The emit gate admits an event if and only if it conforms**
    - **Validates: Requirements 10.5, 10.8**
  - [x]* 6.4 Write property test that sequence numbers strictly increase
    - Over `run_pipeline._emit` seq stamping across all producers of a run
    - **Property 27: Sequence numbers are strictly increasing**
    - **Validates: Requirements 10.6**

- [x] 7. Checkpoint - built-capability coverage green
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Extend the Agent_Toolset with confined delete and rename
  - [x] 8.1 Add `delete_file` and `move_file` to `FullToolset`
    - In `toolsets.py`, add `delete_file(rel_path)` and `move_file(src_rel, dst_rel)`; resolve every path (both ends of a move) through `_resolve_within_workspace` so an out-of-workspace target raises `ReadOnlyViolation` like the existing operations
    - _Requirements: 8.5, 9.5, 10.1_
  - [x]* 8.2 Write unit tests for confined delete/rename
    - New test: in-workspace delete/rename succeed; out-of-workspace source or destination raises `ReadOnlyViolation`; in-workspace operational failures (missing file, existing destination) raise the underlying error
    - _Requirements: 9.5, 9.6, 10.1_

- [x] 9. Add the model-runtime tool-calling surface
  - [x] 9.1 Add tool data models and the capability table
    - In `model_runtime.py`, add frozen dataclasses `ToolSpec`, `ToolCall`, `ModelToolResponse` (`text`, `tool_calls`, `finish_reason` in `stop|tool_calls|length|error`) and a `PROVIDER_NATIVE_TOOLS` mapping; export them in `__all__`
    - _Requirements: 8.2, 8.3_
  - [x] 9.2 Implement the OpenAI-compatible path of `generate_with_tools`
    - Add `generate_with_tools(request, *, system_prompt, tools, tool_history, timeout=120.0)`; for `edge`/`cloud`/`llamacpp` send `tools=[{"type":"function",...}]` + `tool_choice="auto"` and prior `assistant`/`tool` messages; parse `choices[0].message.tool_calls` and `finish_reason` into a normalized `ModelToolResponse`
    - _Requirements: 8.1, 8.3, 8.4, 8.8_
  - [x] 9.3 Implement the Anthropic path of `generate_with_tools`
    - Send `tools=[{name, description, input_schema}]`; read `content[].type == "tool_use"` blocks and map `stop_reason` (`tool_use`→`tool_calls`, `end_turn`→`stop`) into the same `ModelToolResponse`
    - _Requirements: 8.1, 8.3, 8.4, 8.8_
  - [x] 9.4 Implement the prompted-tool fallback and path selection
    - When a provider lacks native tools (per `PROVIDER_NATIVE_TOOLS`) or a native attempt raises `ModelRuntimeError`, inject a tool JSON protocol into the system prompt, parse a single tool-call JSON block from the text, and set `finish_reason=stop` on a text-only "done"; ensure the loop only ever receives a normalized `ModelToolResponse`
    - _Requirements: 8.1, 8.4, 8.8_
  - [x]* 9.5 Write unit tests for the tool surface and capability matrix
    - New test with faked HTTP (as in existing `model_runtime` tests): correct OpenAI `tools`/`tool_choice` and Anthropic `tools` payloads; parsing of `tool_calls`/`finish_reason`/`stop_reason`; fallback to the prompted protocol on a capability error
    - _Requirements: 8.1, 8.3, 8.4, 8.8_

- [x] 10. Build the ReAct executor
  - [x] 10.1 Create `react.py` foundations
    - New module `react.py` with the `ReAct_System_Prompt` constant (reason-before-call, use-previous-observation, text-only-when-done, plan-as-checklist) and dataclasses `ToolObservation`, `ToolHistory`, `ReActOutcome` (`applied_diffs`, `satisfied_step_ids`, `paused`, `step_budget_exhausted`, `stopped_reason`)
    - _Requirements: 8.6_
  - [x] 10.2 Implement the `ReActExecutor.run` loop control
    - Add `ReActExecutor` (fields: `toolset`, `orchestrator`, `plan`, `request`, `context`, `emit`, injectable `run_with_tools=generate_with_tools`, `MAX_STEPS=30`); iterate ≤30 steps building each request from `ReAct_System_Prompt` + `AgentPlan` checklist + accumulated `ToolHistory`; stop on `finish_reason=="stop"` (execute no tool calls), on a non-stop response with no tool calls, and at the 30th step without a further request
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.7, 8.8_
  - [x] 10.3 Implement dispatch, observability, budget gating, and step satisfaction
    - Add `_dispatch` routing **only** through `FullToolset` (`write_file`/`make_dir`/`delete_file`/`move_file`/`run_shell`/`read_file`), catching `ReadOnlyViolation` and other operation errors into the `ToolObservation` and continuing; emit `edit-file` for file-mutating calls (path + diff) and `command` for shell calls (no visible row for reads); gate each mutating call on `orchestrator.budget.before_file_op()` (pause→PAUSED + `ApprovalEvent` at the ceiling), then `count_file_op()` + emit `BudgetEvent`; track `(action, file)` satisfaction, emit `plan-update{edit-{index}, done}`, and stop when all steps are satisfied
    - _Requirements: 8.5, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 10.1, 10.2, 10.4, 10.7, 5.6_
  - [x]* 10.4 Write unit test for the ReAct system prompt content
    - Assert `ReAct_System_Prompt` instructs reason-before-call, use-previous-observation, text-only-when-done, and presents the plan as a checklist
    - _Requirements: 8.6_
  - [x]* 10.5 Write property test for the 30-step bound
    - Inject a scripted `run_with_tools`; assert model requests never exceed 30 and none is issued after the 30th step
    - **Property 17: ReAct never exceeds thirty steps**
    - **Validates: Requirements 8.1, 8.7**
  - [x]* 10.6 Write property test for tool-history ordering
    - **Property 18: Tool history accumulates in order**
    - **Validates: Requirements 8.2, 8.3**
  - [x]* 10.7 Write property test that a stop response executes no tools
    - **Property 19: A stop response executes no tools**
    - **Validates: Requirements 8.4**
  - [x]* 10.8 Write property test for loop termination
    - **Property 20: The loop terminates on satisfaction or on a non-tool response**
    - **Validates: Requirements 8.5, 8.8**
  - [x]* 10.9 Write property test that tool activity surfaces only as edit-file/command
    - **Property 21: ReAct tool activity surfaces only as edit-file and command events**
    - **Validates: Requirements 9.1, 9.2, 9.3, 9.4**
  - [x]* 10.10 Write property test for workspace confinement without aborting
    - Real `FullToolset` over a temp workspace; out-of-workspace targets are rejected as observations and the loop continues
    - **Property 22: Tool calls are confined to the workspace and never abort the run**
    - **Validates: Requirements 9.5, 9.6**
  - [x]* 10.11 Write property test for file-iteration counting and the ceiling
    - Real `FullToolset` + `orchestrator.Budget`; count +1 per successful mutation and PAUSED + `approval` before exceeding the File_Ceiling of 20
    - **Property 23: File iterations are counted and bounded by the ceiling**
    - **Validates: Requirements 10.1, 10.2, 10.7**

- [x] 11. Wire the APPLY_EDITS strategy seam and align regressions
  - [x] 11.1 Add the strategy seam types and the single-pass executor
    - In `run_pipeline.py`, add `ApplyStrategy` enum (`SINGLE_PASS`, `REACT`), an `ApplyExecutor` protocol, a uniform `ApplyResult` (applied diffs, satisfied step ids, `failed?`, `paused?`), and `SinglePassApplyExecutor` wrapping the current `brain.edit_plan` + `EditCoordinator.apply_edits` behavior
    - _Requirements: 8.1, 3.7, 3.8, 3.9_
  - [x] 11.2 Implement `ReActApplyExecutor`
    - In `run_pipeline.py`, add `ReActApplyExecutor` that constructs a `ReActExecutor` over the run's `FullToolset`/`Orchestrator`/`AgentPlan`/`_emit` and maps its `ReActOutcome` onto `ApplyResult`
    - _Requirements: 8.1, 8.2, 8.3, 9.1, 9.2, 10.1_
  - [x] 11.3 Wire the seam into the pipeline defaulting to SINGLE_PASS
    - Add `apply_strategy=ApplyStrategy.SINGLE_PASS` to `RunPipeline.__init__`; in `_plan_check_loop` select the executor (REACT only when a provider/model is configured, else single-pass/empty-plan skip), keep the empty-plan skip via `FSM.plan_complete(has_changes=False)`, and keep the post-apply handling (record diffs, `plan-update`, advance to RUN_CHECKS, PAUSED) unchanged below the seam
    - _Requirements: 8.1, 3.7, 3.8, 3.9_
  - [x]* 11.4 Write integration test for both strategies
    - New test: a scripted tool model writes files, runs a shell check, and finishes with `stop`, driving a full INTAKE→…→DONE run under `REACT` (asserting `edit-file`/`command`/`plan-update`/`budget` rows and final stage); a companion `SINGLE_PASS` run asserts unchanged legacy behavior (coexistence)
    - _Requirements: 8.1, 9.1, 9.2, 10.1, 10.4_
  - [x] 11.5 Preserve legacy behavior under the default strategy
    - Confirm and, if the seam refactor shifted any observable behavior, adjust `run_pipeline.py` so the default `SINGLE_PASS` path is behavior-preserving and the existing suites `test_reasoning_engine.py`, `test_edits.py`, `test_empty_plan_skip_property.py`, and `test_run_pipeline.py` stay green
    - _Requirements: 3.7, 3.8, 3.9_

- [x] 12. Final checkpoint - full reasoning engine green
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked `*` are optional test/coverage tasks and can be skipped for a faster MVP; the core implementation and wiring tasks (unmarked) must be implemented.
- Built capabilities 1.1-1.3 are refined (tasks 1.1, 3.1) and covered (Epics 1-6), never reimplemented; net-new ReAct 1.4 is implemented (Epics 8-11) and covered.
- The apply strategy defaults to `SINGLE_PASS`; the ReAct path is additive behind `ApplyStrategy.REACT` and rolls back instantly by leaving the default in place.
- Each of Properties 1-27 is one property-based test, tagged `Feature: agent-reasoning-engine, Property N: <text>` with a `**Validates: Requirements X.Y**` line; ReAct properties (17-23) inject a scripted `run_with_tools` and drive a real `FullToolset` over a temp workspace.
- No new event kinds or fields are added; every emitted event must pass `EmitGate.model_validate`. The `EventType` alias TS-twin drift noted in the design is out of scope here (tracked in the frontend/shared-types spec).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "4.1", "4.2", "4.3", "5.1", "5.2", "5.3", "5.4", "5.5", "5.6", "6.1", "6.2", "6.3", "6.4", "8.1", "9.1", "10.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4", "1.5", "1.6", "1.7", "3.1", "8.2", "9.2", "10.4"] },
    { "id": 2, "tasks": ["2.2", "3.2", "3.3", "3.4", "9.3", "11.1"] },
    { "id": 3, "tasks": ["9.4"] },
    { "id": 4, "tasks": ["9.5", "10.2"] },
    { "id": 5, "tasks": ["10.3"] },
    { "id": 6, "tasks": ["10.5", "10.6", "10.7", "10.8", "10.9", "10.10", "10.11", "11.2"] },
    { "id": 7, "tasks": ["11.3"] },
    { "id": 8, "tasks": ["11.4", "11.5"] }
  ]
}
```
