# Requirements Document

## Introduction

This feature completes **Part 3 — LSP / IDE Integration** by delivering the two capabilities that the completed `monaco-lsp-integration` spec did not cover:

- **3.2 — LSP Diagnostics → Problems Panel**: surface the diagnostics a language server publishes (`textDocument/publishDiagnostics`) in the existing Problems panel, alongside the diagnostics that command-line checkers already produce.
- **3.3 — Inline Agent-Assisted (AI) Completions**: offer ghost-text code completions inside the Monaco editor, backed by a new Gateway completion endpoint that calls the active model.

### Current state — what already exists vs. what is net-new

**3.1 (Monaco ↔ LSP wiring) is complete and out of scope.** The `monaco-lsp-integration` spec is implemented end to end. It provides, under `apps/frontend/src/features/editor/lsp/`, the WebSocket transport (`lsp-connection.ts`, with reconnect + backoff), the per-server `MonacoLanguageClient` manager (`lsp-client.ts`, `createLspClient`), the on-demand server lifecycle (`lsp-registry.ts`), per-language status indicators (`lsp-status.ts` / `LspStatusIndicators.tsx`), the Monaco service layer (`monaco-services.ts`), and the hardened Gateway proxy `routes/lsp.py` that spawns `typescript-language-server` / `pyright` / `rust-analyzer` over a loopback-only, shared-token-admitted WebSocket at `/v1/lsp/{server_name}/ws`. **This feature builds on that layer; it does not modify or re-specify it.**

**3.2 already has a Problems panel wired to a different source.** `apps/frontend/src/features/problems/ProblemsPanel.tsx` is fully built. It renders diagnostics from the Zustand `diagnostics` slice (`useApp((s) => s.diagnostics)`), grouped by file, with error/warning severity counts, click-to-open, and severity icons. Those diagnostics come from command-line checkers (`tsc`, `eslint`, `ruff`, `cargo`) via `runDiagnostics(kind, cwd)` and are parsed by `@/lib/problem-matchers`, which defines the `Diagnostic` shape (`{ source, file, line, column, severity, message, code? }`), `countBySeverity`, `CheckKind`, and `Severity`. The panel is **not** wired to LSP today. The net-new work in 3.2 is: intercept the LSP `publishDiagnostics` notification, map each LSP diagnostic onto the existing `Diagnostic` shape, feed them into the existing `diagnostics` slice per document URI so they coexist with the command-checker diagnostics, render through the existing panel, add a source-agnostic count badge, clear diagnostics for deleted files on `fs://changed`, navigate to the exact line/column on click, and offer a "Run agent to fix N errors" action that pre-fills the Composer.

**3.3 is entirely net-new.** There is no Monaco inline-completions provider today, and the Gateway `routes/` directory contains only `lsp.py` (and a superseded `_lsp_orig_check.py`) — there is no `completions.py`. The net-new work in 3.3 is: a frontend `InlineCompletionsProvider` (`apps/frontend/src/features/editor/inline-completions.ts`) registered against the Monaco instance captured in `MonacoView.tsx`, and a Gateway `POST /v1/completions` endpoint (`routes/completions.py`) that builds a fill-in-the-middle prompt, calls the active model through `model_runtime`, streams the result back, falls back for non-FIM models, and caches recent completions.

### Scope boundaries

- **In scope:** 3.2 (LSP diagnostics into the Problems panel) and 3.3 (inline AI completions), as one coherent feature.
- **Out of scope (owned by other specs):** `monaco-lsp-integration` (3.1 — the LSP client and Gateway LSP proxy), `agent-reasoning-engine` (Part 1), and `advanced-context-engine` (Part 2). Requirements here reuse those specs' outputs but do not restate or change them.

### Reuse constraints

- Reuse the existing `Diagnostic` model (`@/lib/problem-matchers.ts`) and the existing `diagnostics` store slice (`setDiagnostics` / `clearDiagnostics`), extending them only as needed to tag and replace diagnostics by source (LSP vs. checker) and per document URI.
- Route the model call for completions through `model_runtime` (the same module the agent reasoning path uses via `generate_text` / `generate_text_stream`).
- Serve `POST /v1/completions` behind the Gateway's existing loopback bind and shared-token request admission (`require_admission` / `is_request_admitted`), the same admission every other Gateway route relies on (see `monaco-lsp-integration` Requirement 7). No unauthenticated endpoint is introduced.

