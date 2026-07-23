# Requirements Document

## Introduction

This feature delivers **Part 4 — MCP (Model Context Protocol) Integration** as one coherent capability:

- **4.1 — MCP Server Host**: a generic, configuration-driven MCP host in the Gateway that starts enabled stdio servers, completes MCP initialization, discovers and aggregates tools, proxies tool calls, applies per-tool approval policy, contains server failures, exposes live server state in Settings, and surfaces MCP calls in the existing run feed.
- **4.2 — Built-in MCP Servers**: three bundled stdio servers for web search, documentation retrieval, and workspace-confined git history, registered in the shipped MCP configuration with their tools auto-approved.

The generic host is additive. The existing fixed `mcp::web::search` and `mcp::github` tools remain available with the behavior implemented by `services/gateway/src/zocai_gateway/context/mcp_gateway.py`; this feature does not modify, remove, or replace that behavior.

### Current state — existing foundations and net-new scope

- **Fixed MCP-like tools exist and remain unchanged.** `MCPGateway` in `services/gateway/src/zocai_gateway/context/mcp_gateway.py` exposes exactly `mcp::web::search` and `mcp::github`. The fixed web-search path uses an argv-based subprocess worker, caps output at 10 documents, applies a 30-second wall-clock timeout by default, terminates failed workers, returns no partial result on failure, and converts failures to typed `MCPError` outcomes. `MCPGateway` has no configuration-driven server lifecycle, MCP initialization, `tools/list` discovery, generic `tools/call` proxy, per-server `autoApprove` policy, or generic crash isolation. The generic MCP_Host coexists with this fixed surface.
- **The configuration and trust model exists.** `apps/frontend/src/lib/mcp-config.ts` parses a user-level MCP configuration document and workspace `.zoc/mcp.json`, merges definitions by server `id` with workspace precedence, recognizes `stdio`, `sse`, and `http`, derives `scope` from the source document, and models `disabled` plus per-tool `autoApprove`. `isToolAutoApproved` performs exact membership in that per-server list. This feature preserves that model; it does not adopt `~/.zoc-studio/mcp_servers.json` or a per-server `trusted` boolean.
- **A read-only Settings preview exists.** `apps/frontend/src/features/settings/sections/Mcp.tsx` currently reads the workspace configuration, lists server identity, transport, scope, command or URL, disabled state, and auto-approved tools, and states that live MCP connections are deferred. This feature extends that section with live status and management behavior.
- **The run-feed command path exists.** `CommandEvent` is defined in both shared contract twins, and `CommandRow` is already registered for the `command` event kind in `ROW_COMPONENTS`. This feature adds an optional owning-server field to that event and conditionally decorates the existing command row; it introduces no MCP-specific event kind.
- **The approval control path exists.** `ApprovalEvent`, `ApprovalWaiter` / `wait_for_approval`, and admitted `POST /v1/agent/decision` requests with `kind: "approval"` and `decision: "approve" | "reject"` provide the decision path reused by this feature.
- **The built-in servers are net-new.** No `services/mcp_servers/` implementation currently exposes the web-search, docs, or git-history tools specified below.

### Confirmed v1 decisions

1. **Configuration and trust:** use the existing `McpServer` / `.zoc/mcp.json` merge model and per-tool `autoApprove` list. A per-server `trusted` boolean is not part of this feature.
2. **Coexistence:** add the generic MCP_Host and bundled servers without changing or removing `MCPGateway`, `mcp::web::search`, or `mcp::github`.
3. **Run-feed contract:** reuse the existing `command` event kind with optional wire field `mcpServerId`; keep the Python and TypeScript `CommandEvent` definitions in lockstep and render the existing `CommandRow` with an MCP badge when the field is present.
4. **Approval path:** reuse `ApprovalEvent`, admitted `POST /v1/agent/decision` requests of kind `approval`, and the existing approval-wait pattern for every non-auto-approved MCP call.
5. **Live transports:** support live MCP sessions over stdio only. Keep configured SSE and HTTP definitions visible in Settings with `stopped` status and open no connection to them in v1.

### Scope boundaries

- **In scope:** the generic MCP host runtime; admitted `/v1/mcp/*` control surfaces; Settings and run-feed integration; and bundled web-search, docs, and git-history stdio servers with shipped registration.
- **Out of scope:** live SSE or HTTP MCP sessions; OAuth for remote MCP servers; a filesystem MCP server; and any modification to the fixed `MCPGateway` behavior owned by the `zoc-agent-ecosystem-merge` spec.
- The existing workspace-confined native toolset in `services/gateway/src/zocai_gateway/toolsets.py` remains the filesystem capability; Part 4 adds no filesystem MCP server.

### Reuse constraints

- Interpret and merge server definitions according to `loadMcpServers`, `mergeMcpServers`, and `isToolAutoApproved` in `apps/frontend/src/lib/mcp-config.ts`.
- Follow the subprocess lifecycle and test-seam pattern demonstrated by `services/gateway/src/zocai_gateway/routes/lsp.py`: argv-based stdio spawning, workspace-root context, bidirectional JSON-RPC transport, process termination on close, and injectable protocol seams.
- Apply `require_admission` to every `/v1/mcp/*` route, consistent with `services/gateway/src/zocai_gateway/auth.py`.
- Aggregate MCP tools through the existing agent toolset seam in `services/gateway/src/zocai_gateway/toolsets.py`; add no second model-facing tool transport.
- Reuse `ApprovalEvent`, `ApprovalWaiter`, and `POST /v1/agent/decision` for non-auto-approved calls.
- Reuse `CommandEvent` and `CommandRow` for MCP call rows, keeping `packages/shared-types/python/shared_schema/agent_events.py` and `packages/shared-types/typescript/src/agent-events.ts` contract-compatible.

