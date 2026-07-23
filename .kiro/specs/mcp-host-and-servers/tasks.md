# Implementation Plan: MCP Host and Servers (Part 4)

## Overview

This plan turns the design into incremental, test-first coding steps for the generic **MCP_Host** in the FastAPI gateway (`services/gateway/src/zocai_gateway/context/mcp_host/`), the admitted `/v1/mcp/*` control surface, the additive frontend surfaces, and the three bundled stdio servers (`services/mcp_servers/`). The whole feature is additive: the fixed `mcp::web::search` / `mcp::github` surface owned by `MCPGateway` is never modified.

Build order is bottom-up so each step compiles against completed work with no orphaned code:
leaf modules (stdio framing, config port, namespacing/registry) → `ServerSession` over the injected spawn seam → `MCPHost` lifecycle/aggregation/proxy/crash-isolation → Trust_Gate over the existing approval channel → admitted routes + isolated test endpoint → additive `FullToolset` wiring → the shared-type `mcpServerId` contract change (regeneration + drift) → frontend `CommandRow` badge + Settings management → the three bundled servers + `Default_Config` registration.

Languages and libraries follow the design exactly: Python for the gateway/servers with **Hypothesis** for property tests; TypeScript/React for the frontend with **fast-check**; `httpx` for bundled-server network; `pnpm schema:generate` for the TS twin. Subprocess, network, git, and clock are exercised only through injected seams with in-process fakes — no property test performs real subprocess, network, or git I/O.

Property-based test conventions used throughout:
- Exactly one property-based test per correctness property (Properties 1–35).
- Each is tagged with a comment: `Feature: mcp-host-and-servers, Property {number}: {property_text}`.
- Each runs a minimum of 100 iterations (Hypothesis `max_examples>=100`; fast-check `{ numRuns: 200 }`).
- Test-related sub-tasks are marked optional with `*` and MUST NOT be implemented when executing non-optional tasks.

## Tasks

- [ ] 1. Set up MCP host package structure and core interfaces
  - [ ] 1.1 Create the package scaffold and core data models
    - Create `services/gateway/src/zocai_gateway/context/mcp_host/__init__.py`.
    - Create `context/mcp_host/models.py` with the design's data types: `ServerDefinition` (frozen dataclass: `id`, `transport`, `command`, `args`, `env`, `url`, `auto_approve`, `disabled`, `scope`), `McpToolRecord` (`server_id`, `bare_name`, `namespaced_name`, `input_schema`, `description`), `ServerStatus` = `Literal["running","stopped","error"]`, `ServerRuntimeState` (`definition`, `status`, `error_reason`, `session`), `ToolCallErrorKind` enum (`UNAVAILABLE`/`TIMEOUT`/`FAILURE`/`DECLINED`), `ToolCallSuccess`, `ToolCallError`, `ToolCallOutcome` union, and `TestSuccess`/`TestValidationFailure`/`TestFailure`/`TestUnsupported`/`TestOutcome` union.
    - No behavior yet; these are the shared interfaces every later module imports.
    - _Requirements: 4.3, 6.3, 6.5, 6.7, 11.2, 11.4, 11.6, 11.7, 13.18_

- [ ] 2. Implement stdio JSON-RPC framing (leaf, dependency-free)
  - [ ] 2.1 Implement `context/mcp_host/framing.py`
    - Reuse the `AsyncByteReader` seam shape from `routes/lsp.py`.
    - `encode_message(message)`: exactly one compact `json.dumps` serialization + one `"\n"`, with no embedded raw newline.
    - `decode_line(line)`: strip the single trailing newline, `json.loads` the remainder, return the message only when it decodes to exactly one JSON object; malformed or non-object (array/scalar) returns `None`.
    - `read_message(reader)`: read one line; `b""` → `EOF` sentinel; a line rejected by `decode_line` → skip and keep reading.
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5_

  - [ ]* 2.2 Write property test for framing round-trip
    - **Property 34: stdio framing round-trip equality**
    - Tag: `Feature: mcp-host-and-servers, Property 34: stdio framing round-trip equality`
    - Hypothesis strategy generating valid JSON-RPC objects; assert `decode_line(encode_message(m))` equals `m` under JSON value equality, that the encoding is one serialization + one newline with no embedded newline, and that a framed line decodes to exactly one message. Minimum 100 iterations.
    - **Validates: Requirements 18.1, 18.2, 18.3**

  - [ ]* 2.3 Write property test for malformed-line discard
    - **Property 35: Malformed-line discard keeps the session open**
    - Tag: `Feature: mcp-host-and-servers, Property 35: Malformed-line discard keeps the session open`
    - Drive `read_message` with an in-process fake `AsyncByteReader` yielding interleaved malformed lines (non-JSON, non-object, or not exactly one message) and valid framed lines; assert every malformed line is discarded without closing/raising and every valid message is still decoded, EOF only at true stream end. Minimum 100 iterations.
    - **Validates: Requirements 18.4**

  - [ ]* 2.4 Write unit tests for framing edge cases
    - `decode_line` returns `None` for empty/whitespace/array/scalar; `read_message` returns the `EOF` sentinel on `b""`.
    - _Requirements: 18.4, 18.5_