## Glossary

- **Developer**: A person editing code in the Zoc Studio frontend.
- **Frontend**: The `apps/frontend` TypeScript application that embeds the Monaco editor.
- **Editor**: The Monaco editor integration in `apps/frontend/src/features/editor/MonacoView.tsx`.
- **Gateway**: The FastAPI sidecar in `services/gateway` that binds the loopback interface, applies shared-token request admission, and hosts the control/telemetry routes.
- **Request_Admission**: The Gateway request-admission policy implemented by `is_request_admitted` and applied as the `require_admission` FastAPI dependency: on a loopback binding a request is admitted, and on a non-loopback binding a request is admitted only when it presents the valid shared token.
- **LSP_Client**: The existing `apps/frontend/src/features/editor/lsp/lsp-client.ts` module (from `monaco-lsp-integration`) that manages one `MonacoLanguageClient` per Server_Name.
- **Server_Name**: An allowlisted logical language-server name (`typescript-language-server`, `pyright`, or `rust-analyzer`), as defined by `monaco-lsp-integration`.
- **Language_Id**: The `language` field on an `OpenFile` in `apps/frontend/src/lib/store.ts` (for example `typescript`, `python`, `rust`).
- **Publish_Diagnostics_Notification**: An LSP `textDocument/publishDiagnostics` notification received over an LSP_Client connection, carrying a document `uri` and an array of LSP diagnostics.
- **LSP_Diagnostic_Severity**: The LSP severity integer on an LSP diagnostic, one of `1` (Error), `2` (Warning), `3` (Information), or `4` (Hint).
- **LSP_Diagnostics_Bridge**: The net-new logic (in `lsp-client.ts`) that intercepts each Publish_Diagnostics_Notification, maps its LSP diagnostics onto the Diagnostic_Model, and writes them into the Diagnostics_Store.
- **Diagnostic_Model**: The existing `Diagnostic` interface in `@/lib/problem-matchers.ts`: `{ source: string, file: string, line: number, column: number, severity: Severity, message: string, code?: string }`, where `Severity` is one of `error`, `warning`, `info`, `hint`.
- **Diagnostics_Store**: The Zustand `diagnostics` slice, `Record<string, Diagnostic[]>` keyed by a source string, with the actions `setDiagnostics(source, items)` and `clearDiagnostics(source?)`.
- **Command_Checker**: A command-line checker (`tsc`, `eslint`, `ruff`, or `cargo`) whose output `runDiagnostics` parses into Diagnostic_Model entries under a source key (`typescript`, `eslint`, `ruff`, `cargo`).
- **Problems_Panel**: The existing `apps/frontend/src/features/problems/ProblemsPanel.tsx` that renders the Diagnostics_Store grouped by file.
- **Problems_Badge**: The count badge on the Bottom_Dock "Problems" tab (`apps/frontend/src/components/layout/BottomDock.tsx`) and the diagnostics indicator in the status bar (`StatusBar.tsx`).
- **FS_Changed_Event**: The `fs://changed` Tauri event the frontend subscribes to via `onFsChanged` (`apps/frontend/src/lib/tauri-bridge.ts`); its payload is a list of absolute filesystem paths that changed within the watcher's debounce window.
- **Deleted_File**: A path reported by an FS_Changed_Event that no longer exists on the filesystem.
- **Composer**: The agent message composer, `apps/frontend/src/features/agent/Composer.tsx`, whose draft text is the store `input` field set by `setInput`, with mode controlled by `setAgentMode`.
- **Inline_Completions_Provider**: The net-new `apps/frontend/src/features/editor/inline-completions.ts` module implementing `monaco.languages.InlineCompletionsProvider`.
- **Ghost_Text**: The inline, non-committed completion preview Monaco renders at the cursor for an inline completion.
- **Completions_Endpoint**: The net-new Gateway route `POST /v1/completions` in `services/gateway/src/zocai_gateway/routes/completions.py`.
- **Model_Runtime**: The `zocai_gateway.model_runtime` module (`generate_text`, `generate_text_stream`) used to call the active model.
- **FIM**: Fill-in-the-middle — a completion mode where the model receives the code before and after the cursor and produces the text between them.
- **FIM_Prompt**: A fill-in-the-middle prompt of the form `<PRE>{prefix}<SUF>{suffix}<MID>`.
- **Completion_Cache**: An in-process, time-bounded cache in the Completions_Endpoint keyed by the `(prefix, suffix, model)` tuple.