## Glossary

- **Developer**: A person using the Zoc Studio frontend to configure MCP servers or run the agent.
- **Frontend**: The `apps/frontend` TypeScript application.
- **Gateway**: The FastAPI sidecar in `services/gateway` that owns agent control and telemetry routes and, with this feature, the MCP_Host.
- **Request_Admission**: The policy implemented by `is_request_admitted` and enforced by the `require_admission` dependency: loopback requests are admitted, while a non-loopback binding requires an exact match to the configured shared token.
- **MCP**: Model Context Protocol, the JSON-RPC protocol used to initialize a server, discover its tools, and invoke those tools.
- **User_MCP_Config**: The user-scoped MCP configuration document supplied to the existing MCP config loader.
- **Workspace_MCP_Config**: The workspace `.zoc/mcp.json` configuration document.
- **MCP_Config**: The merged MCP_Server_Definitions produced from User_MCP_Config and Workspace_MCP_Config with workspace precedence by server `id`, including valid disabled definitions.
- **MCP_Server_Definition**: A normalized `McpServer` entry with server `id`, Transport, stdio `command` / `args` / `env` or remote `url`, AutoApprove_List, `disabled`, and derived `scope`.
- **MCP_Host**: The net-new generic Gateway runtime that owns supported server sessions, tool discovery, tool aggregation, trust gating, call proxying, and lifecycle state.
- **MCPGateway**: The existing fixed two-tool class in `context/mcp_gateway.py`, which remains unchanged and coexists with MCP_Host.
- **Transport**: One of `stdio`, `sse`, or `http` as normalized by `mcp-config.ts`.
- **Stdio_Server**: An MCP_Server_Definition whose Transport is `stdio`.
- **Unsupported_Live_Server**: A v1 MCP_Server_Definition whose Transport is `sse` or `http`.
- **Server_Session**: One live stdio JSON-RPC connection owned by MCP_Host for a started Stdio_Server.
- **Initialize_Handshake**: The MCP `initialize` request and its corresponding valid response followed by the host's `notifications/initialized` notification.
- **Tool_Discovery**: The MCP `tools/list` request and response for one initialized Server_Session.
- **MCP_Tool**: One tool returned by Tool_Discovery.
- **Tool_Call**: One MCP `tools/call` request and corresponding response.
- **Namespaced_Tool_Name**: A collision-free Agent_Toolset identifier for an MCP_Tool, qualified by owning server `id` so equal bare names from different servers remain distinct.
- **Agent_Toolset**: The existing model-facing tool seam represented by `Toolset` / `FullToolset` in `services/gateway/src/zocai_gateway/toolsets.py`.
- **AutoApprove_List**: The owning server's `autoApprove` array of bare tool names. Exact, case-sensitive, whole-string membership allows a Tool_Call to skip the approval card; an absent or empty array matches no tool.
- **Trust_Gate**: The approval wait required before MCP_Host sends a non-auto-approved Tool_Call.
- **Approval_Event**: The existing shared `ApprovalEvent` carrying a prompt and optional decision.
- **Decision_Channel**: Admitted `POST /v1/agent/decision` with the run `runId`, `kind: "approval"`, and `decision: "approve" | "reject"`.
- **Approval_Waiter**: The existing run-scoped wait pattern represented by `ApprovalWaiter` / `wait_for_approval`.
- **Server_Crash**: Unexpected process exit, unexpected stdout end-of-stream, or unrecoverable Server_Session failure after a Stdio_Server starts.
- **MCP_Test_Endpoint**: Admitted `POST /v1/mcp/test`, which evaluates one candidate definition without changing the live MCP_Host server set.
- **Settings_MCP_Section**: `apps/frontend/src/features/settings/sections/Mcp.tsx`.
- **Server_Status**: One of `running`, `stopped`, or `error`, with an error reason when status is `error`.
- **Run_Feed**: `AgentRunFeed`, whose recognized event rows are selected through `ROW_COMPONENTS`.
- **Command_Event**: The shared `CommandEvent` rendered by the existing `CommandRow` for event kind `command`.
- **MCP_Server_Id_Field**: Optional and nullable `mcpServerId` on the Command_Event wire contract, represented as aliased optional `mcp_server_id` in Python and optional `mcpServerId` in TypeScript.
- **Event_Contract**: The event schema kept compatible across the Python and TypeScript shared-type modules.
- **JSON_RPC_Message**: One valid MCP JSON-RPC message represented as a JSON object.
- **JSON_Value_Equality**: Normal recursive JSON-value equality: object members compare by key and value regardless of member order, array elements compare in order, and scalar values compare by JSON type and value.
- **Stdio_Framing**: Exactly one JSON serialization of one JSON_RPC_Message followed by one newline terminator.
- **Web_Search_Server**: The bundled stdio server implemented at `services/mcp_servers/web_search.py`.
- **Docs_Server**: The bundled stdio server implemented at `services/mcp_servers/docs.py`.
- **Git_History_Server**: The bundled stdio server implemented at `services/mcp_servers/git_history.py`.
- **Workspace_Root**: The resolved absolute root directory of the active workspace.
- **Default_Config**: The shipped Workspace_MCP_Config entries that register the three bundled servers.

