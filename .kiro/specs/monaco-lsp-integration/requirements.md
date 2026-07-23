# Requirements Document

## Introduction

This feature integrates Language Server Protocol (LSP) support into the Monaco editor in the Zoc Studio frontend and hardens the existing Gateway LSP proxy that backs it.

On the frontend, a new `apps/frontend/src/features/editor/lsp/` module set (`lsp-connection.ts`, `lsp-client.ts`, `lsp-registry.ts`) connects Monaco to language servers through the Gateway WebSocket route `GET /v1/lsp/{server_name}/ws`, using `monaco-languageclient` and `vscode-ws-jsonrpc` (neither of which is currently a declared dependency). Language servers start on demand when a matching file opens and shut down when no matching file remains open. Each language exposes a single connection-state indicator in the global status bar, and the editor gains Go to Definition (F12), Find References (Shift+F12), Rename Symbol (F2), and hover tooltips.

On the backend, the Gateway proxy in `services/gateway/src/zocai_gateway/routes/lsp.py` already exists, is wired into the app at `/v1/lsp/{server_name}/ws`, and is unit-tested: it allowlists three servers (`typescript-language-server`, `pyright`, `rust-analyzer`), spawns them over stdio, pumps JSON-RPC both directions, injects the workspace `rootUri`/`rootPath`/`workspaceFolders` into `initialize`, and terminates the subprocess when the socket closes. This feature hardens that proxy so it surfaces a clear error state to the client (instead of closing silently) when a subprocess exits abnormally or a server binary is missing, while preserving the existing loopback-only bind, shared-token admission, allowlist, workspace pinning, and `Protocol`-based unit-test seams. It also extends the existing setup automation (`Makefile` `install`/`doctor` targets and `scripts/`) to install and verify the three server binaries and to report a clear message when one is missing from `PATH`.

## Glossary

- **Frontend**: The `apps/frontend` TypeScript application that embeds the Monaco editor.
- **Editor**: The Monaco editor integration inside the Frontend.
- **LSP_Connection**: The `apps/frontend/src/features/editor/lsp/lsp-connection.ts` module — a WebSocket transport to the Gateway LSP proxy that reconnects with exponential backoff, following the shape of `apps/frontend/src/lib/index-progress.ts`.
- **LSP_Client**: The `apps/frontend/src/features/editor/lsp/lsp-client.ts` module — registers and manages `MonacoLanguageClient` instances over an LSP_Connection.
- **LSP_Registry**: The `apps/frontend/src/features/editor/lsp/lsp-registry.ts` module — maps editor language ids to server names and owns per-language server lifecycle.
- **LSP_Status_Formatter**: A pure function, following the formatter pattern in `apps/frontend/src/lib/status-bar.ts`, that derives a display label and Language_Server_State for a language server independently of any React component.
- **LSP_Status_Indicator**: The per-language connection-state indicator rendered in the global status bar alongside the existing indicators.
- **Language_Server_State**: One of `starting`, `connected`, or `error`.
- **Language_Id**: The value of the `language` field on `OpenFile` in `apps/frontend/src/lib/store.ts` (for example `typescript`, `javascript`, `python`, `rust`).
- **Server_Name**: An allowlisted logical language-server name (`typescript-language-server`, `pyright`, or `rust-analyzer`).
- **MonacoLanguageClient**: The client, provided by the `monaco-languageclient` package, that speaks LSP to a language server over an injected transport.
- **LSP_Proxy**: The Gateway module `services/gateway/src/zocai_gateway/routes/lsp.py`.
- **Gateway**: The FastAPI sidecar in `services/gateway` that binds the loopback interface, applies shared-token request admission, and hosts the LSP_Proxy WebSocket route `/v1/lsp/{server_name}/ws`.
- **Server_Allowlist**: The mapping (`LSP_SERVERS`) of permitted Server_Name values to the fixed argv used to launch each server over stdio.
- **Workspace_Root**: The resolved workspace root directory the Gateway pins each spawned language server to.
- **Setup_Automation**: The repository `Makefile` targets (for example `install` and `doctor`) and the `scripts/` helpers they invoke.
- **Server_Binary**: The executable a Server_Name resolves to on the system `PATH` (`typescript-language-server`, `pyright-langserver`, or `rust-analyzer`).
- **Application_Close_Code**: A WebSocket close code in the application-private range (4000–4999) that signals a specific LSP_Proxy outcome; the existing unknown-server code is 4004.

## Requirements

### Requirement 1 — LSP WebSocket connection with reconnect and backoff

**User Story:** As a developer using the editor, I want the language-server connection to reconnect automatically after transient drops, so that language features recover without a manual reload.

#### Acceptance Criteria