## Requirements

### Requirement 1 — Intercept and map LSP diagnostics (3.2)

**User Story:** As a Developer, I want the diagnostics my language server reports to appear in the Problems panel, so that I see type errors and lint findings from the language server, not only from command-line checkers.

#### Acceptance Criteria

1. WHEN the LSP_Client receives a Publish_Diagnostics_Notification, THE LSP_Diagnostics_Bridge SHALL map each LSP diagnostic in that notification to one Diagnostic_Model entry.
2. WHEN the LSP_Diagnostics_Bridge maps an LSP diagnostic, THE LSP_Diagnostics_Bridge SHALL set the Diagnostic_Model `severity` from the LSP_Diagnostic_Severity as follows: `1` to `error`, `2` to `warning`, `3` to `info`, and `4` to `hint`.
3. IF an LSP diagnostic omits its LSP_Diagnostic_Severity, THEN THE LSP_Diagnostics_Bridge SHALL set the Diagnostic_Model `severity` to `error`.
4. WHEN the LSP_Diagnostics_Bridge maps an LSP diagnostic, THE LSP_Diagnostics_Bridge SHALL set the Diagnostic_Model `line` to the LSP diagnostic `range.start.line` plus one and the `column` to the LSP diagnostic `range.start.character` plus one.
5. WHEN the LSP_Diagnostics_Bridge maps an LSP diagnostic, THE LSP_Diagnostics_Bridge SHALL set the Diagnostic_Model `file` to the absolute filesystem path that the notification `uri` identifies, the `message` to the LSP diagnostic message, the `source` to the LSP diagnostic `source` value, and the `code` to the LSP diagnostic `code` value rendered as a string.
6. IF an LSP diagnostic omits the `source` value, THEN THE LSP_Diagnostics_Bridge SHALL set the Diagnostic_Model `source` to the Server_Name that produced the notification.
7. IF an LSP diagnostic omits the `code` value, THEN THE LSP_Diagnostics_Bridge SHALL leave the Diagnostic_Model `code` unset.

### Requirement 2 — Coexistence of LSP and command-checker diagnostics (3.2)

**User Story:** As a Developer, I want LSP diagnostics and command-checker diagnostics to appear together without overwriting each other, so that I keep a complete picture of every problem in my code.

#### Acceptance Criteria

1. WHEN the LSP_Diagnostics_Bridge writes the mapped diagnostics for a document `uri` into the Diagnostics_Store, THE LSP_Diagnostics_Bridge SHALL store them under a store entry that is distinct per document `uri` and distinct from every Command_Checker source key.
2. WHEN the LSP_Diagnostics_Bridge receives a later Publish_Diagnostics_Notification for a document `uri` that carries one or more diagnostics, THE LSP_Diagnostics_Bridge SHALL replace the stored LSP diagnostics for that `uri` with the newly mapped diagnostics, so that no diagnostic from the prior notification for that `uri` remains.
3. WHEN the LSP_Diagnostics_Bridge replaces or clears the stored LSP diagnostics for one document `uri`, THE LSP_Diagnostics_Bridge SHALL leave the stored LSP diagnostics for every other document `uri` unchanged.
4. WHEN the LSP_Diagnostics_Bridge writes, replaces, or clears LSP diagnostics, THE LSP_Diagnostics_Bridge SHALL leave every Command_Checker source entry in the Diagnostics_Store unchanged.
5. WHEN a Publish_Diagnostics_Notification for a document `uri` carries an empty diagnostics array, THE LSP_Diagnostics_Bridge SHALL clear the stored LSP diagnostics for that `uri`.
6. THE Problems_Panel SHALL render the LSP diagnostics and the Command_Checker diagnostics as one list grouped by file, such that all diagnostics sharing the same `file` — including diagnostics originating from an LSP store entry and diagnostics originating from a Command_Checker source entry — appear together under that file's single group, with each entry showing its own `source`.