## Requirements

### Requirement 1 — Load, merge, and reload MCP configuration

**User Story:** As a Developer, I want user and workspace MCP definitions merged predictably, so that workspace choices override user defaults without changing the established configuration format.

#### Acceptance Criteria

1. THE MCP_Host SHALL produce MCP_Config by normalizing and merging User_MCP_Config and Workspace_MCP_Config.
2. WHEN the same server `id` appears in User_MCP_Config and Workspace_MCP_Config, THE MCP_Host SHALL replace the complete user definition for that `id` with the complete workspace definition.
3. THE MCP_Host SHALL interpret `transport` or `type`, `command`, `args`, `env`, `url`, `autoApprove`, and `disabled` according to the normalization behavior of `mcp-config.ts`.
4. WHEN a definition originates from User_MCP_Config or Workspace_MCP_Config, THE MCP_Host SHALL assign `scope` as `user` or `workspace`, respectively.
5. WHERE a valid MCP_Server_Definition has `disabled` equal to true, THE MCP_Host SHALL retain that definition in MCP_Config.
6. WHERE an MCP_Server_Definition has `disabled` equal to true, THE MCP_Host SHALL exclude that definition from the set of servers eligible to start.
7. WHEN normalization produces a valid MCP_Server_Definition, THE MCP_Host SHALL include that definition in MCP_Config subject to workspace precedence by server `id`.
8. IF an individual definition is invalid, including a stdio definition without a non-empty `command` or an SSE or HTTP definition without a non-empty `url`, THEN THE MCP_Host SHALL exclude only that definition while retaining every other valid definition.
9. IF a configuration document is empty, is invalid JSONC, lacks an object-valued `mcpServers` map, or contains an empty `mcpServers` map, THEN THE MCP_Host SHALL treat that document as contributing zero definitions while retaining valid definitions from the other document.
10. IF User_MCP_Config and Workspace_MCP_Config contribute zero valid definitions, THEN THE MCP_Host SHALL produce an empty MCP_Config and open no Server_Session.
11. WHEN the Developer requests configuration reload, THE MCP_Host SHALL recompute MCP_Config from the current User_MCP_Config and Workspace_MCP_Config.
12. WHEN a reload removes, disables, or replaces a running Stdio_Server definition, THE MCP_Host SHALL close that definition's existing Server_Session and remove its MCP_Tools.
13. WHEN a reload replaces a running Stdio_Server definition, THE MCP_Host SHALL complete the cleanup in criterion 12 before attempting startup for the replacement definition.
14. WHEN a reload adds or enables a Stdio_Server definition, THE MCP_Host SHALL apply the startup behavior in Requirement 2 to that definition.

### Requirement 2 — Start and initialize enabled stdio servers

**User Story:** As a Developer, I want each enabled stdio server initialized independently, so that a problem in one configured server does not prevent other servers from becoming available.

#### Acceptance Criteria

1. WHEN MCP_Host starts an enabled Stdio_Server, THE MCP_Host SHALL spawn an argument vector whose first element is the configured `command` and whose remaining elements are the configured `args` in configured order with every element boundary preserved.
2. WHEN MCP_Host starts an enabled Stdio_Server, THE MCP_Host SHALL overlay the definition's configured `env` string entries on the inherited process environment while retaining every unrelated inherited environment entry.
3. WHEN MCP_Host starts an enabled Stdio_Server, THE MCP_Host SHALL set the spawned process working directory to Workspace_Root.
4. WHEN a Server_Session connects, THE MCP_Host SHALL send an MCP `initialize` request.
5. WHILE the corresponding valid `initialize` response has not been received for a Server_Session's `initialize` request, THE MCP_Host SHALL send neither `notifications/initialized` nor `tools/list` on that Server_Session.
6. WHEN a server requests the MCP roots list for an initialized Server_Session, THE MCP_Host SHALL return Workspace_Root as that session's workspace root.
7. WHEN MCP_Host receives the corresponding valid `initialize` response, THE MCP_Host SHALL send `notifications/initialized` on that Server_Session.
8. WHEN MCP_Host sends `notifications/initialized` after the corresponding valid `initialize` response, THE MCP_Host SHALL send `tools/list` on that Server_Session.
9. IF process spawning fails, THEN THE MCP_Host SHALL set that server's Server_Status to `error` with a reason identifying the server `id` and the spawn-failure category.
10. IF Initialize_Handshake fails before the configured startup timeout expires, THEN THE MCP_Host SHALL set that server's Server_Status to `error` with a reason identifying the server `id` and the handshake-failure category.
11. IF the configured startup timeout expires before Initialize_Handshake completes, THEN THE MCP_Host SHALL set that server's Server_Status to `error` with a reason identifying the server `id` and the startup-timeout category.
12. IF MCP_Host created a process before startup failed, THEN THE MCP_Host SHALL terminate and reap that process before completing the failed startup outcome.
13. IF process spawning or Initialize_Handshake fails, THEN THE MCP_Host SHALL close every other resource created for that failed Server_Session.
14. WHEN one enabled Stdio_Server fails to start or initialize, THE MCP_Host SHALL continue startup for every other enabled Stdio_Server.

### Requirement 3 — Limit live v1 transport to stdio

**User Story:** As a Developer, I want configured transport status to reflect actual v1 support, so that an SSE or HTTP definition is visible without appearing connected.

