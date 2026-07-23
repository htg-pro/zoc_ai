# Implementation Plan: Monaco LSP Integration

## Overview

This plan wires the Monaco editor to real language servers through the Gateway
LSP proxy and hardens that proxy so failures surface as clear, recoverable
states. It follows the layering in `design.md`: **transport**
(`lsp-connection.ts`), **protocol** (`lsp-client.ts`), and **lifecycle**
(`lsp-registry.ts`) on the frontend, plus additive hardening of
`services/gateway/src/zocai_gateway/routes/lsp.py` and setup automation in
`Makefile` + `scripts/`.

Tasks are ordered so foundational pure modules land before the code that depends
on them, and each property/unit test accompanies the code it covers. Pure
functions (`lsp-registry.ts`, `lsp-status.ts`) come first, then the transport,
then the `monaco-languageclient` adapter, then store/registry/indicator wiring,
then editor lifecycle wiring; the gateway is hardened and tested in parallel; and
setup automation and a final verification gate close it out.

All property tests use `fast-check` on the frontend and generator-driven
`asyncio.run` tests on the gateway, run a minimum of 100 iterations, and are
tagged `Feature: monaco-lsp-integration, Property {n}: {property_text}` per the
design's testing strategy. New frontend modules live under
`apps/frontend/src/features/editor/lsp/`; their tests are co-located in
`apps/frontend/src/features/editor/lsp/__tests__/*.prop.test.ts`.

## Tasks

- [ ] 1. Declare frontend LSP dependencies
  - [ ] 1.1 Add `monaco-languageclient` and `vscode-ws-jsonrpc` to `apps/frontend/package.json`
    - Add both to `dependencies`, pinned against the installed `monaco-editor@^0.55`; run the workspace install (`pnpm install`) to update the lockfile
    - _Requirements: 3.1_

  - [ ]* 1.2 Write smoke test asserting the dependencies are declared
    - Assert `monaco-languageclient` and `vscode-ws-jsonrpc` are present in `apps/frontend/package.json` `dependencies` (design "Smoke (3.1)")
    - _Requirements: 3.1_

- [ ] 2. Implement the language→server registry pure core (`apps/frontend/src/features/editor/lsp/lsp-registry.ts`)
  - [ ] 2.1 Implement `LANGUAGE_SERVERS`, `serverForLanguage`, `requiredServers`, `activeLanguageIds`, and `reconcile`
    - Define `ServerName` and the `LANGUAGE_SERVERS` map (`typescript`/`typescriptreact`/`javascript`/`javascriptreact` → `typescript-language-server`, `python` → `pyright`, `rust` → `rust-analyzer`)
    - `serverForLanguage` returns `undefined` for unmapped ids; `requiredServers` returns the distinct set of mapped servers; `activeLanguageIds` returns distinct mapped language ids; `reconcile(running, required)` returns disjoint `start`/`stop` arrays (running-and-required servers are reused, not restarted)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [ ]* 2.2 Write example test locking the language→server mappings
    - Assert the six mappings from 2.1 and that an unmapped id yields `undefined` (design "serverForLanguage example")
    - _Requirements: 2.1_

  - [ ]* 2.3 Write property test for server lifecycle reconciliation
    - **Property 5: Server lifecycle reconciliation** — over arbitrary open-file arrays, the running set after applying `reconcile` equals exactly `requiredServers(openFiles)`; set-valued (at most one per `Server_Name`); unmapped languages excluded
    - Use `fast-check`, min 100 iterations, tag `Feature: monaco-lsp-integration, Property 5: Server lifecycle reconciliation`
    - **Validates: Requirements 2.2, 2.4, 2.5, 2.6**

  - [ ]* 2.4 Write property test for idempotent reuse
    - **Property 6: Reuse is idempotent** — `reconcile(required, required)` yields empty `start` and empty `stop` for any required set
    - Use `fast-check`, min 100 iterations, tag `Feature: monaco-lsp-integration, Property 6: Reuse is idempotent`
    - **Validates: Requirements 2.3**