> Rationale (deliberate): The Diagnostics_Store keys diagnostics by a source string and `setDiagnostics` replaces a whole entry. Criteria 1–4 give LSP diagnostics a per-`uri` store entry so a new notification for one document replaces only that document's LSP diagnostics, never another document's and never a Command_Checker entry — the "per-URI, per-source replace" coexistence the design must preserve.

### Requirement 3 — Navigate to the exact line and column on click (3.2)

**User Story:** As a Developer, I want clicking a diagnostic to take me to the exact line and column, so that I can jump straight to the problem instead of scrolling to find it.

#### Acceptance Criteria

1. WHEN the Developer clicks a diagnostic entry in the Problems_Panel, THE Problems_Panel SHALL open the file identified by that diagnostic's `file` in the Editor.
2. WHEN the Developer clicks a diagnostic entry in the Problems_Panel, THE Editor SHALL scroll so that the clicked diagnostic's `line` is visible within the Editor viewport, where `line` 1 denotes the first line of the file.
3. WHEN the Developer clicks a diagnostic entry in the Problems_Panel, THE Editor SHALL place the text cursor at the clicked diagnostic's `line` and `column`, where `line` 1 denotes the first line of the file and `column` 1 denotes the first character position on that line.
4. WHILE the file identified by a clicked diagnostic's `file` is already open in the Editor, WHEN the Developer clicks that diagnostic entry in the Problems_Panel, THE Problems_Panel SHALL make that file the active file in the Editor without reloading its contents.

### Requirement 4 — Problems count badge (3.2)

**User Story:** As a Developer, I want a count badge on the Problems tab that reflects all outstanding problems, so that I can gauge how many errors and warnings remain at a glance.

#### Acceptance Criteria

1. WHILE the Diagnostics_Store holds at least one `error`-severity or `warning`-severity diagnostic, THE Problems_Badge SHALL display a count equal to the total number of `error`-severity and `warning`-severity diagnostics (excluding `info`-severity and `hint`-severity diagnostics) summed across every per-document-`uri` LSP source entry and every Command_Checker source entry in the Diagnostics_Store.
2. WHILE the Diagnostics_Store holds at least one `error`-severity or `warning`-severity diagnostic, THE Problems_Badge SHALL be visible.
3. WHILE the Diagnostics_Store holds at least one `error`-severity diagnostic, THE Problems_Badge SHALL render in the error color.
4. WHILE the Diagnostics_Store holds one or more `warning`-severity diagnostics and no `error`-severity diagnostic, THE Problems_Badge SHALL render in the warning color.
5. WHILE the Diagnostics_Store holds no `error`-severity and no `warning`-severity diagnostic, THE Problems_Badge SHALL be hidden.
6. WHEN the Diagnostics_Store changes, THE Problems_Badge SHALL update its displayed count, color, and visibility to reflect the current Diagnostics_Store contents.

### Requirement 5 — Clear diagnostics for deleted files (3.2)

**User Story:** As a Developer, I want diagnostics for a deleted file to disappear, so that the Problems panel does not keep reporting problems in files that no longer exist.

#### Acceptance Criteria

1. WHEN the Frontend starts the diagnostics feature, THE LSP_Diagnostics_Bridge SHALL subscribe to FS_Changed_Events via `onFsChanged`.
2. WHEN an FS_Changed_Event reports one or more Deleted_Files, THE LSP_Diagnostics_Bridge SHALL clear, for each of those Deleted_Files, the stored LSP diagnostics whose `file` equals that Deleted_File path.
3. IF a path reported by an FS_Changed_Event still exists on the filesystem, THEN THE LSP_Diagnostics_Bridge SHALL leave the stored LSP diagnostics whose `file` equals that path unchanged.
4. WHEN the LSP_Diagnostics_Bridge clears the stored LSP diagnostics for a Deleted_File, THE LSP_Diagnostics_Bridge SHALL leave the stored LSP diagnostics whose `file` is not that Deleted_File unchanged.
5. WHEN the LSP_Diagnostics_Bridge unsubscribes from FS_Changed_Events, THE LSP_Diagnostics_Bridge SHALL leave the stored LSP diagnostics unchanged in response to any FS_Changed_Event received after that unsubscription.

### Requirement 6 — "Run agent to fix N errors" Composer pre-fill (3.2)

**User Story:** As a Developer, I want a one-click action to hand a file's errors to the agent, so that I can ask the agent to fix them without composing the prompt myself.