1. WHEN the LSP_Registry requests a connection for a Server_Name, THE LSP_Connection SHALL resolve the Gateway port via `resolveAgentPort` and open a WebSocket to `ws://127.0.0.1:{port}/v1/lsp/{server_name}/ws`.
2. WHEN a WebSocket connection opens, THE LSP_Connection SHALL reset its reconnect delay to 500 milliseconds.
3. IF an established WebSocket connection closes without being disposed by the caller, THEN THE LSP_Connection SHALL schedule a reconnection after the current reconnect delay and then set the next delay to the smaller of double the current delay and 5000 milliseconds.
4. WHEN the caller disposes an LSP_Connection, THE LSP_Connection SHALL cancel any pending reconnection timer and close the WebSocket.
5. WHILE an LSP_Connection is disposed, THE LSP_Connection SHALL ignore reconnection triggers.
6. THE LSP_Connection SHALL accept an injected socket factory so the transport can be unit tested without a live WebSocket.

> Rationale (deliberate): Disposal is authoritative. Criterion 4 cancels the pending reconnect timer on dispose and criterion 5 ignores later reconnection triggers, so no scheduled reconnection can reopen a socket after teardown — mirroring the disposed-flag pattern in `apps/frontend/src/lib/index-progress.ts`.

### Requirement 2 — On-demand language-server lifecycle

**User Story:** As a developer, I want a language server to start automatically when I open a matching file and shut down when no matching file remains open, so that I get language features without manual toggles and without idle servers consuming resources.

#### Acceptance Criteria

1. THE LSP_Registry SHALL map the Language_Id values `typescript`, `typescriptreact`, `javascript`, and `javascriptreact` to the Server_Name `typescript-language-server`, the Language_Id `python` to the Server_Name `pyright`, and the Language_Id `rust` to the Server_Name `rust-analyzer`.
2. WHEN a file opens whose Language_Id maps to a Server_Name that has no running server, THE LSP_Registry SHALL start a server for that Server_Name.
3. WHEN a file opens whose Language_Id maps to a Server_Name that already has a running server, THE LSP_Registry SHALL reuse the existing server for that Server_Name.
4. WHEN the last open file whose Language_Id maps to a running server is closed, THE LSP_Registry SHALL shut down that server and dispose its LSP_Connection.
5. THE LSP_Registry SHALL maintain at most one running server per Server_Name.
6. IF a file opens whose Language_Id maps to no Server_Name, THEN THE LSP_Registry SHALL leave language-server state unchanged.

### Requirement 3 — Monaco language-client registration

**User Story:** As a developer, I want Monaco wired to the language servers through MonacoLanguageClient, so that language intelligence is available in the editor.

#### Acceptance Criteria

1. THE Frontend SHALL declare `monaco-languageclient` and `vscode-ws-jsonrpc` as dependencies in `apps/frontend/package.json`.
2. WHEN the LSP_Registry starts a server, THE LSP_Client SHALL register one MonacoLanguageClient for that server over an LSP_Connection using `monaco-languageclient` and `vscode-ws-jsonrpc`.
3. WHEN a MonacoLanguageClient is registered, THE LSP_Client SHALL send the LSP `initialize` request over its LSP_Connection.
4. WHEN the LSP_Registry shuts down a server, THE LSP_Client SHALL stop and dispose the MonacoLanguageClient registered for that server.
5. THE LSP_Client SHALL register at most one MonacoLanguageClient per Server_Name.

### Requirement 4 — Editor language features

**User Story:** As a developer, I want Go to Definition, Find References, Rename Symbol, and hover tooltips, so that I can navigate and refactor code in the editor.

#### Acceptance Criteria

1. WHEN the developer invokes Go to Definition (F12) on a symbol in a file whose Server_Name has a connected server, THE Editor SHALL request the definition location from the language server and navigate to the returned location.
2. WHEN the developer invokes Find References (Shift+F12) on a symbol in a file whose Server_Name has a connected server, THE Editor SHALL request references from the language server and present the returned locations.
3. WHEN the developer invokes Rename Symbol (F2) on a symbol in a file whose Server_Name has a connected server, THE Editor SHALL request a rename from the language server and apply the returned workspace edits.
4. WHEN the developer hovers over a symbol in a file whose Server_Name has a connected server, THE Editor SHALL request hover information from the language server and display the returned tooltip.
5. IF the active file's Language_Id maps to no Server_Name, THEN THE Editor SHALL operate that file without language-server features.
6. IF the active file's Language_Id maps to a Server_Name whose server is not currently connected, THEN THE Editor SHALL operate that file without language-server features until that server reconnects.

### Requirement 5 — Per-language status indicator in the global status bar

**User Story:** As a developer, I want one connection-state indicator per language in the global status bar, so that I can see each language server's state at a glance.

#### Acceptance Criteria