- [ ] 3. Implement the status formatter pure core (`apps/frontend/src/features/editor/lsp/lsp-status.ts`)
  - [ ] 3.1 Implement `formatLspStatus`, `lspIndicatorViews`, `isLspActive`, and the `LspStatusView` type
    - `formatLspStatus(languageId, state)` returns `{ languageId, label, state, tone }` with a non-empty label (reusing language display labels, `status-bar.ts` style) and tone `ok`/`error`/`busy`
    - `lspIndicatorViews(openFiles, serverStates)` returns one view per distinct mapped `Language_Id` (via `activeLanguageIds`/`serverForLanguage` from `lsp-registry.ts`), defaulting missing state to `starting`
    - `isLspActive(languageId, serverStates)` is true iff the mapped server's state is `connected`
    - _Requirements: 4.5, 4.6, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [ ]* 3.2 Write property test for status view derivation
    - **Property 9: Status view derivation** — for every `Language_Server_State`, `formatLspStatus` yields a non-empty label and a display state/tone that is `busy` for starting/reconnecting, `ok` for connected, `error` for error
    - Use `fast-check`, min 100 iterations, tag `Feature: monaco-lsp-integration, Property 9: Status view derivation`
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4**

  - [ ]* 3.3 Write property test for the LSP-feature gate
    - **Property 8: LSP features are gated on a connected server** — over arbitrary language ids and server-state maps, `isLspActive` is true iff the id maps to a `Server_Name` whose state is `connected`
    - Use `fast-check`, min 100 iterations, tag `Feature: monaco-lsp-integration, Property 8: LSP features are gated on a connected server`
    - **Validates: Requirements 4.5, 4.6**

  - [ ]* 3.4 Write property test for one indicator per open Language_Id
    - **Property 10: One indicator per open Language_Id** — over arbitrary open-file arrays, `lspIndicatorViews` returns exactly one view per distinct mapped `Language_Id` and none for unmapped ids or ids with no open file
    - Use `fast-check`, min 100 iterations, tag `Feature: monaco-lsp-integration, Property 10: One indicator per open Language_Id`
    - **Validates: Requirements 5.5, 5.6**

- [ ] 4. Implement the WebSocket transport with backoff (`apps/frontend/src/features/editor/lsp/lsp-connection.ts`)
  - [ ] 4.1 Implement `openLspConnection`, `lspConnectionUrl`, close-code constants, and the `LspSocket`/`LspSocketFactory`/`LspConnection` types
    - Export `ABNORMAL_SERVER_TERMINATION_CLOSE_CODE = 4050`, `SERVER_NOT_INSTALLED_CLOSE_CODE = 4041` (mirrors `lsp.py`), `INITIAL_RECONNECT_MS = 500`, `MAX_RECONNECT_MS = 5000`, and `LanguageServerState`
    - Resolve the port via `resolveAgentPort` (`apps/frontend/src/lib/agent-port.ts`) and build `ws://127.0.0.1:{port}/v1/lsp/{server_name}/ws`; accept an injected `socketFactory` defaulting to the real `WebSocket`
    - Reset delay to 500ms on open; on undisposed close, schedule reconnect after the current delay then set next delay to `min(2 × current, 5000)`; treat `4041` as terminal (`stopped`, report `error`, no reconnect) and any other close as backoff reconnect; drive `onOpen`/`onClose`/`onState`
    - Make the authoritative `disposed` flag cancel the pending timer and close the socket, and ignore all later close/reconnect triggers (mirrors `index-progress.ts`)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 5.2, 5.3, 5.4, 6.5, 6.6_

  - [ ]* 4.2 Write property test for the connection URL
    - **Property 1: Connection URL** — for arbitrary ports and allowlisted server names, the socket opens at exactly `ws://127.0.0.1:{port}/v1/lsp/{server_name}/ws` using the port from a mocked `resolveAgentPort`
    - Use `fast-check` with a fake `LspSocketFactory`, min 100 iterations, tag `Feature: monaco-lsp-integration, Property 1: Connection URL`
    - **Validates: Requirements 1.1**

  - [ ]* 4.3 Write property test for the reconnect backoff schedule
    - **Property 2: Reconnect backoff schedule** — with fake timers, arbitrary close sequences with no intervening open produce delays `500, min(2×prev,5000), …`, and a successful open resets the next delay to 500ms
    - Use `fast-check` + fake timers, min 100 iterations, tag `Feature: monaco-lsp-integration, Property 2: Reconnect backoff schedule`
    - **Validates: Requirements 1.2, 1.3**

  - [ ]* 4.4 Write property test for authoritative disposal
    - **Property 3: Disposal is authoritative** — for any interleaving of close events and timer firings after `dispose()`, no further socket is opened (factory not called again), no pending timer remains (`clearTimeout` called), and the current socket is closed
    - Use `fast-check` + fake timers, min 100 iterations, tag `Feature: monaco-lsp-integration, Property 3: Disposal is authoritative`
    - **Validates: Requirements 1.4, 1.5**

  - [ ]* 4.5 Write property test for the close-code policy
    - **Property 4: Close-code policy** — emitting `ABNORMAL_SERVER_TERMINATION_CLOSE_CODE` schedules a backoff reconnect and reports `starting`; `SERVER_NOT_INSTALLED_CLOSE_CODE` schedules no reconnect and reports `error`; a `dispose()` schedules no reconnect and opens no socket
    - Use `fast-check` + fake timers, min 100 iterations, tag `Feature: monaco-lsp-integration, Property 4: Close-code policy`
    - **Validates: Requirements 6.5, 6.6**