#### Acceptance Criteria

1. WHILE a file's diagnostics in the Problems_Panel include at least one `error`-severity diagnostic, THE Problems_Panel SHALL present a "Run agent to fix N errors" action for that file, where N is the count of that file's `error`-severity diagnostics.
2. WHEN the Developer activates the "Run agent to fix N errors" action for a file, THE Problems_Panel SHALL set the Composer `input` (via `setInput`), replacing any existing draft text, to a prompt that identifies that file by its `file` path and enumerates each of that file's `error`-severity diagnostics, showing each such diagnostic's `line`, `column`, and `message`.
3. WHEN the Developer activates the "Run agent to fix N errors" action for a file, THE Problems_Panel SHALL omit from the Composer `input` prompt every `warning`-severity, `info`-severity, and `hint`-severity diagnostic for that file.
4. WHEN the Developer activates the "Run agent to fix N errors" action, THE Composer SHALL switch to Agent mode (via `setAgentMode`).
5. WHEN the Problems_Panel pre-fills the Composer for the "Run agent to fix N errors" action, THE Problems_Panel SHALL leave the pre-filled prompt editable so the Developer can modify it before submitting it.
6. WHEN the Problems_Panel pre-fills the Composer for the "Run agent to fix N errors" action, THE Problems_Panel SHALL leave the pre-filled prompt as an unsent draft, sending no message to the agent until the Developer submits it.

### Requirement 7 — Graceful behavior without a connected language server (3.2)

**User Story:** As a Developer, I want the Problems panel to keep working when a language has no connected server, so that command-checker diagnostics and the panel remain usable even without LSP.

#### Acceptance Criteria

1. IF the active file's Language_Id maps to no Server_Name, or maps to a Server_Name whose language server is not connected, THEN THE LSP_Diagnostics_Bridge SHALL add no LSP diagnostics for that file to the Diagnostics_Store.
2. WHILE a Language_Id has no connected language server, THE LSP_Diagnostics_Bridge SHALL leave every Command_Checker source entry in the Diagnostics_Store unchanged.
3. WHILE a Language_Id has no connected language server, THE Problems_Panel SHALL render the Command_Checker diagnostics held in the Diagnostics_Store.
4. WHILE the Diagnostics_Store contains zero Diagnostic_Model entries across all LSP source entries and all Command_Checker source entries, THE Problems_Panel SHALL display its empty state.

### Requirement 8 — Inline completions provider and debounce (3.3)

**User Story:** As a Developer, I want inline completion suggestions as I type, without a request on every keystroke, so that I get helpful suggestions without flooding the model with requests.

#### Acceptance Criteria

1. WHEN the Editor mounts and the Monaco instance is captured, THE Frontend SHALL register the Inline_Completions_Provider with that Monaco instance.
2. WHEN 400 milliseconds elapse after the Developer's most recent keystroke with no further keystroke in that interval and at least one of the prefix and the suffix at the cursor is non-empty, THE Inline_Completions_Provider SHALL request exactly one completion from the Completions_Endpoint.
3. WHEN the Developer performs a further keystroke before the 400-millisecond interval elapses, THE Inline_Completions_Provider SHALL restart the 400-millisecond interval from that keystroke and SHALL make no completion request for the interrupted interval.
4. IF the Inline_Completions_Provider's automatic debounce trigger fires AND both the prefix and the suffix at the cursor are empty, THEN THE Inline_Completions_Provider SHALL make no completion request; this restriction applies only to the automatic debounce trigger and does not prevent an explicitly-invoked completion request.

### Requirement 9 — Completion request payload and cancellation (3.3)

**User Story:** As a Developer, I want each completion request to carry just enough surrounding code and to be abandoned when I keep typing, so that suggestions are relevant and stale requests do not waste work.

#### Acceptance Criteria

1. WHEN the Inline_Completions_Provider requests a completion, THE Inline_Completions_Provider SHALL send as the prefix the up-to-500 characters immediately preceding the cursor (all preceding characters when fewer than 500 exist), as the suffix the up-to-200 characters immediately following the cursor (all following characters when fewer than 200 exist), the editor Language_Id, and the file path.
2. IF the Developer types in a way that changes the completion context (the prefix or suffix at the cursor) before the in-flight completion request responds, THEN THE Inline_Completions_Provider SHALL cancel the in-flight completion request.
3. IF a completion response arrives for a request that was cancelled, THEN THE Inline_Completions_Provider SHALL discard that response and SHALL present no Ghost_Text from it, even after the Developer has stopped typing.