#### Acceptance Criteria

1. WHERE an enabled MCP_Server_Definition has Transport `stdio`, THE MCP_Host SHALL attempt to open a live Server_Session for that definition.
2. WHERE an MCP_Server_Definition has `disabled` equal to true, THE MCP_Host SHALL assign Server_Status `stopped` without opening a Server_Session.
3. WHERE an enabled MCP_Server_Definition has Transport `sse` or `http`, THE MCP_Host SHALL assign Server_Status `stopped` without opening a Server_Session.
4. WHERE an enabled MCP_Server_Definition has Transport `sse` or `http`, THE Settings_MCP_Section SHALL keep the definition visible with its configured Transport and `stopped` status.
5. THE MCP_Host SHALL treat an Unsupported_Live_Server as a normal configured state rather than a configuration error or Server_Crash.
6. THE MCP_Host SHALL make zero network connection attempts and zero network request attempts for every Unsupported_Live_Server in v1.
7. IF an enabled Stdio_Server fails to spawn or complete Initialize_Handshake, THEN THE MCP_Host SHALL apply the failure handling defined in Requirement 2.

### Requirement 4 — Discover and aggregate server tools

**User Story:** As a Developer, I want initialized servers' tools combined without name collisions, so that the agent can address the correct server even when bare tool names repeat.

#### Acceptance Criteria

1. THE MCP_Host SHALL assign every discovered MCP_Tool a Namespaced_Tool_Name qualified by its owning server `id` and bare tool name.
2. WHEN two servers return the same bare tool name, THE MCP_Host SHALL assign those tools distinct Namespaced_Tool_Names.
3. THE MCP_Host SHALL retain each discovered tool's exact owning server `id`, exact bare name, exact input schema, and exact description when the server supplies a description.
4. WHEN Tool_Discovery succeeds, THE MCP_Host SHALL atomically replace only the owning server's aggregated MCP_Tool subset with the returned MCP_Tools.
5. WHEN Tool_Discovery succeeds, THE MCP_Host SHALL set the owning server's Server_Status to `running`.
6. WHEN Tool_Discovery returns an empty tool list, THE MCP_Host SHALL atomically remove every stale MCP_Tool belonging to that server while keeping that server's Server_Status `running`.
7. IF Tool_Discovery returns an invalid response, fails, or exceeds the configured discovery timeout, THEN THE MCP_Host SHALL remove every aggregated MCP_Tool belonging to that server.
8. IF Tool_Discovery returns an invalid response, fails, or exceeds the configured discovery timeout, THEN THE MCP_Host SHALL set that server's Server_Status to `error` and close that server's Server_Session.
9. IF Tool_Discovery returns an invalid response, fails, or exceeds the configured discovery timeout, THEN THE MCP_Host SHALL leave every other server's Server_Session, Server_Status, and MCP_Tool subset unchanged.

### Requirement 5 — Expose tools additively through the existing agent toolset

**User Story:** As a Developer, I want discovered MCP tools available through the agent's existing tool path, so that generic MCP support does not replace native or fixed tools.

#### Acceptance Criteria

1. THE MCP_Host SHALL expose every aggregated MCP_Tool to Agent_Toolset under its Namespaced_Tool_Name.
2. THE MCP_Host SHALL expose every aggregated MCP_Tool's input schema to Agent_Toolset.
3. WHEN the aggregated MCP_Tool set changes, THE MCP_Host SHALL update the generic MCP entries in Agent_Toolset to match the current aggregated set.
4. WHEN MCP_Host adds or removes generic MCP entries in Agent_Toolset, THE Gateway SHALL leave every non-MCP Agent_Toolset entry unchanged.
5. THE MCP_Host SHALL expose MCP_Tools through Agent_Toolset without adding a second model-facing tool transport.
6. THE Gateway SHALL retain the existing fixed `mcp::web::search` and `mcp::github` tools alongside generic MCP_Tools.
7. WHEN generic MCP_Tools are added or removed, THE Gateway SHALL preserve the existing `MCPGateway` result, timeout, process-termination, and typed-error behavior for `mcp::web::search` and `mcp::github`.

### Requirement 6 — Proxy calls to the owning server

**User Story:** As a Developer, I want each MCP call routed to its owning server with a bounded, typed outcome, so that one failed call does not fail the run.

#### Acceptance Criteria

1. WHEN the agent invokes an available Namespaced_Tool_Name after satisfaction of Requirement 7, THE MCP_Host SHALL send exactly one `tools/call` containing the mapped bare tool name and supplied arguments over the mapped owning Server_Session.
2. WHEN the agent invokes an available Namespaced_Tool_Name, THE MCP_Host SHALL send no `tools/call` for that invocation to any Server_Session other than the mapped owning Server_Session.
3. WHEN the owning server returns a valid `tools/call` response, THE MCP_Host SHALL return exactly one successful result attributed to the owning server and invoked MCP_Tool.
4. IF the agent invokes a Namespaced_Tool_Name absent from the aggregated available set, THEN THE MCP_Host SHALL return exactly one typed unavailable result without sending a request to a server.
5. IF `tools/call` fails or exceeds the configured per-call wall-clock timeout, THEN THE MCP_Host SHALL return exactly one typed failure identifying the owning server and invoked MCP_Tool.
6. IF the owning Server_Session is unavailable before an invocation or fails during an in-flight Tool_Call, THEN THE MCP_Host SHALL return exactly one typed failure identifying the owning server and invoked MCP_Tool.
7. IF an invocation is unavailable, fails, times out, or loses its owning Server_Session, THEN THE MCP_Host SHALL include no partial content from that invocation in its typed result.
8. WHEN MCP_Host returns a typed unavailable or failure result, THE MCP_Host SHALL contain the condition without raising an unhandled error into the agent run.
9. WHEN one Tool_Call returns a typed unavailable or failure result, THE MCP_Host SHALL preserve results from previously completed independent Tool_Call invocations.