- [ ] 5. Implement the MonacoLanguageClient adapter (`apps/frontend/src/features/editor/lsp/lsp-client.ts`)
  - [ ] 5.1 Implement `createLspClient` with a singleton `Map<ServerName, ManagedClient>`
    - Define `SERVER_LANGUAGES` document selectors; inject `ensureServicesInitialized`, `onServerState`, `onServerRemoved`, and optional `socketFactory`/`createLanguageClient` seams
    - `start` no-ops if a client already exists (singleton, R3.5), else calls `ensureServicesInitialized` then `openLspConnection`; on `onOpen` build the `vscode-ws-jsonrpc` reader/writer via `toSocket` and start one `MonacoLanguageClient` (sends `initialize`); on `onClose` stop+dispose the client so reconnect rebuilds it
    - `stop` deletes the entry, stops+disposes the client, disposes the connection, and calls `onServerRemoved`; `runningServers()` returns the current key set
    - Providers register only on a successful `onOpen`, which is what gates F12/Shift+F12/F2/hover on a connected server (R4.5/R4.6, Property 8)
    - _Requirements: 2.3, 2.4, 3.2, 3.3, 3.4, 3.5, 4.5, 4.6_

  - [ ]* 5.2 Write property test for a single client per server
    - **Property 7: Single language client per server** — over arbitrary `start`/`stop` sequences (fake `createLanguageClient` + fake socket factory), the clients map holds at most one entry per `Server_Name`, and `stop` calls the fake client's `stop` then `dispose`
    - Use `fast-check`, min 100 iterations, tag `Feature: monaco-lsp-integration, Property 7: Single language client per server`
    - **Validates: Requirements 3.4, 3.5**

- [ ] 6. Wire the status slice, registry subscription, and status-bar indicators
  - [ ] 6.1 Add the `serverStates` slice to `apps/frontend/src/lib/store.ts`
    - Add `serverStates: Map<ServerName, LanguageServerState>` with `setServerState(server, state)` and `removeServer(server)` actions that update state synchronously (no debounce)
    - _Requirements: 5.7_

  - [ ] 6.2 Add `createLspRegistry` to `apps/frontend/src/features/editor/lsp/lsp-registry.ts`
    - Subscribe to `useApp` and, whenever `openFiles` changes, compute `reconcile(client.runningServers(), requiredServers(openFiles))` and call `client.stop`/`client.start` for the results; apply once against the current `openFiles` on creation; `dispose()` unsubscribes and stops all running servers
    - _Requirements: 2.2, 2.4_

  - [ ] 6.3 Implement `LspStatusIndicators.tsx` and render it in `apps/frontend/src/components/layout/StatusBar.tsx`
    - Read `openFiles` and `serverStates` from the store, map `lspIndicatorViews(...)` to one `<Item>` per view (busy → spinner, ok → check/dot, error → alert), and place `<LspStatusIndicators/>` in the StatusBar left cluster; updates render immediately because the slice is written synchronously
    - _Requirements: 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_

  - [ ]* 6.4 Write example test for synchronous slice updates
    - Assert a `setServerState` call updates the store slice synchronously with no timer/debounce (design "Example (5.7)")
    - _Requirements: 5.7_