1. THE LSP_Status_Formatter SHALL derive a display label and a Language_Server_State from a language server's connection state as a pure function independent of any React component.
2. WHILE a language server is starting or reconnecting, THE LSP_Status_Indicator SHALL display that language's indicator in the `starting` state.
3. WHEN a language server's connection is established, THE LSP_Status_Indicator SHALL display that language's indicator in the `connected` state.
4. IF a language server fails to start or its connection reports an error, THEN THE LSP_Status_Indicator SHALL display that language's indicator in the `error` state.
5. THE LSP_Status_Indicator SHALL display at most one indicator per Language_Id in the global status bar, regardless of how many editor tabs of that Language_Id are open.
6. WHEN a language server shuts down because no matching file remains open, THE LSP_Status_Indicator SHALL remove that language's indicator from the global status bar.
7. THE LSP_Status_Indicator SHALL reflect each Language_Server_State change immediately, without debouncing.

### Requirement 6 — Gateway resilience and clear error signaling

**User Story:** As a developer, I want the Gateway proxy to signal a clear error when a language server crashes, its stream drops, or its binary is missing, so that the client can show an accurate state and recover instead of hanging on a silent close.

#### Acceptance Criteria

1. WHEN a new WebSocket connection is established for an allowlisted Server_Name, THE LSP_Proxy SHALL spawn a fresh language-server subprocess for that connection.
2. IF the Server_Binary for a requested Server_Name is not found on the system `PATH`, THEN THE LSP_Proxy SHALL close the WebSocket with a distinct Application_Close_Code that signals the server is not installed, without raising an unhandled subprocess-spawn error.
3. IF a language-server subprocess exits while its WebSocket is still open, THEN THE LSP_Proxy SHALL close the WebSocket with a distinct Application_Close_Code that signals abnormal server termination.
4. WHEN an LSP_Proxy WebSocket connection closes for any reason, THE LSP_Proxy SHALL terminate the associated language-server subprocess.
5. WHEN an LSP_Connection observes the abnormal-server-termination Application_Close_Code, THE LSP_Connection SHALL apply the reconnect-and-backoff policy defined in Requirement 1.
6. WHEN an LSP_Connection observes the server-not-installed Application_Close_Code, THE LSP_Connection SHALL stop reconnecting and report the `error` Language_Server_State for that Server_Name.
7. IF a language-server subprocess fails to spawn for a reason other than a missing Server_Binary (for example a permission error), THEN THE LSP_Proxy SHALL close the WebSocket with the abnormal-server-termination Application_Close_Code rather than the server-not-installed Application_Close_Code.

### Requirement 7 — Preserve Gateway security and testability

**User Story:** As a maintainer, I want the hardened proxy to keep its loopback bind, token admission, allowlist, workspace pinning, and unit-test seams, so that hardening does not widen the attack surface or break existing tests.

#### Acceptance Criteria

1. IF a WebSocket LSP request is not admitted by the Gateway request-admission policy, THEN THE Gateway SHALL close the WebSocket without spawning a language server.
2. THE LSP_Proxy SHALL spawn a language server only when the requested Server_Name is present in the Server_Allowlist.
3. IF a requested Server_Name is absent from the Server_Allowlist, THEN THE LSP_Proxy SHALL close the WebSocket with the unknown-server Application_Close_Code before spawning any subprocess.
4. THE LSP_Proxy SHALL pin each spawned language server's working directory to the Workspace_Root.
5. WHEN the LSP_Proxy forwards an `initialize` request, THE LSP_Proxy SHALL set `rootUri`, `rootPath`, and `workspaceFolders` on that request to the Workspace_Root.
6. THE LSP_Proxy SHALL expose the WebSocket and the subprocess as injectable seams so the hardened proxy can be unit tested with in-memory fakes and no real Server_Binary.

> Rationale (deliberate): Criterion 1 is a security invariant. A WebSocket request rejected by Gateway admission is closed without spawning a language server, so unauthorized requests cannot consume server resources.

### Requirement 8 — Setup automation and missing-binary discoverability

**User Story:** As a developer setting up the project, I want a setup command that installs and verifies the three language-server binaries and a clear report when one is missing, so that language features work without manual guesswork.

#### Acceptance Criteria

1. THE Setup_Automation SHALL provide a target that installs `pyright` (providing `pyright-langserver`) via pip, `typescript-language-server` via npm, and `rust-analyzer` via cargo or a downloaded binary.
2. WHEN the `doctor` target runs, THE Setup_Automation SHALL report the presence or absence on the system `PATH` of `pyright-langserver`, `typescript-language-server`, and `rust-analyzer`.
3. IF a Server_Binary is absent from the system `PATH` AND that Server_Binary's install command is known, THEN THE Setup_Automation SHALL report both the missing Server_Binary and the command that installs that Server_Binary.
4. THE Setup_Automation SHALL implement the install and verification behavior by extending the existing `Makefile` targets and `scripts/` helpers.
5. THE Setup_Automation SHALL leave the LSP_Proxy runtime behavior unchanged.
6. THE Setup_Automation SHALL report a Server_Binary as missing only when THE Setup_Automation can also provide that Server_Binary's install command.