### Requirement 7 — Require approval for non-auto-approved calls

**User Story:** As a Developer, I want approval required for every MCP tool I have not explicitly auto-approved, so that configured servers cannot perform untrusted actions without a decision.

#### Acceptance Criteria

1. WHEN an MCP_Tool's bare name is an exact, case-sensitive, whole-string member of its owning server's AutoApprove_List, THE MCP_Host SHALL proxy the Tool_Call without emitting an Approval_Event.
2. WHERE an owning server's AutoApprove_List is absent or empty, THE MCP_Host SHALL classify every MCP_Tool owned by that server as non-auto-approved.
3. WHEN an MCP_Tool's bare name is not an exact, case-sensitive, whole-string member of its owning server's AutoApprove_List, THE MCP_Host SHALL emit an Approval_Event before sending `tools/call`.
4. WHEN MCP_Host emits an Approval_Event for an MCP_Tool, THE MCP_Host SHALL identify the owning server `id`, Namespaced_Tool_Name, and requested arguments in the approval prompt.
5. WHILE a non-auto-approved Tool_Call lacks an explicit approve or reject decision for the waiting run, THE MCP_Host SHALL keep that invocation pending in the Trust_Gate.
6. WHILE a Tool_Call remains pending in the Trust_Gate, THE MCP_Host SHALL send no `tools/call` request for that invocation.
7. WHEN the Decision_Channel receives `kind: "approval"` and `decision: "approve"` for the waiting run after a complete Approval_Event satisfying criterion 4, THE MCP_Host SHALL proxy the waiting Tool_Call.
8. IF the Decision_Channel receives `kind: "approval"` and `decision: "reject"` for the waiting run, THEN THE MCP_Host SHALL return a typed declined result without sending `tools/call`.
9. IF an Approval_Event omits any approval-prompt detail required by criterion 4, THEN THE MCP_Host SHALL treat the Trust_Gate as unsatisfied and send no `tools/call` for that invocation.
10. THE MCP_Host SHALL use the per-tool AutoApprove_List as the only configuration-based approval bypass for MCP_Tools.
11. WHERE an MCP_Server_Definition contains a field named `trusted`, THE MCP_Host SHALL apply the AutoApprove_List and Trust_Gate without treating `trusted` as an approval bypass.

### Requirement 8 — Contain server crashes

**User Story:** As a Developer, I want a crashed MCP server isolated from the rest of my run, so that other tools and the agent remain usable.

#### Acceptance Criteria

1. WHEN a Server_Crash occurs, THE MCP_Host SHALL set the affected server's Server_Status to `error` with a recorded reason identifying the server `id` and the triggering crash category.
2. WHEN a Server_Crash occurs, THE MCP_Host SHALL remove only the affected server's MCP_Tools from the aggregated set and Agent_Toolset.
3. WHEN a Server_Crash occurs, THE MCP_Host SHALL leave every other server's Server_Session, Server_Status, and MCP_Tools unchanged.
4. WHEN a Server_Crash occurs, THE MCP_Host SHALL preserve the availability and outcomes of Tool_Calls owned by every unaffected server.
5. WHEN a Server_Crash occurs, THE MCP_Host SHALL keep the current agent run active.
6. IF a Tool_Call is in flight when its owning server crashes, THEN THE MCP_Host SHALL resolve that call exactly once with the typed failure required by Requirement 6.
7. IF the agent invokes a removed tool after its owning server crashes, THEN THE MCP_Host SHALL return the typed unavailable result required by Requirement 6.
8. WHEN Settings_MCP_Section displays a server with Server_Status `error`, THE Settings_MCP_Section SHALL display the recorded error reason belonging to that same server `id`.

### Requirement 9 — Preserve host security boundaries

**User Story:** As a maintainer, I want user-configured processes and MCP output handled as untrusted inputs, so that MCP support does not create shell-injection, resource-leak, approval-bypass, or prompt-control behavior.

#### Acceptance Criteria

1. WHEN MCP_Host spawns a Stdio_Server, THE MCP_Host SHALL directly invoke the configured executable with every configured argument preserved as a separate argument-vector element and without a shell command string.
2. WHEN MCP_Host sends `tools/call`, THE MCP_Host SHALL enforce the configured per-call wall-clock timeout.
3. WHEN a Server_Session closes or a server stops, THE MCP_Host SHALL terminate and reap the associated process.
4. WHEN MCP_Host stops, THE MCP_Host SHALL terminate and reap every process started by MCP_Host.
5. WHEN a server returns MCP_Tool output, THE Gateway SHALL incorporate that output into model context only as untrusted tool-result data attributed to the owning server and tool.
6. WHEN MCP_Tool output contains text formatted as an approval, decision, or MCP_Host control message, THE Gateway SHALL retain the text's classification as untrusted tool-result data rather than treating the text as a control-plane message.
7. IF MCP_Tool output contains text suggesting configuration changes, approval, process spawning, or another Tool_Call, THEN THE Gateway SHALL enforce every applicable ordinary configuration control, Request_Admission rule, and Trust_Gate requirement before executing the suggested action.