- [ ] 7. Wire the editor lifecycle
  - [ ] 7.1 Capture the Monaco instance in `apps/frontend/src/features/editor/MonacoView.tsx` and implement `ensureServicesInitialized`
    - In `handleMount(editor, monaco)` capture the single Monaco instance loaded by `@monaco-editor/react`; implement an idempotent one-time `ensureServicesInitialized()` that initializes the `monaco-languageclient` shared vscode service layer against that same instance
    - _Requirements: 3.2_

  - [ ] 7.2 Implement the `useLspLifecycle` hook (`apps/frontend/src/features/editor/useLspLifecycle.ts`)
    - On mount, `createLspClient({ ensureServicesInitialized, onServerState: setServerState, onServerRemoved: removeServer })` then `createLspRegistry(client)`; on unmount call `registry.dispose()`
    - _Requirements: 2.2, 2.4, 4.5, 4.6_

  - [ ] 7.3 Mount `useLspLifecycle` in `apps/frontend/src/features/editor/EditorArea.tsx`
    - Call the hook once from `EditorArea` so the client + registry are constructed and torn down with the editor
    - _Requirements: 2.2, 2.4_

  - [ ]* 7.4 Integration/manual verification of editor language features
    - With a real language server running, verify Go to Definition (F12), Find References (Shift+F12), Rename Symbol (F2), and hover resolve through LSP; the design marks R4.1–R4.4 as integration/manual (not PBT), so this is a manual check
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [ ] 8. Checkpoint - frontend
  - Ensure all frontend tests pass, ask the user if questions arise.

- [ ] 9. Harden the Gateway LSP proxy (`services/gateway/src/zocai_gateway/routes/lsp.py`)
  - [ ] 9.1 Add the new Application close-code constants
    - Add `SERVER_NOT_INSTALLED_CLOSE_CODE = 4041` and `ABNORMAL_SERVER_TERMINATION_CLOSE_CODE = 4050` alongside the existing `UNKNOWN_SERVER_CLOSE_CODE = 4004`, and export all three in `__all__` (names kept in sync with the frontend mirror)
    - _Requirements: 6.2, 6.3, 6.7_

  - [ ] 9.2 Classify spawn failures after `accept`
    - After `ws.accept()`, wrap `spawn(argv, root)` so `FileNotFoundError` closes with `SERVER_NOT_INSTALLED_CLOSE_CODE` and any other `OSError` (e.g. `PermissionError`) closes with `ABNORMAL_SERVER_TERMINATION_CLOSE_CODE`, in both cases returning without propagating an unhandled error (`FileNotFoundError` caught before `OSError`)
    - _Requirements: 6.2, 6.7_
    - _Implements: Property 11_

  - [ ] 9.3 Detect abnormal subprocess exit while the socket is open
    - Run three tasks (`client_task` = ws→process pump, `server_task` = process→ws pump, `exit_task` = `process.wait()`) with `asyncio.wait(FIRST_COMPLETED)`; if `client_task not in done` and (`server_task in done` or `exit_task in done`), set `close_code = ABNORMAL_SERVER_TERMINATION_CLOSE_CODE`; cancel/await pending tasks
    - Preserve the existing pre-`accept` behavior: unknown server name closes with `UNKNOWN_SERVER_CLOSE_CODE` before any spawn (R7.2/R7.3), `cwd` pinned to the resolved `Workspace_Root` (R7.4), and `inject_root_uri` still sets `rootUri`/`rootPath`/`workspaceFolders` (R7.5)
    - In `finally`, always terminate the subprocess and then `ws.close(code=close_code)` when a close code was set
    - _Requirements: 6.3, 6.4, 7.2, 7.3, 7.4, 7.5_
    - _Implements: Property 12, Property 13_