- [ ] 3. Implement the Python config port and Default_Config
  - [ ] 3.1 Implement `context/mcp_host/mcp_config.py`
    - Faithful Python port of `apps/frontend/src/lib/mcp-config.ts`: a `strip_json_comments` twin of the frontend's `stripJsonComments`, `detect_transport` (explicit `transport`/`type` wins, else `command`→stdio, `url`→sse), `normalize_server` (stdio requires non-empty `command`; sse/http require non-empty `url`; else invalid → `None`), `parse_config` (empty/invalid-JSONC/missing or non-object `mcpServers`/empty map → `[]`), `merge(user, workspace)` (workspace replaces the whole user definition by `id`, disabled retained), and `build_mcp_config(default, user_text, workspace_text)` (precedence `Workspace > User > Default`; validity filter drops only invalid entries).
    - `eligible_to_start(cfg)`: enabled stdio only (disabled excluded; sse/http excluded from live start).
    - `DEFAULT_CONFIG`: three enabled stdio `ServerDefinition`s with argv `[<python>, "-m", "mcp_servers.<name>"]`, `scope="workspace"`, and per-server `auto_approve` = that server's tool names (`web_search`; `fetch_docs`,`search_npm`,`search_pypi`; `git_log`,`git_blame`,`git_show`); no filesystem MCP server. Argv is data only — no import of the server modules here.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 17.1, 17.2, 17.3, 17.4, 17.7, 17.8_

  - [ ]* 3.2 Write property test for merge precedence and scope
    - **Property 1: Config merge precedence and scope**
    - Tag: `Feature: mcp-host-and-servers, Property 1: Config merge precedence and scope`
    - Hypothesis strategies for user/workspace documents; assert shared `id` replaces the complete user definition with the complete workspace one (no field blend), valid definitions from both are retained, `scope` labels the source document, and recomputing from the same documents yields the same result. Minimum 100 iterations.
    - **Validates: Requirements 1.1, 1.2, 1.4, 1.7, 1.11**

  - [ ]* 3.3 Write property test for validity filtering
    - **Property 2: Config validity filtering**
    - Tag: `Feature: mcp-host-and-servers, Property 2: Config validity filtering`
    - Generate documents mixing valid entries with invalid ones (stdio without non-empty `command`, sse/http without non-empty `url`) plus empty/invalid-JSONC/missing-map/empty-map documents; assert only invalid entries are dropped, all other valid definitions retained, and two zero-yield documents produce an empty config. Minimum 100 iterations.
    - **Validates: Requirements 1.8, 1.9, 1.10**

  - [ ]* 3.4 Write property test for disabled retention vs. eligibility
    - **Property 3: Disabled definitions are retained but never started**
    - Tag: `Feature: mcp-host-and-servers, Property 3: Disabled definitions are retained but never started`
    - Assert every valid `disabled` definition appears in `build_mcp_config` output and never appears in `eligible_to_start`. Minimum 100 iterations.
    - **Validates: Requirements 1.5, 1.6**

  - [ ]* 3.5 Write unit tests for normalization and Default_Config
    - `detect_transport` explicit/`command`/`url` cases; `scope` assignment; `DEFAULT_CONFIG` contains exactly the three bundled servers, enabled, with the exact per-server auto-approve lists and no filesystem server.
    - _Requirements: 1.3, 1.4, 17.1, 17.2, 17.3, 17.4, 17.8_