### Requirement 10 — Protect every MCP route with Gateway admission

**User Story:** As a maintainer, I want all MCP control routes behind the existing Gateway admission policy, so that a process-spawning endpoint is not exposed without the established guard.

#### Acceptance Criteria

1. THE Gateway SHALL apply `require_admission` to every `/v1/mcp/*` route.
2. IF Request_Admission rejects a `/v1/mcp/*` request, THEN THE Gateway SHALL return HTTP 401 before executing the route handler.
3. IF Request_Admission rejects a `/v1/mcp/*` request, THEN THE Gateway SHALL perform no process, MCP request, network request, configuration, session, status, or toolset side effect because of that HTTP request.
4. WHILE Gateway is bound to a non-loopback interface, THE Gateway SHALL admit a `/v1/mcp/*` request only when the presented token exactly matches the configured shared token.
5. THE Gateway SHALL serve `/v1/mcp/*` routes on the existing Gateway listener without creating an additional listening interface.

### Requirement 11 — Test a candidate server without changing live state

**User Story:** As a Developer, I want to test a server definition before relying on it, so that I can diagnose startup and discovery without adding the candidate to the live toolset.

#### Acceptance Criteria

1. THE MCP_Test_Endpoint SHALL accept one candidate MCP_Server_Definition in the body of `POST /v1/mcp/test`.
2. IF the candidate definition is invalid, THEN THE MCP_Test_Endpoint SHALL return a validation failure without starting a process, sending an MCP message, or making a network connection or request.
3. WHEN MCP_Test_Endpoint receives a valid candidate Stdio_Server, THE MCP_Test_Endpoint SHALL perform candidate startup, then Initialize_Handshake, then Tool_Discovery in that order within the endpoint timeout.
4. WHEN candidate startup, Initialize_Handshake, and Tool_Discovery succeed, THE MCP_Test_Endpoint SHALL return a success outcome containing discovered tool count and bare tool names.
5. WHEN successful candidate Tool_Discovery returns zero tools, THE MCP_Test_Endpoint SHALL return a successful outcome with a discovered tool count of zero.
6. IF candidate startup, Initialize_Handshake, or Tool_Discovery fails or times out, THEN THE MCP_Test_Endpoint SHALL return a failure outcome containing the failure reason.
7. WHEN MCP_Test_Endpoint receives an SSE or HTTP candidate, THE MCP_Test_Endpoint SHALL return an unsupported-in-v1 outcome without making a network connection or request.
8. WHEN MCP_Test_Endpoint completes a stdio candidate test, THE MCP_Test_Endpoint SHALL terminate and reap the candidate process before returning the endpoint response.
9. IF the candidate process cannot be terminated and reaped, THEN THE MCP_Test_Endpoint SHALL return a failure outcome identifying the cleanup failure.
10. WHILE a candidate stdio test executes, THE MCP_Test_Endpoint SHALL keep the candidate process, candidate connection, and discovered candidate tools isolated from MCP_Host's live state even when the candidate `id` equals a live server `id`.
11. WHEN candidate handling finishes, THE MCP_Test_Endpoint SHALL leave Workspace_MCP_Config, MCP_Config, live Server_Sessions, Server_Status values, aggregated MCP_Tools, and Agent_Toolset unchanged by the candidate test.

### Requirement 12 — Reuse command events for MCP run-feed rows

**User Story:** As a Developer, I want MCP calls marked with their owning server in the run feed, so that I can distinguish MCP activity from native command activity.

#### Acceptance Criteria

1. WHEN MCP_Host proxies a Tool_Call, THE MCP_Host SHALL emit a Command_Event whose `command` identifies the exact invoked Namespaced_Tool_Name and whose MCP_Server_Id_Field contains the exact owning server `id`.
2. THE Python Event_Contract SHALL define optional and nullable `mcp_server_id` on `CommandEvent` with wire alias `mcpServerId`.
3. THE TypeScript Event_Contract SHALL define optional and nullable `mcpServerId` on `CommandEvent` compatibly with the Python wire contract.
4. WHEN MCP_Server_Id_Field is omitted or null, THE Python and TypeScript Event_Contracts SHALL accept the Command_Event.
5. THE Event_Contract SHALL retain `command` as the event kind for MCP Tool_Calls without adding an MCP-specific event kind.
6. WHEN CommandRow receives a Command_Event with a non-null MCP_Server_Id_Field, THE Run_Feed SHALL display an MCP badge and the exact owning server `id` on that row.
7. WHEN CommandRow receives a Command_Event with MCP_Server_Id_Field omitted or null, THE Run_Feed SHALL preserve the existing native command-row presentation without an MCP badge.
8. THE Run_Feed SHALL render MCP Command_Events through the existing `command` entry in `ROW_COMPONENTS`.

### Requirement 13 — Manage and observe servers in Settings

**User Story:** As a Developer, I want to view, configure, test, enable, disable, and auto-approve MCP servers in Settings, so that routine MCP management does not require manual JSON editing.

#### Acceptance Criteria