- [ ] 10. Extend the Gateway proxy tests (`services/gateway/tests/test_lsp_proxy.py`)
  - [ ] 10.1 Extend the in-memory fakes for the new paths
    - Give `_FakeWebSocket` a hold-open mode where `receive_text` awaits an `asyncio.Event`; make `_FakeProcess.wait()` await an event set by `terminate()` or an explicit `simulate_exit(code)` and support empty-stdout (immediate EOF) construction; add `spawn` fakes that raise `FileNotFoundError` and `PermissionError` (no real binary)
    - _Requirements: 7.6_

  - [ ]* 10.2 Write property test for spawn-failure classification
    - **Property 11: Spawn-failure classification** — parametrized over the three allowlisted servers, a `FileNotFoundError`-raising spawn closes with `SERVER_NOT_INSTALLED_CLOSE_CODE` and a `PermissionError`-raising spawn closes with `ABNORMAL_SERVER_TERMINATION_CLOSE_CODE`, with no propagated exception
    - Generator-driven with `asyncio.run`, min 100 iterations, tag `Feature: monaco-lsp-integration, Property 11: Spawn-failure classification`
    - **Validates: Requirements 6.2, 6.7**

  - [ ]* 10.3 Write property test for abnormal termination while connected
    - **Property 12: Abnormal termination while connected** — with a held-open fake WebSocket and a dying fake process (stdout EOF / `simulate_exit`), the proxy closes with `ABNORMAL_SERVER_TERMINATION_CLOSE_CODE`
    - Generator-driven with `asyncio.run`, min 100 iterations, tag `Feature: monaco-lsp-integration, Property 12: Abnormal termination while connected`
    - **Validates: Requirements 6.3**

  - [ ]* 10.4 Write property test for guaranteed subprocess termination
    - **Property 13: The subprocess is always terminated** — for each server and any end path that spawned a process, `process.terminated is True` after `proxy_lsp` returns
    - Generator-driven with `asyncio.run`, min 100 iterations, tag `Feature: monaco-lsp-integration, Property 13: The subprocess is always terminated`
    - **Validates: Requirements 6.4**

  - [ ]* 10.5 Write property test for admission and allowlist preceding spawn
    - **Property 14: Admission and allowlist precede spawn** — a denied request (over generated loopback/non-loopback settings + credentials via the pure `is_request_admitted`) closes the WebSocket with no spawn, and a non-allowlisted `Server_Name` closes with `UNKNOWN_SERVER_CLOSE_CODE` with no spawn
    - Generator-driven with `asyncio.run`, min 100 iterations, tag `Feature: monaco-lsp-integration, Property 14: Admission and allowlist precede spawn`
    - **Validates: Requirements 7.1, 7.2, 7.3**

  - [ ]* 10.6 Write property test for workspace pinning and rootUri injection
    - **Property 15: Workspace pinning and rootUri injection** — over arbitrary roots, a spawned server's `cwd` equals the resolved `Workspace_Root`, and an `initialize` forwarded through the proxy has `rootUri`, `rootPath`, and `workspaceFolders` set to that root
    - Generator-driven with `asyncio.run`, min 100 iterations, tag `Feature: monaco-lsp-integration, Property 15: Workspace pinning and rootUri injection`
    - **Validates: Requirements 7.4, 7.5**

  - [ ]* 10.7 Run the existing proxy suite as a regression check
    - Run the full pre-existing `test_lsp_proxy.py` suite and confirm it passes unchanged (preserved seams / unchanged runtime behavior)
    - _Requirements: 7.6, 8.5_

- [ ] 11. Checkpoint - gateway
  - Ensure all gateway tests pass, ask the user if questions arise.