- [ ] 4. Implement namespacing and the tool registry
  - [ ] 4.1 Implement `context/mcp_host/registry.py`
    - Injective namespacing encoder: `namespaced_name = "mcp::" + esc(server_id) + "::" + esc(bare_name)` where `esc` escapes `\`→`\\` and `:`→`\:`.
    - `McpToolRegistry` with `replace_server_tools(server_id, tools)` (atomic swap of only that server's subset), `remove_server_tools(server_id)` (atomic drop), `get(namespaced_name)`, and `list()` returning namespaced name + input schema + description.
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 5.1, 5.2_

  - [ ]* 4.2 Write property test for namespacing collision-freedom
    - **Property 10: Namespacing collision-freedom**
    - Tag: `Feature: mcp-host-and-servers, Property 10: Namespacing collision-freedom`
    - Generate distinct `(server_id, bare_name)` pairs (including equal bare names on different servers); assert assigned namespaced names are pairwise distinct. Minimum 100 iterations.
    - **Validates: Requirements 4.1, 4.2**

  - [ ]* 4.3 Write property test for tool record preservation
    - **Property 11: Tool record preservation**
    - Tag: `Feature: mcp-host-and-servers, Property 11: Tool record preservation`
    - Generate raw discovered tools; assert each aggregated record preserves the exact owning `server_id`, exact bare name, exact input schema, and exact description whenever supplied. Minimum 100 iterations.
    - **Validates: Requirements 4.3**

  - [ ]* 4.4 Write unit tests for registry operations
    - `get`/`list` shape, empty registry, and that `replace_server_tools`/`remove_server_tools` for one server leave other servers' subsets untouched.
    - _Requirements: 4.4, 5.1, 5.2_

- [ ] 5. Implement Server_Session over the injected spawn seam
  - [ ] 5.1 Implement `context/mcp_host/session.py`
    - Reuse the `lsp.py` seam pattern: `SpawnProcess` factory + `McpProcess` `Protocol` with an in-process fake for tests; `default_spawn` uses `asyncio.create_subprocess_exec(*argv, cwd=cwd, env=env, stdin=PIPE, stdout=PIPE)` — argv is a list, never a shell string.
    - `ServerSession`: `start()` (spawn with argv `[command, *args]`, `env` overlaid on inherited environment, `cwd=Workspace_Root`); `initialize(timeout)` (send `initialize`, set an internal `initialized` flag only on the matching valid response, then send `notifications/initialized`); `handle_roots_request()` (answer `roots/list` with `Workspace_Root`); `list_tools(timeout)`; `call_tool(bare_name, arguments, timeout)` (exactly one `tools/call`); `aclose()` (terminate + reap, idempotent).
    - Every write goes through `framing.encode_message`; every read through `framing.read_message` (malformed lines discarded, EOF drives the crash path).
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 4.3, 6.1, 9.1, 9.3, 18.1, 18.5_

  - [ ]* 5.2 Write property test for argv integrity on spawn
    - **Property 5: Argv integrity on spawn**
    - Tag: `Feature: mcp-host-and-servers, Property 5: Argv integrity on spawn`
    - Generate stdio definitions (including args containing spaces); with a recording fake spawn, assert the spawn argument vector equals `[command, *args]` element-for-element with every boundary preserved and is passed as a direct executable invocation, never a shell string. Minimum 100 iterations.
    - **Validates: Requirements 2.1, 9.1**

  - [ ]* 5.3 Write property test for environment overlay preservation
    - **Property 6: Environment overlay preservation**
    - Tag: `Feature: mcp-host-and-servers, Property 6: Environment overlay preservation`
    - Generate inherited environments and configured `env` maps; assert the spawned process environment equals the inherited environment updated by the configured string entries, leaving unrelated inherited entries unchanged. Minimum 100 iterations.
    - **Validates: Requirements 2.2**

  - [ ]* 5.4 Write property test for initialize-handshake ordering
    - **Property 7: Initialize-handshake ordering**
    - Tag: `Feature: mcp-host-and-servers, Property 7: Initialize-handshake ordering`
    - Using the fake process with a scripted (variably timed) `initialize` response, assert neither `notifications/initialized` nor `tools/list` is written on that session until the matching valid `initialize` response is received. Minimum 100 iterations.
    - **Validates: Requirements 2.5**

  - [ ]* 5.5 Write unit tests for session ordering and roots
    - `initialize` → `notifications/initialized` → `tools/list` step order (R2.4, R2.7, R2.8); `roots/list` answered with `Workspace_Root` (R2.6); `aclose()` idempotent (reaping an already-finished fake process is a no-op).
    - _Requirements: 2.4, 2.6, 2.7, 2.8, 9.3_

- [ ] 6. Implement MCP_Host lifecycle, aggregation, proxy, and crash isolation
  - [ ] 6.1 Implement `context/mcp_host/host.py` lifecycle and discovery
    - `MCPHost.__init__` (workspace root, config paths, `registry`, injected `spawn`, injected clock, startup/discovery/call timeouts) and `load()` building `MCP_Config` via `build_mcp_config` and starting eligible servers concurrently and independently.
    - Transport classification: enabled stdio → attempt live session; disabled and enabled sse/http → `stopped` with no session and zero network attempts.
    - Startup error categories (`spawn`/`handshake`/`startup-timeout`) recorded on `ServerRuntimeState.error_reason` naming the server `id`; on any post-spawn failure, terminate + reap the process and close every other resource for that session; other servers continue.
    - Discovery handling: on success atomically `replace_server_tools` and set status `running` (empty list clears the subset, status stays `running`); on invalid/failed/timeout discovery `remove_server_tools`, set status `error`, close the session, leave other servers untouched.
    - `servers()` returning runtime state (`id`, transport, scope, disabled, autoApprove, status + reason).
    - _Requirements: 2.9, 2.10, 2.11, 2.12, 2.13, 2.14, 3.1, 3.2, 3.3, 3.5, 3.6, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 13.2_

  - [ ] 6.2 Implement `host.py` tool-call proxy and crash detector
    - `proxy_tool_call(namespaced_name, arguments, *, emit, wait_for_approval)`: resolve owning server + bare name; absent name → `ToolCallError(UNAVAILABLE)` with no request; otherwise send exactly one `tools/call` to only the owning session and return `ToolCallSuccess` (tool-level `isError` results returned as success carrying the server's error payload — the two-level error model) or a typed `ToolCallError`; enforce the per-call wall-clock timeout via the injected clock; never raise into the run and carry no partial content on failure.
    - Per-session crash detector (process exit / stdout EOF): set only that server's status `error`, `remove_server_tools` for only that server, resolve any in-flight call once with a typed failure, keep the run active, and leave peers unchanged.
    - (Trust_Gate branch is added in task 7; this task emits a plain `CommandEvent(command=namespaced_name)` before a sent call — the `mcpServerId` field is populated in task 10.)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 9.2, 18.5_

  - [ ] 6.3 Implement `host.py` reload diffing and shutdown
    - `reload()`: recompute `MCP_Config` and diff — close removed/disabled/replaced sessions and remove their tools, completing cleanup of a replaced definition before starting its replacement, then start added/enabled stdio definitions using task 6.1 startup.
    - `aclose()`: terminate and reap every process owned by the host.
    - _Requirements: 1.11, 1.12, 1.13, 1.14, 9.4_

  - [ ]* 6.4 Write property test for transport-based session classification
    - **Property 4: Transport-based session classification**
    - Tag: `Feature: mcp-host-and-servers, Property 4: Transport-based session classification`
    - Generate configs; assert a live session is attempted exactly for enabled stdio, every disabled and every enabled sse/http gets `stopped` (never `error`) with no session, and zero network attempts occur for any sse/http (assert via a fake network seam that records zero calls). Minimum 100 iterations.
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.5, 3.6**

  - [ ]* 6.5 Write property test for startup failure leaking no process
    - **Property 8: Startup failure leaks no process**
    - Tag: `Feature: mcp-host-and-servers, Property 8: Startup failure leaks no process`
    - Generate post-spawn failures (spawn-after-create, handshake, startup-timeout) via the fake process/clock; assert the created process is terminated and reaped and every other session resource is closed before the failed outcome completes. Minimum 100 iterations.
    - **Validates: Requirements 2.12, 2.13**

  - [ ]* 6.6 Write property test for independent per-server startup
    - **Property 9: Independent per-server startup**
    - Tag: `Feature: mcp-host-and-servers, Property 9: Independent per-server startup`
    - Generate sets of enabled stdio servers with ≥1 failing to spawn/initialize; assert every other enabled server still attempts and completes startup. Minimum 100 iterations.
    - **Validates: Requirements 2.14**

  - [ ]* 6.7 Write property test for aggregation atomicity and isolation
    - **Property 12: Aggregation atomicity and isolation**
    - Tag: `Feature: mcp-host-and-servers, Property 12: Aggregation atomicity and isolation`
    - Generate multi-server registry states and successful discovery results (including empty); assert discovery replaces only the owning subset (empty clears it while status stays `running`, non-empty sets `running`) and leaves every other server's subset unchanged. Minimum 100 iterations.
    - **Validates: Requirements 4.4, 4.5, 4.6, 4.9**

  - [ ]* 6.8 Write property test for discovery-failure removal and isolation
    - **Property 13: Discovery-failure tool removal and isolation**
    - Tag: `Feature: mcp-host-and-servers, Property 13: Discovery-failure tool removal and isolation`
    - Generate discovery faults (invalid/failure/timeout); assert the host removes every tool of that server, sets its status `error`, closes its session, and leaves every other server's session/status/subset unchanged. Minimum 100 iterations.
    - **Validates: Requirements 4.7, 4.8, 4.9**

  - [ ]* 6.9 Write property test for single-owner call routing
    - **Property 15: Single-owner call routing**
    - Tag: `Feature: mcp-host-and-servers, Property 15: Single-owner call routing`
    - Generate multi-server tool sets and available invocations; assert exactly one `tools/call` carrying the mapped bare name + arguments goes to the mapped session, zero to any other session, and a valid response yields exactly one success attributed to the owning server and tool. Minimum 100 iterations.
    - **Validates: Requirements 6.1, 6.2, 6.3**

  - [ ]* 6.10 Write property test for no partial result on failure
    - **Property 16: No partial result on failure**
    - Tag: `Feature: mcp-host-and-servers, Property 16: No partial result on failure`
    - Generate unavailable/failing/timed-out/session-lost (including crash-in-flight) invocations via fakes; assert each resolves exactly once with a single typed error carrying no partial content. Minimum 100 iterations.
    - **Validates: Requirements 6.4, 6.5, 6.6, 6.7, 8.6**

  - [ ]* 6.11 Write property test for failure containment
    - **Property 17: Failure containment**
    - Tag: `Feature: mcp-host-and-servers, Property 17: Failure containment`
    - Generate tool-call faults and crashes; assert the host returns a typed outcome without raising into the run and the run remains active. Minimum 100 iterations.
    - **Validates: Requirements 6.8, 8.5**

  - [ ]* 6.12 Write property test for crash isolation
    - **Property 20: Crash isolation**
    - Tag: `Feature: mcp-host-and-servers, Property 20: Crash isolation`
    - Generate multi-server states and crash one server; assert only the affected server's tools are removed and only its status becomes `error`, and every other server's session/status/tools and previously completed outcomes are unchanged. Minimum 100 iterations.
    - **Validates: Requirements 8.2, 8.3, 8.4**

  - [ ]* 6.13 Write property test for process termination and reaping
    - **Property 21: Process termination and reaping**
    - Tag: `Feature: mcp-host-and-servers, Property 21: Process termination and reaping`
    - Generate sets of started fake sessions; assert closing a session or `aclose()`-ing the host terminates and reaps every associated process and that the operation is idempotent (reaping a finished process is a no-op). Minimum 100 iterations.
    - **Validates: Requirements 9.3, 9.4**

  - [ ]* 6.14 Write unit tests for error categories, status, reload order, and two-level errors
    - Startup error reason text per category (R2.9–R2.11); status `running` on discovery success (R4.5); reload completes replaced-session cleanup before replacement startup (R1.12–R1.14); a healthy server's `isError` `tools/call` response returns `ToolCallSuccess` carrying the server's error payload while transport faults return `ToolCallError` (two-level error model).
    - _Requirements: 2.9, 2.10, 2.11, 4.5, 1.12, 1.13, 1.14, 6.3_

- [ ] 7. Implement the Trust_Gate over the existing approval channel
  - [ ] 7.1 Implement `context/mcp_host/trust.py` and integrate into the proxy
    - `is_auto_approved(server, bare_name)`: exact, case-sensitive, whole-string membership in the owning server's `auto_approve` (the Python twin of `isToolAutoApproved`); an absent/empty list matches nothing; a `trusted` field, if present, is ignored.
    - Approval-prompt builder identifying the owning server `id`, the `Namespaced_Tool_Name`, and the requested arguments.
    - Wire the gate into `MCPHost.proxy_tool_call`: auto-approved → proxy with no `ApprovalEvent`; otherwise `emit` a complete `ApprovalEvent` and block on the injected `wait_for_approval` before any `tools/call`; on `approve` proxy the call; on `reject` return `ToolCallError(DECLINED)` with no call; an incomplete prompt is treated as unsatisfied (no call). Reuse the existing `ApprovalEvent` + `POST /v1/agent/decision` (`kind:"approval"`) + `_Run.wait_for_approval_decision` path — add nothing to the decision transport.
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11_

  - [ ]* 7.2 Write property test for auto-approve exact-match gating
    - **Property 18: AutoApprove exact-match gating**
    - Tag: `Feature: mcp-host-and-servers, Property 18: AutoApprove exact-match gating`
    - Generate tools and owning `auto_approve` lists (including absent/empty and a spurious `trusted` field); assert no `ApprovalEvent` is emitted iff the bare name is an exact whole-string member, otherwise an `ApprovalEvent` naming server `id`/namespaced name/arguments is emitted and no `tools/call` is sent while pending, and `trusted` never changes the outcome. Minimum 100 iterations.
    - **Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.6, 7.11**

  - [ ]* 7.3 Write property test for rejection yielding a declined result without a call
    - **Property 19: Rejection yields a declined result without a call**
    - Tag: `Feature: mcp-host-and-servers, Property 19: Rejection yields a declined result without a call`
    - Generate non-auto-approved invocations with a scripted `reject` decision; assert a typed `DECLINED` result is returned and zero `tools/call` requests are sent. Minimum 100 iterations.
    - **Validates: Requirements 7.8**

  - [ ]* 7.4 Write unit tests for Trust_Gate step behavior
    - Pending while no decision (R7.5); `approve` proxies the waiting call (R7.7); an incomplete approval prompt leaves the gate unsatisfied (R7.9); `auto_approve` is the only config bypass and `trusted` is ignored (R7.10, R7.11).
    - _Requirements: 7.5, 7.7, 7.9, 7.10, 7.11_

- [ ] 8. Checkpoint - foundational host is complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 9. Implement the admitted control routes and isolated candidate test
  - [ ] 9.1 Implement `MCPHost.test_candidate` (fully isolated)
    - Run startup → handshake → discovery on a throwaway session that never touches live config, sessions, statuses, the registry, or the toolset, even when the candidate `id` equals a live server `id`; invalid candidate → `TestValidationFailure` (no process/message/network); valid stdio → `TestSuccess(tool_count, bare_names)` (count may be 0) then terminate + reap the candidate (cleanup failure → `TestFailure`); sse/http → `TestUnsupported` with no network.
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9, 11.10, 11.11_

  - [ ] 9.2 Implement `routes/mcp.py` and wire it into `create_app`
    - Build an `APIRouter` with `dependencies=[Depends(require_admission)]` on the router so every `/v1/mcp/*` route is admitted before its handler and a rejected request performs no side effect; include it on the existing listener in `create_app` (no new interface).
    - Routes: `GET /v1/mcp/servers` (runtime state for Settings), `POST /v1/mcp/reload` (recompute + lifecycle diff), `POST /v1/mcp/test` (one candidate definition → `MCPHost.test_candidate`).
    - _Requirements: 10.1, 10.2, 10.3, 10.5, 11.1, 13.1, 13.2, 13.12, 13.13, 13.18_

  - [ ]* 9.3 Write property test for rejected admission having no side effect
    - **Property 23: Rejected admission has no side effect**
    - Tag: `Feature: mcp-host-and-servers, Property 23: Rejected admission has no side effect`
    - With a non-loopback settings fixture and generated `/v1/mcp/*` requests lacking a valid token, assert every request returns 401 and no process/MCP request/network/config/session/status/toolset side effect occurs (assert against recording fakes). Minimum 100 iterations.
    - **Validates: Requirements 10.3**

  - [ ]* 9.4 Write property test for candidate test isolation
    - **Property 24: Candidate test isolation**
    - Tag: `Feature: mcp-host-and-servers, Property 24: Candidate test isolation`
    - Generate candidate definitions (valid stdio, invalid, sse/http, including `id` colliding with a live server); assert `Workspace_MCP_Config`, `MCP_Config`, live sessions, statuses, aggregated tools, and the toolset are unchanged; invalid → no process/message/network; sse/http → no network. Minimum 100 iterations.
    - **Validates: Requirements 11.2, 11.7, 11.10, 11.11**

  - [ ]* 9.5 Write integration tests for admission wiring and candidate phases
    - Every `/v1/mcp/*` route returns 401 on a non-loopback binding without a valid token and is admitted on loopback (R10.1, R10.2, R10.4); routes serve on the single existing listener (R10.5); candidate startup→handshake→discovery ordering, success/zero-tool/failure outcomes, and cleanup-failure reason (R11.3–R11.6, R11.9), driven by fakes.
    - _Requirements: 10.1, 10.2, 10.4, 10.5, 11.3, 11.4, 11.5, 11.6, 11.9_

- [ ] 10. Wire aggregated MCP tools additively into the agent toolset
  - [ ] 10.1 Add the MCP seam to `toolsets.py`
    - Add an optional `mcp: McpCallSeam | None` to `FullToolset` with `mcp_tools()` (enumerate aggregated records + input schemas for the model) and `async call_mcp_tool(namespaced_name, arguments)` delegating to `MCPHost.proxy_tool_call` with the run's `(emit, wait_for_approval)`; `McpCallSeam.proxy(namespaced_name, arguments) -> ToolCallOutcome`. Native methods and `ReadOnlyToolset` are untouched (Ask Mode still cannot invoke MCP tools).
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [ ] 10.2 Bind MCP_Host into the run pipeline and app lifecycle
    - Construct/hold one `MCPHost` in `create_app`, call `load()` at startup and `aclose()` at shutdown, and thread the `McpCallSeam` (bound to the active `_Run`'s `emit`/`wait_for_approval`) into the `FullToolset` created in `run_pipeline.py`. MCP output enters model context only as untrusted tool-result data attributed to the owning server/tool.
    - _Requirements: 5.3, 5.5, 9.5, 9.6, 9.7_

  - [ ]* 10.3 Write property test for additive toolset exposure and synchronization
    - **Property 14: Additive toolset exposure and synchronization**
    - Tag: `Feature: mcp-host-and-servers, Property 14: Additive toolset exposure and synchronization`
    - Generate registry states; assert `FullToolset` exposes exactly the aggregated MCP tools under their namespaced names with input schemas, and mutating the aggregated set updates only the generic MCP entries while leaving every non-MCP entry unchanged. Minimum 100 iterations.
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4**

  - [ ]* 10.4 Write property test for MCP output remaining untrusted
    - **Property 22: MCP output remains untrusted**
    - Tag: `Feature: mcp-host-and-servers, Property 22: MCP output remains untrusted`
    - Generate MCP tool outputs shaped like approvals/decisions/control messages or suggesting config changes/spawns/further calls; assert the gateway incorporates them only as untrusted tool-result data attributed to the owning server/tool and never as a control-plane message or approval/admission bypass. Minimum 100 iterations.
    - **Validates: Requirements 9.6, 9.7**

  - [ ]* 10.5 Write coexistence regression test for the fixed tools
    - Assert `MCPGateway.available_tools()` still returns exactly `mcp::web::search` and `mcp::github` and that their result/timeout/process-termination/typed-error behavior is unchanged after MCP_Host adds and removes generic entries; the bundled `Default_Config` does not remove or rename the fixed tools.
    - _Requirements: 5.6, 5.7, 17.9_

- [ ] 11. Apply the shared-type `mcpServerId` contract change and wire emission
  - [ ] 11.1 Add the field to the Python contract and populate it on emit
    - Add optional, nullable `mcp_server_id: str | None = Field(default=None, alias="mcpServerId")` to `CommandEvent` in `packages/shared-types/python/shared_schema/agent_events.py` (kind stays `command`; no new discriminator).
    - Update `MCPHost.proxy_tool_call` to emit the `CommandEvent` with `command` = the invoked `Namespaced_Tool_Name` and `mcp_server_id` = the exact owning server `id`.
    - _Requirements: 12.1, 12.2, 12.5_

  - [ ] 11.2 Regenerate the TypeScript twin
    - Run `pnpm schema:generate` so `packages/shared-types/typescript/src/agent-events.ts` declares `mcpServerId?: string | null` on `CommandEvent` (do not hand-edit the generated file).
    - _Requirements: 12.3_

  - [ ]* 11.3 Write property test for MCP command-event emission
    - **Property 25: MCP command-event emission**
    - Tag: `Feature: mcp-host-and-servers, Property 25: MCP command-event emission`
    - Generate proxied tool calls; assert the emitted `CommandEvent` has `command` equal to the invoked namespaced name and `mcpServerId` equal to the exact owning server `id`. Minimum 100 iterations.
    - **Validates: Requirements 12.1**

  - [ ]* 11.4 Write twin-compatibility and drift tests
    - Python `CommandEvent` validates payloads with and without `mcpServerId` and serializes the camelCase alias (R12.2, R12.4); assert the regenerated TS declares `mcpServerId?: string | null` (R12.3); run `python generate_ts.py --check` (i.e., `pnpm schema:generate --check`) and assert no drift.
    - _Requirements: 12.2, 12.3, 12.4_

- [ ] 12. Implement the frontend badge and Settings management
  - [ ] 12.1 Add a workspace upsert/serialize helper to `mcp-config.ts`
    - Add a pure `upsertWorkspaceServer(workspaceText, server)` (and serialize) that replaces only the targeted entry and preserves every other workspace entry, and that produces a complete workspace override (same `id`) when editing a user-scoped definition without modifying user config. Reuse existing parse/merge/`isToolAutoApproved`.
    - _Requirements: 13.6, 13.7, 13.8, 13.9, 13.10, 13.11_

  - [ ] 12.2 Add the MCP badge to `CommandRow`
    - In `rows.tsx`, read `event.mcpServerId`; when non-null render an "MCP" badge plus the exact owning server `id` on the existing row; when omitted/null keep the native command row unchanged. No new row component and no `ROW_COMPONENTS` change.
    - _Requirements: 12.6, 12.7, 12.8_

  - [ ] 12.3 Convert `sections/Mcp.tsx` to live management
    - List every `MCP_Config` definition (including disabled and sse/http) with `id`, transport, `scope`, `disabled`, `autoApprove`, and live status from `GET /v1/mcp/servers` (including the `error` reason for that same `id`); add/edit form with transport-conditional inputs (`command`/`args`/`env` for stdio, `url` for sse/http) and `id`/transport/`disabled`/`autoApprove` fields; writes go only to workspace config via `12.1` + the Tauri bridge; after a successful write request `POST /v1/mcp/reload` and show the resulting status; on validation/write/reload failure show the failure and do not present status as refreshed; Test connection sends the currently displayed (including unsaved) definition to `POST /v1/mcp/test`, shows the outcome, writes nothing, requests no reload, and leaves listed statuses unchanged; represent status using only `running`/`stopped`/`error`.
    - _Requirements: 3.4, 8.8, 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.10, 13.11, 13.12, 13.13, 13.14, 13.15, 13.16, 13.17, 13.18_

  - [ ]* 12.4 Write property test for settings write preservation and override
    - **Property 26: Settings write preservation and override**
    - Tag: `Feature: mcp-host-and-servers, Property 26: Settings write preservation and override`
    - fast-check over workspace documents and single-server changes; assert the write replaces only the targeted workspace entry and preserves every other entry, and that editing a user-scoped definition writes a complete workspace override with the same `id` without modifying user config. `{ numRuns: 200 }`.
    - **Validates: Requirements 13.8, 13.9**

  - [ ]* 12.5 Write component tests for the CommandRow badge
    - A `CommandEvent` with non-null `mcpServerId` renders the MCP badge and the owning `id`; omitted/null preserves the native presentation without a badge.
    - _Requirements: 12.6, 12.7_

  - [ ]* 12.6 Write component tests for the Settings section
    - Listing (including disabled/sse/http and the `error` reason), transport-conditional fields, workspace-only writes + reload, success/failure status display, and Test connection leaving statuses unchanged with no write/reload; status limited to `running`/`stopped`/`error`.
    - _Requirements: 3.4, 8.8, 13.1, 13.2, 13.3, 13.4, 13.5, 13.12, 13.13, 13.14, 13.15, 13.16, 13.17, 13.18_

  - [ ]* 12.7 Keep the `ROW_COMPONENTS` totality property test green
    - Confirm `rows.dispatch.property.test.tsx` still passes unchanged after the additive contract change and badge (registry key set still equals the `EventType` discriminators; one distinct component per kind). Make only type-import adjustments if the additive change requires them; do not change the registry.
    - _Requirements: 12.5, 12.8_

- [ ] 13. Implement the three bundled stdio servers and register them
  - [ ] 13.1 Implement the `_mcp.py` server scaffold
    - Create `services/mcp_servers/__init__.py` and `services/mcp_servers/_mcp.py`: a blocking stdin/stdout loop using the same newline JSON-RPC framing that answers `initialize` (declaring capabilities), `notifications/initialized`, `roots/list` (echoing the host-provided workspace root), `tools/list` (from a registered tool table), and `tools/call` (dispatching to a handler that returns a normal result or an `isError` result). Network via `httpx`; never launch a browser.
    - _Requirements: 14.7, 14.8, 15.8, 18.1_

  - [ ] 13.2 Implement `web_search.py`
    - Expose `web_search(query: str≠"", max_results: int>0 = 5)`; query the DuckDuckGo Instant Answer API first (no key) via an injectable `httpx` client; a usable entry has non-empty `title`/`url`/`snippet`; return ≤ `max_results` such entries; on IA failure/parse-failure/zero-usable, fall back to the DuckDuckGo HTML results page parsed with regex; if the fallback also fails/parses-empty, return a typed tool failure naming the query.
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.9_

  - [ ] 13.3 Implement `docs.py`
    - `fetch_docs(url: str)` returns page text with HTML markup removed by regex, or the raw text unchanged if the regex step raises; `search_npm(package: str)` returns exactly `version`/`description`/`readme` from the npm registry; `search_pypi(package: str)` returns exactly `version`/`description` from PyPI; retrieval failure or absent package → typed tool failure naming the resource/package. Network via an injectable `httpx` client.
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.9_

  - [ ] 13.4 Implement `git_history.py`
    - `git_log(path?: str, n: int>0 = 10)`, `git_blame(file: str, line_start: int>0, line_end: int>0, 1-based inclusive)`, `git_show(sha: str)`; execute the local `git` binary from an argv with `cwd=Workspace_Root` via an injectable git runner; every filesystem-path parameter is canonically resolved against `Workspace_Root` and fails closed if resolution fails or escapes (mirroring `Toolset._resolve_within_workspace`); `line_start > line_end` → typed failure before invoking git; spawn failure or non-zero exit → typed failure (with git stderr on non-zero); each invocation isolated; inspects only the local repo without contacting a remote.
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7, 16.8, 16.9, 16.10, 16.11, 16.12, 16.13, 16.14, 16.15, 16.16, 16.17_

  - [ ]* 13.5 Write property test for web search result validity and cap
    - **Property 27: Web search result validity and cap**
    - Tag: `Feature: mcp-host-and-servers, Property 27: Web search result validity and cap`
    - Inject a fake `httpx` client returning scripted IA/HTML payloads; assert every returned entry has non-empty `title`/`url`/`snippet` and the count never exceeds `max_results`. Minimum 100 iterations.
    - **Validates: Requirements 14.3, 14.4, 14.5**

  - [ ]* 13.6 Write property test for docs HTML markup removal
    - **Property 28: Docs HTML markup removal**
    - Tag: `Feature: mcp-host-and-servers, Property 28: Docs HTML markup removal`
    - Inject scripted pages; for pages where regex markup removal succeeds, assert the returned text contains no HTML tags. Minimum 100 iterations.
    - **Validates: Requirements 15.2**

  - [ ]* 13.7 Write property test for package metadata exact projection
    - **Property 29: Package metadata exact projection**
    - Tag: `Feature: mcp-host-and-servers, Property 29: Package metadata exact projection`
    - Inject npm and PyPI metadata payloads; assert `search_npm` returns exactly `version`/`description`/`readme` and `search_pypi` returns exactly `version`/`description`. Minimum 100 iterations.
    - **Validates: Requirements 15.5, 15.7**

  - [ ]* 13.8 Write property test for git argv and workspace confinement
    - **Property 30: Git argv and workspace confinement**
    - Tag: `Feature: mcp-host-and-servers, Property 30: Git argv and workspace confinement`
    - With an injected git runner recording argv/cwd, assert git runs from an argv with `cwd=Workspace_Root` and every filesystem-path parameter is canonically resolved against `Workspace_Root` before any git process starts; if resolution fails or escapes, a typed failure is returned and no git process starts. Minimum 100 iterations.
    - **Validates: Requirements 16.2, 16.9, 16.10, 16.11, 16.12**

  - [ ]* 13.9 Write property test for git line-range validation before invocation
    - **Property 31: Git line-range validation before invocation**
    - Tag: `Feature: mcp-host-and-servers, Property 31: Git line-range validation before invocation`
    - Generate `git_blame` calls with `line_start > line_end`; assert a typed failure is returned and the git runner is never invoked. Minimum 100 iterations.
    - **Validates: Requirements 16.5**

  - [ ]* 13.10 Write property test for git log entry cap
    - **Property 32: Git log entry cap**
    - Tag: `Feature: mcp-host-and-servers, Property 32: Git log entry cap`
    - Generate `git_log` calls with limit `n` against a fake runner returning many entries; assert no more than `n` entries are returned. Minimum 100 iterations.
    - **Validates: Requirements 16.3**

  - [ ]* 13.11 Write property test for git per-invocation failure isolation
    - **Property 33: Git per-invocation failure isolation**
    - Tag: `Feature: mcp-host-and-servers, Property 33: Git per-invocation failure isolation`
    - Generate sequences of git invocations where one fails (confinement rejection, spawn failure, or non-zero exit); assert the availability and outcomes of every other invocation are unaffected. Minimum 100 iterations.
    - **Validates: Requirements 16.13, 16.16**

  - [ ]* 13.12 Write unit tests for bundled-server fallbacks and errors
    - Web-search HTML fallback path and typed failure naming the query (R14.6, R14.9); `fetch_docs` regex-failure passthrough (R15.3) and absent-package/retrieval-failure typed failure (R15.9); git spawn-failure and non-zero-exit typed failures with stderr (R16.14, R16.15), all via injected fakes.
    - _Requirements: 14.6, 14.9, 15.3, 15.9, 16.14, 16.15_

  - [ ]* 13.13 Write integration test for Default_Config registration and auto-approval
    - Load `DEFAULT_CONFIG` into `MCPHost` with a fake spawn exposing the bundled tools; assert the three servers are registered and enabled, their tools are aggregated and invoked without an `ApprovalEvent` per their auto-approve lists, no filesystem MCP server is registered, and the fixed `mcp::web::search`/`mcp::github` tools are preserved.
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8, 17.9_

- [ ] 14. Final checkpoint - full feature integrated
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; they are never implemented when executing non-optional tasks.
- Each task references specific requirement sub-clauses for traceability; each property-based test names the exact design property it validates.
- The feature is strictly additive: `MCPGateway` and its two fixed tools are never modified (task 10.5 is the regression guard), and no new event kind or `ROW_COMPONENTS` entry is introduced (task 12.7 keeps the totality test green).
- Property tests use Hypothesis (Python) and fast-check (frontend) with ≥100 iterations, exercising subprocess/network/git/clock only through injected seams with in-process fakes.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "12.1", "13.1"] },
    { "id": 1, "tasks": ["2.2", "2.3", "2.4", "3.1", "4.1", "5.1", "12.4", "13.2", "13.3", "13.4"] },
    { "id": 2, "tasks": ["3.2", "3.3", "3.4", "3.5", "4.2", "4.3", "4.4", "5.2", "5.3", "5.4", "5.5", "6.1", "13.5", "13.6", "13.7", "13.8", "13.9", "13.10", "13.11", "13.12"] },
    { "id": 3, "tasks": ["6.2", "6.4", "6.5", "6.6", "6.7", "6.8", "13.13"] },
    { "id": 4, "tasks": ["6.3", "6.9", "6.10", "6.11", "6.12", "10.1"] },
    { "id": 5, "tasks": ["6.13", "6.14", "7.1"] },
    { "id": 6, "tasks": ["7.2", "7.3", "7.4", "9.1"] },
    { "id": 7, "tasks": ["9.2", "9.4", "11.1"] },
    { "id": 8, "tasks": ["9.3", "9.5", "10.2", "11.2", "11.3"] },
    { "id": 9, "tasks": ["10.3", "10.4", "10.5", "11.4", "12.2", "12.3"] },
    { "id": 10, "tasks": ["12.5", "12.6", "12.7"] }
  ]
}
```