1. THE Settings_MCP_Section SHALL list every MCP_Server_Definition in MCP_Config, including disabled definitions and Unsupported_Live_Servers.
2. THE Settings_MCP_Section SHALL show each listed server's `id`, Transport, `scope`, `disabled` state, AutoApprove_List, and Server_Status.
3. WHEN the Developer selects Transport `stdio` in the add or edit form, THE Settings_MCP_Section SHALL present the `command`, `args`, and `env` fields applicable to stdio.
4. WHEN the Developer selects Transport `sse` or `http` in the add or edit form, THE Settings_MCP_Section SHALL present the `url` field applicable to the selected remote Transport.
5. THE Settings_MCP_Section SHALL provide `id`, Transport, `disabled`, and AutoApprove_List fields for add and edit operations.
6. WHEN the Developer submits a valid new definition, THE Settings_MCP_Section SHALL write that complete definition to Workspace_MCP_Config.
7. WHEN the Developer edits an existing definition, THE Settings_MCP_Section SHALL write the complete edited definition to Workspace_MCP_Config.
8. WHEN Settings_MCP_Section writes any server change, THE Settings_MCP_Section SHALL replace only the targeted Workspace_MCP_Config entry and preserve every other workspace entry unchanged.
9. WHEN the Developer edits a user-scoped definition, THE Settings_MCP_Section SHALL create a complete workspace-scoped override with the same server `id` rather than modifying User_MCP_Config.
10. WHEN the Developer toggles a server's enabled state, THE Settings_MCP_Section SHALL update `disabled` in its Workspace_MCP_Config definition or complete workspace override.
11. WHEN the Developer adds or removes a bare tool name from AutoApprove_List, THE Settings_MCP_Section SHALL update `autoApprove` in its Workspace_MCP_Config definition or complete workspace override.
12. WHEN Settings_MCP_Section writes a server change successfully, THE Settings_MCP_Section SHALL request MCP_Config reload.
13. WHEN a server change write and the requested MCP_Config reload both succeed, THE Settings_MCP_Section SHALL display the resulting Server_Status.
14. IF validation, a server change write, or the requested MCP_Config reload fails, THEN THE Settings_MCP_Section SHALL display the operation failure without presenting Server_Status as refreshed by that operation.
15. WHEN the Developer activates Test connection, THE Settings_MCP_Section SHALL send the currently displayed definition, including unsaved candidate values, to MCP_Test_Endpoint and display its outcome.
16. WHEN the Developer activates Test connection, THE Settings_MCP_Section SHALL perform no Workspace_MCP_Config write and request no MCP_Config reload because of the test.
17. WHEN a Test connection outcome is displayed, THE Settings_MCP_Section SHALL leave every listed server's displayed Server_Status unchanged by the test.
18. THE Settings_MCP_Section SHALL represent Server_Status using only `running`, `stopped`, or `error`.

### Requirement 14 — Provide bundled web search

**User Story:** As a Developer, I want a bundled web-search MCP tool, so that the agent can retrieve current public web results without external server configuration.

#### Acceptance Criteria

1. THE Web_Search_Server SHALL expose MCP_Tool `web_search` with required non-empty string `query` and optional positive integer `max_results` defaulting to 5.
2. WHEN `web_search` receives valid input, THE Web_Search_Server SHALL query the DuckDuckGo Instant Answer API first without requiring an API key.
3. THE Web_Search_Server SHALL classify a retrieved search result entry as usable only when `title`, `url`, and `snippet` are non-empty strings.
4. WHEN `web_search` returns a search result entry, THE Web_Search_Server SHALL include `title`, `url`, and `snippet` string fields in that entry.
5. WHEN more usable results exist than `max_results`, THE Web_Search_Server SHALL return no more than `max_results` entries.
6. IF DuckDuckGo Instant Answer retrieval fails, parsing fails, or produces zero usable result entries, THEN THE Web_Search_Server SHALL retrieve and parse DuckDuckGo's HTTP results page as the fallback source.
7. WHEN Web_Search_Server performs either retrieval path, THE Web_Search_Server SHALL use `httpx`.
8. WHEN Web_Search_Server performs either retrieval path, THE Web_Search_Server SHALL complete retrieval without launching a browser.
9. IF fallback retrieval fails, fallback parsing fails, or fallback parsing produces zero usable result entries, THEN THE Web_Search_Server SHALL return a typed tool failure identifying the requested query.

### Requirement 15 — Provide bundled documentation tools

**User Story:** As a Developer, I want bundled documentation and package-metadata tools, so that the agent can retrieve reference text without external MCP server setup.

#### Acceptance Criteria

1. THE Docs_Server SHALL expose MCP_Tool `fetch_docs` with required string `url`.
2. WHEN `fetch_docs` retrieves a page and regular-expression HTML markup removal succeeds, THE Docs_Server SHALL return the retrieved page as text with HTML markup removed.
3. IF `fetch_docs` retrieves a page but regular-expression HTML markup removal processing fails, THEN THE Docs_Server SHALL return the retrieved page text unchanged.
4. THE Docs_Server SHALL expose MCP_Tool `search_npm` with required string `package`.
5. WHEN `search_npm` finds the requested package, THE Docs_Server SHALL return exactly the package's `version`, `description`, and `readme` fields.
6. THE Docs_Server SHALL expose MCP_Tool `search_pypi` with required string `package`.
7. WHEN `search_pypi` finds the requested package, THE Docs_Server SHALL return exactly the package's `version` and `description` fields.
8. WHEN a Docs_Server tool retrieves a remote resource, THE Docs_Server SHALL use `httpx`.
9. IF a Docs_Server retrieval fails or the requested package is absent, THEN THE Docs_Server SHALL return a typed tool failure identifying the requested resource or package.