### Requirement 10 — Ghost text and Tab to accept (3.3)

**User Story:** As a Developer, I want to preview a completion as ghost text and accept it with Tab, so that I can adopt a suggestion with a single keystroke or ignore it by continuing to type.

#### Acceptance Criteria

1. WHEN the Completions_Endpoint first returns non-empty completion text for the current request, THE Editor SHALL display that completion text as Ghost_Text at the cursor and SHALL display a "Tab to accept" hint together with that Ghost_Text.
2. WHILE the Completions_Endpoint streams completion tokens for the current request, THE Inline_Completions_Provider SHALL append each streamed token to the Ghost_Text at the cursor in the order the tokens are received.
3. WHILE Ghost_Text is displayed, WHEN the Developer presses Tab, THE Editor SHALL insert the completion text currently shown as Ghost_Text at the cursor without inserting a tab character, SHALL place the cursor at the end of the inserted text, and SHALL dismiss the Ghost_Text and its "Tab to accept" hint.
4. WHILE Ghost_Text is displayed, WHEN the Developer types any character other than Tab or moves the cursor, THE Editor SHALL dismiss the Ghost_Text and its "Tab to accept" hint without inserting the completion text.

### Requirement 11 — Gateway fill-in-the-middle completion endpoint (3.3)

**User Story:** As a Developer, I want the completion endpoint to prompt the model with the code around my cursor, so that suggestions fit the surrounding code.

#### Acceptance Criteria

1. THE Completions_Endpoint SHALL accept a `POST /v1/completions` request whose required parameters are the prefix, the suffix, the Language_Id, and the file path, each provided as a string value, where the prefix and the suffix may each be an empty string.
2. IF a `POST /v1/completions` request omits the prefix, the suffix, the Language_Id, or the file path, or provides any of those parameters as a value that is not a string, THEN THE Completions_Endpoint SHALL reject the request with an error response that identifies the missing or invalid parameter, without calling the Model_Runtime.
3. WHEN the Completions_Endpoint handles a valid request AND the active model supports FIM, THE Completions_Endpoint SHALL construct a FIM_Prompt of the form `<PRE>{prefix}<SUF>{suffix}<MID>` from the request prefix and suffix.
4. WHEN the Completions_Endpoint calls the active model, THE Completions_Endpoint SHALL pass to the Model_Runtime a temperature of 0.1, a maximum of 128 completion tokens, and at least one stop sequence.
5. WHEN the Completions_Endpoint calls the active model, THE Completions_Endpoint SHALL route the call through the Model_Runtime call path used by the agent reasoning features (`generate_text` / `generate_text_stream`) rather than through a separate model transport.

### Requirement 12 — Stream completions over Server-Sent Events (3.3)

**User Story:** As a Developer, I want completions to stream token by token, so that I see the first characters of a suggestion quickly instead of waiting for the whole completion.

#### Acceptance Criteria

1. WHEN the Completions_Endpoint produces completion text, THE Completions_Endpoint SHALL stream that text to the client as a sequence of Server-Sent Events, each event carrying a plain-text token chunk, in the order the model emits the tokens.
2. WHEN the model emits its first completion token, THE Completions_Endpoint SHALL send that token to the client as its own Server-Sent Event, without waiting for any subsequent token and before the completion finishes.
3. WHEN the model finishes the completion, THE Completions_Endpoint SHALL send to the client, after the final token chunk, an end-of-stream signal that is distinct from the token chunks.
4. IF the completion contains no tokens, THEN THE Completions_Endpoint SHALL send no token chunk and SHALL send the end-of-stream signal to the client immediately upon detecting the empty completion, without waiting for any completion timeout.

### Requirement 13 — Fallback for non-FIM models (3.3)

**User Story:** As a Developer using a cloud model without fill-in-the-middle support, I want completions to still work, so that inline suggestions are available regardless of the active model.

#### Acceptance Criteria