- [ ] 12. Add setup automation for the language-server binaries
  - [ ] 12.1 Create `scripts/install-language-servers.sh` with the shared binary→install-command table
    - Define one source-of-truth table mapping `pyright-langserver` → `uv pip install pyright`, `typescript-language-server` → `npm install -g typescript-language-server typescript`, and `rust-analyzer` → `rustup component add rust-analyzer` (or download the prebuilt release binary: gunzip + `chmod +x` into a `PATH` dir), and implement the install logic driven by that table
    - _Requirements: 8.1, 8.6_

  - [ ] 12.2 Extend the `Makefile` `install` target
    - Append `sh scripts/install-language-servers.sh` to the existing `install` target so the three servers install alongside the current toolchain, without touching `routes/lsp.py`
    - _Requirements: 8.1, 8.4, 8.5_

  - [ ] 12.3 Extend the `Makefile` `doctor` target with a language-servers section
    - Add lines that print each of `pyright-langserver`, `typescript-language-server`, `rust-analyzer` presence via `--version`, falling back to `MISSING (<install command>)` using the same commands as the install table, so a binary is only reported missing when its install command is known
    - _Requirements: 8.2, 8.3, 8.4, 8.6_

  - [ ]* 12.4 Write verification for the doctor output and table invariant
    - Assert `make doctor` output names all three binaries and that a simulated-missing line includes its install command, and that the checked-binary set equals the install-table keys (every reported-missing binary has a non-empty install command)
    - _Requirements: 8.2, 8.3, 8.6_

- [ ] 13. Final verification
  - [ ] 13.1 Verify the frontend
    - Run the frontend typecheck, lint, and tests (`pnpm`), including the new property tests, and fix any failures
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 3.2, 3.3, 3.4, 3.5, 4.5, 4.6, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 6.5, 6.6_

  - [ ] 13.2 Verify the gateway
    - Run the gateway suite (`uv`/`pytest`), `mypy --strict`, and `ruff` for `services/gateway`, and fix any failures
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.7, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_

## Notes

- Tasks marked with `*` are optional (all unit/property/integration/verification
  tests and the manual R4.1–R4.4 check) and can be skipped for a faster MVP; the
  unmarked tasks are the core implementation.
- Each property test references a specific Correctness Property from the design,
  runs a minimum of 100 iterations, and carries the
  `Feature: monaco-lsp-integration, Property {n}: {text}` tag.
- Frontend property tests use `fast-check`; gateway property tests are
  generator-driven with `asyncio.run` and extend the existing in-memory fakes in
  `test_lsp_proxy.py` (no real server binary).
- The gateway hardening is additive: the allowlist, `Protocol` seams,
  `resolve_server_command`, `frame_message`/`read_framed_message`, and
  `inject_root_uri` are preserved so the existing suite stays green (10.7).
- Task 7.4 is the only manual/integration task (F12/Shift+F12/F2/hover against a
  real server); it is kept optional per the design's testing strategy.
- Checkpoints (tasks 8 and 11) and the final verification (task 13) validate
  incrementally; setup automation (task 12) does not change `routes/lsp.py`
  (R8.5).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "4.1", "9.1", "12.1"] },
    { "id": 1, "tasks": ["1.2", "2.2", "2.3", "3.1", "4.2", "5.1", "6.1", "9.2", "12.2"] },
    { "id": 2, "tasks": ["2.4", "3.2", "4.3", "5.2", "6.2", "6.3", "6.4", "7.1", "9.3", "12.3"] },
    { "id": 3, "tasks": ["3.3", "4.4", "7.2", "10.1", "12.4"] },
    { "id": 4, "tasks": ["3.4", "4.5", "7.3", "10.2"] },
    { "id": 5, "tasks": ["7.4", "10.3", "13.1"] },
    { "id": 6, "tasks": ["10.4"] },
    { "id": 7, "tasks": ["10.5"] },
    { "id": 8, "tasks": ["10.6"] },
    { "id": 9, "tasks": ["10.7"] },
    { "id": 10, "tasks": ["13.2"] }
  ]
}
```