### Requirement 16 — Provide workspace-confined git history

**User Story:** As a Developer, I want bundled local git-history tools confined to my workspace, so that the agent can inspect repository history without escaping the active project.

#### Acceptance Criteria

1. THE Git_History_Server SHALL expose MCP_Tool `git_log` with optional string `path` and positive integer `n` defaulting to 10.
2. WHEN `git_log` receives `path`, THE Git_History_Server SHALL limit returned history to the canonically resolved workspace path supplied by `path`.
3. WHEN `git_log` succeeds, THE Git_History_Server SHALL return no more than `n` commit log entries.
4. THE Git_History_Server SHALL expose MCP_Tool `git_blame` with required string `file`, positive integer `line_start`, and positive integer `line_end`, where both line values are 1-based and inclusive.
5. IF `line_start` exceeds `line_end`, THEN THE Git_History_Server SHALL return a typed tool failure without invoking git.
6. WHEN `git_blame` succeeds, THE Git_History_Server SHALL return blame output for the requested 1-based inclusive line range.
7. THE Git_History_Server SHALL expose MCP_Tool `git_show` with required string `sha`.
8. WHEN `git_show` succeeds, THE Git_History_Server SHALL return the commit metadata and patch text produced for the requested commit identifier.
9. WHEN a Git_History_Server tool invokes git, THE Git_History_Server SHALL execute the local `git` binary from an argument vector with working directory Workspace_Root.
10. WHEN a Git_History_Server tool receives a parameter that denotes a filesystem path, THE Git_History_Server SHALL canonically resolve that parameter against Workspace_Root before invoking git.
11. IF canonical resolution fails or a filesystem-path parameter resolves outside Workspace_Root, THEN THE Git_History_Server SHALL return a typed tool failure for the current invocation before invoking git.
12. THE Git_History_Server SHALL apply the confinement checks in criteria 10 and 11 independently to every supplied filesystem-path parameter of the current invocation, including `git_log.path` and `git_blame.file`.
13. WHEN a confinement check fails for one invocation, THE Git_History_Server SHALL preserve the availability and outcomes of unrelated Git_History_Server invocations.
14. IF the git process fails to start, THEN THE Git_History_Server SHALL return a typed tool failure for the current invocation.
15. IF a git subprocess exits with non-zero status, THEN THE Git_History_Server SHALL return a typed tool failure containing the git error output for the current invocation.
16. WHEN a git process fails to start or exits with non-zero status for one invocation, THE Git_History_Server SHALL preserve the availability and outcomes of unrelated Git_History_Server invocations.
17. THE Git_History_Server SHALL inspect only the local repository reachable from Workspace_Root without contacting a remote git service.

### Requirement 17 — Register and auto-approve bundled servers

**User Story:** As a Developer, I want the bundled servers registered and trusted per tool out of the box, so that their tools work without initial setup or repetitive approval cards.

#### Acceptance Criteria

1. THE Default_Config SHALL include enabled Stdio_Server definitions for Web_Search_Server, Docs_Server, and Git_History_Server.
2. THE Default_Config SHALL list `web_search` in Web_Search_Server's AutoApprove_List.
3. THE Default_Config SHALL list `fetch_docs`, `search_npm`, and `search_pypi` in Docs_Server's AutoApprove_List.
4. THE Default_Config SHALL list `git_log`, `git_blame`, and `git_show` in Git_History_Server's AutoApprove_List.
5. WHEN MCP_Host loads Default_Config and discovers the bundled tools, THE MCP_Host SHALL invoke those tools without Approval_Event according to Requirement 7.
6. WHEN the Developer removes a bundled tool's bare name from AutoApprove_List and MCP_Config reload succeeds, THE MCP_Host SHALL apply the non-auto-approved Trust_Gate behavior in Requirement 7 to subsequent calls of that tool.
7. WHERE Default_Config contains additional MCP_Server_Definitions, THE Default_Config SHALL retain the three bundled definitions and their listed AutoApprove_List entries.
8. THE Default_Config SHALL register no filesystem MCP server.
9. THE Default_Config SHALL add the bundled definitions without removing or renaming the fixed `mcp::web::search` and `mcp::github` tools.

### Requirement 18 — Preserve stdio JSON-RPC framing round trips

**User Story:** As a maintainer, I want stdio framing to preserve complete JSON-RPC messages, so that host and server messages are not split, merged, or corrupted.

#### Acceptance Criteria

1. WHEN MCP_Host sends a JSON_RPC_Message to a Stdio_Server, THE MCP_Host SHALL encode exactly one JSON serialization of that message followed by one newline terminator, with no embedded newline in the serialization.
2. WHEN MCP_Host reads a complete Stdio_Framing line from a Stdio_Server, THE MCP_Host SHALL decode exactly one JSON_RPC_Message from that line.
3. THE Stdio_Framing encoder and decoder SHALL produce a JSON_RPC_Message equal to the original under JSON_Value_Equality for every valid JSON_RPC_Message encoded and then decoded.
4. IF MCP_Host reads a complete line that is malformed or does not contain exactly one valid JSON_RPC_Message, THEN THE MCP_Host SHALL discard that line while keeping the Server_Session open.
5. WHEN a Stdio_Server reaches unexpected end-of-file on its output stream, THE MCP_Host SHALL apply the Server_Crash behavior in Requirement 8.