1. WHEN the Completions_Endpoint handles a valid request AND the active model does not support FIM, THE Completions_Endpoint SHALL build a "complete this code" prompt from the prefix and the suffix instead of a FIM_Prompt.
2. WHEN the Completions_Endpoint calls the model with the fallback prompt, THE Completions_Endpoint SHALL apply temperature 0.1 and a maximum of 128 completion tokens, the same values applied on the FIM path.
3. WHEN the Completions_Endpoint streams the fallback completion, THE Completions_Endpoint SHALL stream the completion to the client as Server-Sent Events, the same streaming transport used on the FIM path.

### Requirement 14 — Completion cache (3.3)

**User Story:** As a Developer, I want identical completion requests to return instantly for a short time, so that repeated requests at the same cursor position do not re-invoke the model.

#### Acceptance Criteria

1. WHEN the Completions_Endpoint finishes producing a non-empty completion for a `(prefix, suffix, model)` tuple by calling the Model_Runtime, THE Completions_Endpoint SHALL store that completion in the Completion_Cache keyed by that tuple.
2. IF the Completions_Endpoint produces an empty completion for a `(prefix, suffix, model)` tuple, THEN THE Completions_Endpoint SHALL NOT store an entry for that tuple in the Completion_Cache.
3. WHEN the Completions_Endpoint receives a request whose `(prefix, suffix, model)` tuple has a Completion_Cache entry aged less than 30 seconds since it was stored, THE Completions_Endpoint SHALL return that cached completion without calling the Model_Runtime.
4. WHEN the Completions_Endpoint returns a cached completion for a `(prefix, suffix, model)` tuple, THE Completions_Endpoint SHALL leave that entry's age unchanged.
5. WHEN the Completions_Endpoint receives a request whose `(prefix, suffix, model)` tuple has a Completion_Cache entry aged 30 seconds or more since it was stored, THE Completions_Endpoint SHALL recompute the completion by calling the Model_Runtime instead of returning that aged entry.

### Requirement 15 — Endpoint stays behind loopback and token admission (3.3)

**User Story:** As a maintainer, I want the completion endpoint to reuse the Gateway's loopback bind and shared-token admission, so that adding it does not open an unauthenticated network surface.

#### Acceptance Criteria

1. THE Completions_Endpoint SHALL apply the same Request_Admission dependency (`require_admission`) that every other Gateway route applies.
2. IF a request to the Completions_Endpoint is not admitted by Request_Admission, THEN THE Gateway SHALL reject the request and return a response indicating the request was not admitted.
3. WHILE the Gateway is bound to a non-loopback interface, THE Completions_Endpoint SHALL admit a request only when that request presents the valid shared token.
4. THE Completions_Endpoint SHALL be served only over the Gateway's existing loopback bind, introducing no additional listening interface.
5. IF a request to the Completions_Endpoint is not admitted by Request_Admission, THEN THE Completions_Endpoint SHALL NOT invoke the Model_Runtime.

> Rationale (deliberate): The Completions_Endpoint is network-exposed and calls the active model. Criteria 1–5 reuse the same admission every Gateway route depends on (see `monaco-lsp-integration` Requirement 7), so the new endpoint cannot become an unauthenticated entry point.

### Requirement 16 — Completion resilience and non-blocking editing (3.3)

**User Story:** As a Developer, I want completions to fail quietly and never get in the way of typing, so that an unavailable model or a slow request never blocks my editing.

#### Acceptance Criteria

1. IF the Model_Runtime reports no configured provider or model, THEN THE Completions_Endpoint SHALL return an empty completion (a completion carrying no text), signaling end of stream without reporting an error to the client.
2. IF the Model_Runtime raises an error before the first completion token is sent to the client, THEN THE Completions_Endpoint SHALL return an empty completion (a completion carrying no text), signaling end of stream without reporting an error to the client.
3. WHEN the Inline_Completions_Provider receives an empty completion (a completion carrying no text), THE Inline_Completions_Provider SHALL present no Ghost_Text and no "Tab to accept" hint.
4. WHILE a completion request is in flight, THE Editor SHALL accept and apply each of the Developer's keystrokes to the document independently of that request, without blocking, delaying, or discarding any keystroke pending the completion response.
5. IF the Model_Runtime raises an error after one or more completion tokens have been sent to the client, THEN THE Completions_Endpoint SHALL stop producing further completion text and signal end of stream without reporting an error to the client.
