# Design Document

## Overview

This feature wires the Monaco editor in the Zoc Studio frontend to real language
servers, and hardens the Gateway proxy that backs them so failures surface as
clear, recoverable states instead of silent socket closes.

Two sides move in lockstep:

- **Frontend** — a new module set under `apps/frontend/src/features/editor/lsp/`
  (`lsp-connection.ts`, `lsp-registry.ts`, `lsp-client.ts`) plus a pure
  `LSP_Status_Formatter` and a per-language status indicator. A language server
  starts on demand when a matching file opens and shuts down when the last
  matching file closes. The connection mirrors the reconnect/backoff shape of
  the existing `apps/frontend/src/lib/index-progress.ts` and reuses
  `resolveAgentPort()` from `apps/frontend/src/lib/agent-port.ts`.
- **Backend** — the existing proxy at
  `services/gateway/src/zocai_gateway/routes/lsp.py` is hardened to detect a
  missing server binary and an abnormal subprocess exit and to close the
  WebSocket with distinct application close codes, while preserving its
  loopback bind, token admission, allowlist, workspace pinning, `rootUri`
  injection, and `Protocol`-based unit-test seams.
- **Setup automation** — `make install` and `make doctor` (and a new
  `scripts/` helper) install and verify the three server binaries, reporting a
  clear message and install command when one is missing from `PATH`.

The design deliberately keeps three layers separable and independently
testable: **transport** (`LSP_Connection`, a WebSocket with backoff), **protocol**
(`LSP_Client`, a `MonacoLanguageClient` per server), and **lifecycle**
(`LSP_Registry`, which maps languages to servers and reconciles start/stop
against open files). The connection and registry contain the logic that varies
with input and carry the bulk of the correctness properties; the client layer
is a thin, singleton-guarded adapter over `monaco-languageclient`.

### Detected language / conventions

- Frontend code: **TypeScript** (Vitest + `fast-check` already present in
  `apps/frontend/package.json`; property tests live in
  `apps/frontend/src/lib/__tests__/*.prop.test.ts`).
- Backend code: **Python** (async FastAPI; the gateway suite drives coroutines
  with `asyncio.run` and in-memory fakes, avoiding `pytest.mark.asyncio`).
- Setup: **Make + POSIX shell** (matching the existing `Makefile` and
  `scripts/*.sh`).

---

## Architecture

### Component map

```
apps/frontend/src/
  features/editor/
    MonacoView.tsx        (existing)  ── onMount(editor, monaco) ─┐
    EditorArea.tsx        (existing)  ── mounts useLspLifecycle() ─┼─┐
    lsp/                  (new)                                    │ │
      lsp-registry.ts     Language_Id→Server_Name map; reconciles  │ │
                          running servers against store.openFiles  │ │
      lsp-client.ts       one MonacoLanguageClient per Server_Name  │ │
                          over an LSP_Connection (monaco-           │ │
                          languageclient + vscode-ws-jsonrpc)  ◀────┘ │
      lsp-connection.ts   WebSocket transport w/ 500→5000ms backoff,  │
                          injected socket factory, disposed flag      │
      lsp-status.ts       LSP_Status_Formatter (pure) + status slice ◀┘
      LspStatusIndicators.tsx  renders one indicator per Language_Id
  components/layout/
    StatusBar.tsx         (existing)  ── renders <LspStatusIndicators/>
  lib/
    agent-port.ts         (existing)  resolveAgentPort()
    store.ts              (existing)  OpenFile.language, openFiles[]

services/gateway/src/zocai_gateway/
  routes/lsp.py           (harden)    proxy_lsp + close codes + seams
  app.py                  (existing)  /v1/lsp/{server_name}/ws route + admission
  auth.py, settings.py    (existing)  is_request_admitted, loopback, token
```

Data flow (happy path): `store.openFiles` changes → `LSP_Registry` reconciles →
`LSP_Client.start(server)` → `LSP_Connection` opens a WebSocket to the Gateway →
Gateway `proxy_lsp` spawns the stdio server and pumps JSON-RPC →
`MonacoLanguageClient` sends `initialize` → Monaco gains definition/references/
rename/hover providers for the server's languages → status indicator flips to
`connected`.

### Sequence: on-demand start → connect → initialize → feature request → idle shutdown

```
User opens foo.ts
  store.openFiles gains { language: "typescript", ... }
  LSP_Registry (subscribed to store) recomputes required servers
    required = { typescript-language-server }   (no running server yet)
    → LSP_Client.start("typescript-language-server")
        status slice: typescript-language-server = "starting"   (R5.2)
        LSP_Connection.connect()
          url = ws://127.0.0.1:{resolveAgentPort()}/v1/lsp/typescript-language-server/ws  (R1.1)
          socket = socketFactory(url)
        Gateway /v1/lsp/.../ws: admission OK (loopback) → proxy_lsp
          spawn(["typescript-language-server","--stdio"], cwd=workspace_root)   (R6.1, R7.4)
        socket.onopen → reconnectDelay = 500ms   (R1.2); status = "connected" (R5.3)
          LSP_Client builds vscode-ws-jsonrpc reader/writer over the socket,
          creates + starts one MonacoLanguageClient (R3.2),
          which sends LSP initialize (R3.3); Gateway injects rootUri/rootPath/
          workspaceFolders (R7.5)
  User presses F12 on a symbol
    Monaco definitionProvider (registered by the client) → textDocument/definition
    → server → navigate to location   (R4.1)   [Shift+F12 refs R4.2, F2 rename R4.3, hover R4.4]
User closes foo.ts (last typescript file)
  LSP_Registry recomputes required servers → {} 
    → LSP_Client.stop("typescript-language-server")
        MonacoLanguageClient.stop() + dispose()   (R3.4)
        LSP_Connection.dispose(): clear timer, socket.close()   (R1.4, R2.4)
        status slice: remove typescript-language-server        (R5.6)
  Gateway: socket close → proxy_lsp finally terminates subprocess  (R6.4)
```

### Sequence: Gateway error paths

```
(a) Missing binary                                   (R6.2, R6.6)
  proxy_lsp: allowlist OK → ws.accept() → spawn(...) raises FileNotFoundError
    → ws.close(code = SERVER_NOT_INSTALLED_CLOSE_CODE); return   (no unhandled error)
  Frontend onclose(code == SERVER_NOT_INSTALLED):
    stop reconnecting; status = "error"

(b) Other spawn failure, e.g. PermissionError        (R6.7)
  proxy_lsp: spawn(...) raises OSError (not FileNotFoundError)
    → ws.close(code = ABNORMAL_SERVER_TERMINATION_CLOSE_CODE); return
  Frontend onclose(code == ABNORMAL_SERVER_TERMINATION): reconnect + backoff

(c) Subprocess exits while socket open               (R6.3, R6.5)
  server task (stdout EOF) / process.wait() completes while client pump pending
    → close_code = ABNORMAL_SERVER_TERMINATION_CLOSE_CODE
  finally: terminate(process); ws.close(code = close_code)
  Frontend onclose(code == ABNORMAL_SERVER_TERMINATION): reconnect + backoff

(d) Unknown server (defensive; registry never requests one)   (R7.2, R7.3)
  proxy_lsp: resolve_server_command → None → ws.close(code = UNKNOWN_SERVER_CLOSE_CODE)
    before accept, no spawn

(e) Unauthorized (non-loopback bind without token)            (R7.1)
  app.py lsp_proxy: is_request_admitted == False → ws.close(code=1008); proxy_lsp never called
```

---

## Frontend module design

### `lsp/lsp-connection.ts` — WebSocket transport with backoff

Mirrors `index-progress.ts` exactly: injected socket factory, `disposed` flag
that is authoritative, `500ms → 5000ms` exponential backoff. The one addition is
that `onclose` receives the **close code** so the connection can distinguish the
two application close codes, and the connection reports a `Language_Server_State`
through an `onState` callback.

```typescript
// Application close codes the Gateway may send (kept in sync with lsp.py).
export const ABNORMAL_SERVER_TERMINATION_CLOSE_CODE = 4050;
export const SERVER_NOT_INSTALLED_CLOSE_CODE = 4041;

export const INITIAL_RECONNECT_MS = 500;
export const MAX_RECONNECT_MS = 5_000;

export type LanguageServerState = "starting" | "connected" | "error";

/** Minimal socket surface (a real `WebSocket` satisfies it). `onclose`
 *  receives the close code so the two Application_Close_Codes can be told
 *  apart; the browser `CloseEvent.code` provides it. */
export interface LspSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export type LspSocketFactory = (url: string) => LspSocket;

export interface LspConnectionOptions {
  /** Called on each successful open with the live socket, so the LSP_Client
   *  can build its vscode-ws-jsonrpc reader/writer and start a client. */
  onOpen: (socket: LspSocket) => void;
  /** Called when an established socket closes (any reason). */
  onClose: () => void;
  /** Called on every Language_Server_State transition (drives the indicator). */
  onState: (state: LanguageServerState) => void;
  /** Injected for tests; defaults to the real WebSocket. */
  socketFactory?: LspSocketFactory;
}

export interface LspConnection {
  /** Idempotent teardown: cancels any pending reconnect and closes the socket. */
  dispose(): void;
}

export function lspConnectionUrl(port: number, serverName: string): string {
  return `ws://127.0.0.1:${port}/v1/lsp/${serverName}/ws`;
}

export async function openLspConnection(
  serverName: string,
  options: LspConnectionOptions,
): Promise<LspConnection> {
  const factory =
    options.socketFactory ??
    ((url) => new WebSocket(url) as unknown as LspSocket);
  const port = await resolveAgentPort();               // R1.1 (agent-port.ts)
  const url = lspConnectionUrl(port, serverName);       // R1.1

  let socket: LspSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = INITIAL_RECONNECT_MS;
  let disposed = false;   // caller teardown        (R1.4, R1.5 — authoritative)
  let stopped = false;    // server-not-installed: terminal, but not a dispose

  const setState = (s: LanguageServerState) => options.onState(s);

  const connect = () => {
    if (disposed || stopped) return;                    // R1.5 / R6.6
    setState("starting");                               // R5.2
    socket = factory(url);
    socket.onopen = () => {
      reconnectDelay = INITIAL_RECONNECT_MS;            // R1.2
      setState("connected");                            // R5.3
      if (socket) options.onOpen(socket);               // hand socket to LSP_Client
    };
    socket.onerror = () => socket?.close();
    socket.onclose = (event) => {
      socket = null;
      options.onClose();
      if (disposed) return;                             // R1.5
      if (event.code === SERVER_NOT_INSTALLED_CLOSE_CODE) {
        stopped = true;                                 // R6.6: stop reconnecting
        setState("error");                              // R5.4 / R6.6
        return;
      }
      // Abnormal termination (R6.5) or any transient drop → backoff (R1.3).
      setState("starting");                             // R5.2 (reconnecting)
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(MAX_RECONNECT_MS, reconnectDelay * 2);  // R1.3
    };
  };

  connect();

  return {
    dispose() {
      disposed = true;                                  // R1.5
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);  // R1.4
      reconnectTimer = null;
      socket?.close();                                  // R1.4
      socket = null;
    },
  };
}
```

Notes:
- `disposed` is set first in `dispose()`, then the pending timer is cleared and
  the socket closed. Any later `onclose` returns immediately on `disposed`, and
  any queued `connect` no-ops — no scheduled reconnect can reopen a socket after
  teardown (the "disposal is authoritative" rationale in R1).
- `stopped` is distinct from `disposed`: a server-not-installed close is
  terminal for reconnection and reports `error`, but the caller can still
  `dispose()` later (idempotent).

### `lsp/lsp-registry.ts` — Language→Server map and per-language lifecycle

Owns the mapping and the reconciliation loop. It observes `openFiles` through the
Zustand store (`useApp.subscribe`) and, on every change, computes the set of
**required** `Server_Name`s and reconciles the running set to match. All the
lifecycle rules (R2.2–R2.6) fall out of one pure function plus a reconcile step.

```typescript
export type ServerName =
  | "typescript-language-server"
  | "pyright"
  | "rust-analyzer";

/** Language_Id → Server_Name (R2.1). The four TS/JS ids share one server. */
export const LANGUAGE_SERVERS: Readonly<Record<string, ServerName>> = {
  typescript: "typescript-language-server",
  typescriptreact: "typescript-language-server",
  javascript: "typescript-language-server",
  javascriptreact: "typescript-language-server",
  python: "pyright",
  rust: "rust-analyzer",
};

/** Pure: the Server_Name for a Language_Id, or undefined when unmapped (R2.6). */
export function serverForLanguage(languageId: string): ServerName | undefined {
  return LANGUAGE_SERVERS[languageId];
}

/** Pure: distinct Server_Names required by a set of open files (R2.2/2.4/2.5/2.6). */
export function requiredServers(
  openFiles: ReadonlyArray<{ language: string }>,
): ReadonlySet<ServerName> {
  const out = new Set<ServerName>();
  for (const f of openFiles) {
    const server = serverForLanguage(f.language);
    if (server) out.add(server);
  }
  return out;
}

/** Pure: distinct mapped Language_Ids among open files (drives indicators, R5.5/5.6). */
export function activeLanguageIds(
  openFiles: ReadonlyArray<{ language: string }>,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  for (const f of openFiles) {
    if (serverForLanguage(f.language) && !seen.has(f.language)) seen.add(f.language);
  }
  return [...seen];
}

/** Pure reconcile: given what is running now and what is required, the set of
 *  servers to start and to stop. `start`/`stop` are disjoint; a server that is
 *  running and still required is reused, not restarted (R2.3 idempotence). */
export function reconcile(
  running: ReadonlySet<ServerName>,
  required: ReadonlySet<ServerName>,
): { start: ServerName[]; stop: ServerName[] } {
  const start = [...required].filter((s) => !running.has(s));  // R2.2
  const stop = [...running].filter((s) => !required.has(s));   // R2.4
  return { start, stop };
}

export interface LspRegistry {
  dispose(): void; // unsubscribes from the store and stops all servers
}

/** Wires reconciliation to the store. Called once from the editor feature. */
export function createLspRegistry(client: LspClient): LspRegistry {
  const apply = (openFiles: ReadonlyArray<{ language: string }>) => {
    const { start, stop } = reconcile(client.runningServers(), requiredServers(openFiles));
    for (const s of stop) client.stop(s);    // R2.4 (also disposes connection)
    for (const s of start) client.start(s);  // R2.2 (reuse handled by reconcile → R2.3)
  };
  apply(useApp.getState().openFiles);
  const unsub = useApp.subscribe((state, prev) => {
    if (state.openFiles !== prev.openFiles) apply(state.openFiles);
  });
  return {
    dispose() {
      unsub();
      for (const s of client.runningServers()) client.stop(s);
    },
  };
}
```

`client.runningServers()` returns the set of `Server_Name`s currently started,
so "at most one per Server_Name" (R2.5) is enforced structurally by the set plus
the client's singleton guard (below).

### `lsp/lsp-client.ts` — one MonacoLanguageClient per server

A thin, singleton-guarded adapter over `monaco-languageclient` and
`vscode-ws-jsonrpc`. It holds a `Map<ServerName, ManagedClient>` so there is at
most one client per server (R3.5). `start` opens an `LSP_Connection`; on each
successful open it (re)builds the JSON-RPC transports from the live socket,
creates a `MonacoLanguageClient`, and starts it (which sends `initialize`,
R3.3). On close it stops+disposes the client so a fresh one is built on
reconnect. `stop` disposes both the client and the connection (R3.4, R2.4).

```typescript
import { MonacoLanguageClient } from "monaco-languageclient";
import {
  toSocket,
  WebSocketMessageReader,
  WebSocketMessageWriter,
} from "vscode-ws-jsonrpc";

/** Language ids each server serves, used as the client's documentSelector so
 *  Monaco registers definition/reference/rename/hover providers for them. */
const SERVER_LANGUAGES: Record<ServerName, string[]> = {
  "typescript-language-server": [
    "typescript", "typescriptreact", "javascript", "javascriptreact",
  ],
  pyright: ["python"],
  "rust-analyzer": ["rust"],
};

interface ManagedClient {
  connection: LspConnection;
  languageClient: MonacoLanguageClient | null;
  state: LanguageServerState;
}

export interface LspClient {
  start(server: ServerName): void;
  stop(server: ServerName): void;
  runningServers(): ReadonlySet<ServerName>;
}

export function createLspClient(deps: {
  /** Monaco namespace from MonacoView's onMount, used once to init services. */
  ensureServicesInitialized: () => Promise<void> | void;
  /** Reports state to the status slice (drives the indicator). */
  onServerState: (server: ServerName, state: LanguageServerState) => void;
  /** Removes the server's status entry when it shuts down (R5.6). */
  onServerRemoved: (server: ServerName) => void;
  socketFactory?: LspSocketFactory; // injected in tests
  createLanguageClient?: (args: {                     // injected in tests
    server: ServerName;
    socket: LspSocket;
  }) => MonacoLanguageClient;
}): LspClient {
  const clients = new Map<ServerName, ManagedClient>();

  const buildLanguageClient = deps.createLanguageClient ?? (({ server, socket }) => {
    const rpc = toSocket(socket as unknown as WebSocket);
    const reader = new WebSocketMessageReader(rpc);
    const writer = new WebSocketMessageWriter(rpc);
    return new MonacoLanguageClient({
      name: server,
      clientOptions: { documentSelector: SERVER_LANGUAGES[server] },
      messageTransports: { reader, writer },
    });
  });

  return {
    start(server) {
      if (clients.has(server)) return;                 // R3.5 singleton / R2.3 reuse
      const managed: ManagedClient = { connection: null!, languageClient: null, state: "starting" };
      clients.set(server, managed);
      void Promise.resolve(deps.ensureServicesInitialized()).then(async () => {
        managed.connection = await openLspConnection(server, {
          socketFactory: deps.socketFactory,
          onState: (state) => { managed.state = state; deps.onServerState(server, state); },
          onOpen: (socket) => {
            const lc = buildLanguageClient({ server, socket });
            managed.languageClient = lc;
            void lc.start();                            // R3.2, R3.3 (sends initialize)
          },
          onClose: () => {                              // drop client so reconnect rebuilds it
            const lc = managed.languageClient;
            managed.languageClient = null;
            if (lc) void lc.stop().catch(() => {}).finally(() => lc.dispose?.());
          },
        });
      });
    },
    stop(server) {
      const managed = clients.get(server);
      if (!managed) return;
      clients.delete(server);
      const lc = managed.languageClient;
      if (lc) void lc.stop().catch(() => {}).finally(() => lc.dispose?.());  // R3.4
      managed.connection?.dispose();                   // R1.4 / R2.4
      deps.onServerRemoved(server);                    // R5.6
    },
    runningServers() {
      return new Set(clients.keys());
    },
  };
}
```

`monaco-languageclient` integration notes (grounded, decided at implementation):
- `monaco-languageclient` requires the shared vscode service layer to be
  initialized once before any client starts. `ensureServicesInitialized()`
  performs that one-time init (idempotent) using the **same** Monaco instance
  `@monaco-editor/react` loads. `MonacoView.tsx` already receives that instance
  in `handleMount(editor, monaco)`; the LSP feature obtains it there (or via the
  `@monaco-editor/react` `loader`) so there is a single Monaco instance — a dual
  instance would leave providers unregistered. This is the one integration risk
  and is contained entirely in `ensureServicesInitialized()`.
- The document selector per server (above) is what makes F12/Shift+F12/F2/hover
  resolve through LSP (R4.1–R4.4): once the client starts and the server
  advertises the corresponding capabilities, Monaco's built-in
  editor actions (Go to Definition F12, Find/Peek References Shift+F12, Rename
  F2, hover) invoke the registered providers automatically. No custom
  keybindings are added.
- `monaco-languageclient` / `vscode-ws-jsonrpc` are added to
  `apps/frontend/package.json` dependencies (R3.1); versions are pinned at
  implementation against the installed `monaco-editor@^0.55`.

### `lsp/lsp-status.ts` — pure formatter + status slice

The formatter is a pure function in the exact style of
`apps/frontend/src/lib/status-bar.ts` (`languageLabel`, `agentStateLabel`): no
React, unit-testable in isolation (R5.1). It reuses the language display labels.

```typescript
export interface LspStatusView {
  languageId: string;
  label: string;                 // e.g. "TypeScript", "Python"
  state: LanguageServerState;    // starting | connected | error
  tone: "busy" | "ok" | "error"; // display tone, like status-bar.ts tones
}

const LANGUAGE_LABELS: Record<string, string> = {
  typescript: "TypeScript",
  typescriptreact: "TypeScript JSX",
  javascript: "JavaScript",
  javascriptreact: "JavaScript JSX",
  python: "Python",
  rust: "Rust",
};

/** Pure: derive the display view for one language's server state (R5.1–5.4). */
export function formatLspStatus(
  languageId: string,
  state: LanguageServerState,
): LspStatusView {
  const label = LANGUAGE_LABELS[languageId] ?? languageId;
  const tone = state === "connected" ? "ok" : state === "error" ? "error" : "busy";
  return { languageId, label, state, tone };
}
```

The per-server state lives in a small store slice, keyed by `Server_Name`:

```typescript
// serverStates: Map<ServerName, LanguageServerState>, updated synchronously in
// onState/onServerRemoved (no debounce, R5.7).
```

The indicator list is derived, not stored: for the current `openFiles`, take
`activeLanguageIds(openFiles)` (distinct mapped Language_Ids), look up each
Language_Id's mapped server state, and format it. This yields exactly one view
per open Language_Id (R5.5) and none once a Language_Id has no open file (R5.6).

```typescript
/** Pure: the indicator views to render (R5.5, R5.6). One per distinct mapped
 *  Language_Id among open files; each reflects its mapped server's state. */
export function lspIndicatorViews(
  openFiles: ReadonlyArray<{ language: string }>,
  serverStates: ReadonlyMap<ServerName, LanguageServerState>,
): LspStatusView[] {
  return activeLanguageIds(openFiles).map((languageId) => {
    const server = serverForLanguage(languageId)!;
    const state = serverStates.get(server) ?? "starting";
    return formatLspStatus(languageId, state);
  });
}
```

### `lsp/LspStatusIndicators.tsx` — status-bar component

A small React component rendered inside the existing
`components/layout/StatusBar.tsx` left cluster (next to the agent/index items).
It reads `openFiles` and the server-state slice from the store and maps
`lspIndicatorViews(...)` to one `<Item>` per view — reusing the `StatusBar`
`Item` styling (icon + label). A `busy` tone shows a spinner (like the existing
`Loader2` usage), `ok` a check/dot, `error` an alert icon. Because state updates
write the slice synchronously in the connection's `onState`, indicators reflect
changes immediately (R5.7).

Placement in `StatusBar.tsx`:

```tsx
{/* left cluster, after the diagnostics / index items */}
<LspStatusIndicators />
```

### Editor feature wiring — `useLspLifecycle`

`EditorArea.tsx` mounts a hook that constructs the client + registry once and
disposes them on unmount:

```typescript
// features/editor/useLspLifecycle.ts
export function useLspLifecycle(): void {
  useEffect(() => {
    const client = createLspClient({
      ensureServicesInitialized,      // uses Monaco from MonacoView onMount
      onServerState: setServerState,  // writes the status slice
      onServerRemoved: removeServer,
    });
    const registry = createLspRegistry(client);   // subscribes to store.openFiles
    return () => registry.dispose();
  }, []);
}
```

- Files whose Language_Id maps to no server (R4.5) never cause a `start`, so
  Monaco has no LSP providers for them — plain editing. Files whose mapped
  server is not `connected` (R4.6) have no started/registered client yet (start
  registers providers only on a successful `onOpen`; `onClose` deregisters), so
  they operate without LSP features until the server connects/reconnects. This
  is captured by the pure predicate:

```typescript
/** Pure: are LSP features active for this Language_Id? (R4.5, R4.6) */
export function isLspActive(
  languageId: string,
  serverStates: ReadonlyMap<ServerName, LanguageServerState>,
): boolean {
  const server = serverForLanguage(languageId);
  return server !== undefined && serverStates.get(server) === "connected";
}
```

---

## Backend hardening design (`routes/lsp.py`)

The hardening is additive: the allowlist, `Protocol` seams
(`LspWebSocket`, `LspProcess`, `SpawnProcess`, `AsyncByteReader/Writer`),
`default_spawn`, `resolve_server_command`, `frame_message`,
`read_framed_message`, and `inject_root_uri` are all preserved unchanged, so the
existing tests and their in-memory fakes keep working (R7.6). Three things
change inside `proxy_lsp`, plus two new module constants.

### New Application close codes

```python
# services/gateway/src/zocai_gateway/routes/lsp.py
UNKNOWN_SERVER_CLOSE_CODE = 4004            # existing (allowlist miss)
SERVER_NOT_INSTALLED_CLOSE_CODE = 4041      # NEW: Server_Binary missing on PATH (R6.2)
ABNORMAL_SERVER_TERMINATION_CLOSE_CODE = 4050  # NEW: subprocess exit / spawn failure (R6.3, R6.7)
```

All three are in the `4000–4999` application-private range and are distinct, so
they never collide with a protocol-level code (R6 / `Application_Close_Code`
glossary). They are exported in `__all__` and imported by the frontend's
`lsp-connection.ts` mirror constants (kept in sync by name).

### Detecting a missing binary vs. other spawn failures

`spawn(...)` is the seam that launches the process. A missing `Server_Binary`
surfaces as `FileNotFoundError` (a subclass of `OSError`); a permission problem
surfaces as `PermissionError` (also an `OSError`). Because `FileNotFoundError`
is a subclass of `OSError`, it is caught first (R6.2 vs R6.7). The socket is
`accept()`-ed before the spawn (as today) so the client receives a clean close
frame carrying the application code it can read:

```python
argv = resolve_server_command(server_name)
if argv is None:
    await ws.close(code=UNKNOWN_SERVER_CLOSE_CODE)   # R7.3, before accept, no spawn
    return

root = Path(workspace_root).resolve()
await ws.accept()
try:
    process = await spawn(argv, root)                # R6.1, cwd pinned to root (R7.4)
except FileNotFoundError:
    await ws.close(code=SERVER_NOT_INSTALLED_CLOSE_CODE)   # R6.2 (no unhandled error)
    return
except OSError:
    await ws.close(code=ABNORMAL_SERVER_TERMINATION_CLOSE_CODE)  # R6.7
    return
```

Detection is via the seam (not `shutil.which`) so a fake `spawn` that raises
`FileNotFoundError`/`PermissionError` fully exercises R6.2/R6.7 with no real
binary (R7.6).

### Detecting subprocess exit while the socket is open

`proxy_lsp` runs two pumps today. Hardening adds a third task that awaits
`process.wait()` and classifies the outcome: if the **server side** ends (its
stdout pump finishes on EOF, or `process.wait()` returns) while the **client
pump is still pending**, that is an abnormal termination and the socket is
closed with the abnormal code. If the **client pump** finishes first (client
disconnect), it is a normal close and no application code is sent. The subprocess
is always terminated in `finally` (R6.4), preserving today's terminate-on-close.

```python
close_code: int | None = None
try:
    stdin, stdout = process.stdin, process.stdout
    if stdin is None or stdout is None:
        close_code = ABNORMAL_SERVER_TERMINATION_CLOSE_CODE
        return
    client_task = asyncio.create_task(_pump_ws_to_process(ws, stdin, root))
    server_task = asyncio.create_task(_pump_process_to_ws(stdout, ws))
    exit_task = asyncio.create_task(process.wait())
    done, pending = await asyncio.wait(
        {client_task, server_task, exit_task},
        return_when=asyncio.FIRST_COMPLETED,
    )
    # Server ended the session while the client was still connected → abnormal.
    if client_task not in done and (server_task in done or exit_task in done):
        close_code = ABNORMAL_SERVER_TERMINATION_CLOSE_CODE   # R6.3
    for task in pending:
        task.cancel()
    await asyncio.gather(*pending, return_exceptions=True)
finally:
    _terminate(process)                                       # R6.4 (unchanged)
    with contextlib.suppress(Exception):
        await asyncio.wait_for(process.wait(), timeout=5.0)
    if close_code is not None:
        with contextlib.suppress(Exception):
            await ws.close(code=close_code)
```

The classification rule "`client_task not in done`" means a client-initiated
close is never mislabeled abnormal, even when the server stream also ends in the
same scheduling batch. This keeps the existing spawn/terminate tests green (they
disconnect the client) while making the new abnormal-termination path
deterministic under the extended fakes.

### Preserved security invariants (R7)

Unchanged and re-asserted by tests:
- **Admission before spawn (R7.1):** `app.py`'s `lsp_proxy` route still calls
  `extract_credential` + `is_request_admitted` and, when not admitted, closes
  with `1008` before calling `proxy_lsp` — so no server is spawned for an
  unauthorized request. On loopback (the default desktop bind) admission passes
  without a credential, which is why the browser WebSocket connects with no
  token (same posture as the existing index-progress socket).
- **Allowlist (R7.2, R7.3):** `resolve_server_command` gates the spawn; an
  unknown name closes with `UNKNOWN_SERVER_CLOSE_CODE` before accept.
- **Workspace pinning (R7.4):** `cwd=root` (resolved) on `spawn`.
- **`rootUri` injection (R7.5):** `inject_root_uri` still patches `initialize`
  with `rootUri`/`rootPath`/`workspaceFolders` = workspace root.
- **Seams (R7.6):** the `Protocol`s and `SpawnProcess` are untouched; new
  behavior is exercised through them.

---

## Setup automation design

Goal: `make install` installs the three servers and `make doctor` verifies them,
reporting the install command when one is missing (R8). The runtime proxy
(`lsp.py`) is untouched (R8.5). Work is split between a new `scripts/` helper
(install logic + the shared binary→command table) and inline `doctor` lines
matching the existing shell style (R8.4).

### Shared table (single source of truth)

`scripts/install-language-servers.sh` defines the mapping of `Server_Binary` →
install command, and both install and verify use it, so `doctor` only ever
reports a binary missing when it also knows the install command (R8.6):

| Server_Binary | Install command |
| --- | --- |
| `pyright-langserver` | `uv pip install pyright` (pip; provides `pyright-langserver`) |
| `typescript-language-server` | `npm install -g typescript-language-server typescript` |
| `rust-analyzer` | `rustup component add rust-analyzer` **or** download the prebuilt release binary to a `PATH` dir |

`rust-analyzer` follows R8.1's "cargo or a downloaded binary": the helper
downloads the platform release binary (gunzip + `chmod +x` into a `PATH`
directory) when `rustup` is not the chosen path.

### `make install`

Append one line to the existing target so the servers install alongside the
existing toolchain (`pnpm install` / `uv sync` / `cargo fetch`):

```make
install:
	pnpm install
	uv sync --all-packages
	cargo fetch
	sh scripts/install-language-servers.sh        # R8.1 (pyright, ts, rust-analyzer)
```

### `make doctor`

Extend the existing `doctor` target with a language-servers section, matching
its `printf "name : "; cmd --version || echo "MISSING (...)"` idiom, reporting
each binary's presence/absence and the install command when missing (R8.2, R8.3,
R8.6):

```make
	@echo ""
	@echo "==> Language servers (Monaco LSP):"
	@printf "pyright-langserver        : "; pyright-langserver --version 2>/dev/null || echo "MISSING (uv pip install pyright)"
	@printf "typescript-language-server: "; typescript-language-server --version 2>/dev/null || echo "MISSING (npm install -g typescript-language-server typescript)"
	@printf "rust-analyzer             : "; rust-analyzer --version 2>/dev/null || echo "MISSING (rustup component add rust-analyzer)"
```

Because the set of checked binaries equals the keys of the install table, every
binary the doctor can report as missing also has a known install command
(R8.6). No change touches `routes/lsp.py` or its route wiring (R8.5).

---

## Data models / types

Frontend (new):
- `LanguageServerState = "starting" | "connected" | "error"` — the
  `Language_Server_State` value used by the connection, status slice, and
  formatter.
- `ServerName` — the three allowlisted logical server names.
- `LspSocket` / `LspSocketFactory` — the injectable transport seam (mirrors
  `IndexProgressSocket`), with `onclose(event: { code })`.
- `LspStatusView` — the pure formatter output (`languageId`, `label`, `state`,
  `tone`).
- Store slice: `serverStates: Map<ServerName, LanguageServerState>`.

Backend (new constants only; existing types unchanged):
- `SERVER_NOT_INSTALLED_CLOSE_CODE = 4041`,
  `ABNORMAL_SERVER_TERMINATION_CLOSE_CODE = 4050` (alongside
  `UNKNOWN_SERVER_CLOSE_CODE = 4004`).

---

## Error handling

| Condition | Where | Handling | Frontend result |
| --- | --- | --- | --- |
| Transient socket drop | `LSP_Connection.onclose` | backoff reconnect 500→5000ms | indicator `starting` (R1.3, R5.2) |
| Abnormal server exit / non-missing spawn failure | `proxy_lsp` → close `4050` | frontend reconnects with backoff | `starting` then recovers (R6.3, R6.5, R6.7) |
| Server binary missing | `proxy_lsp` → close `4041` | frontend stops reconnecting | indicator `error` (R6.2, R6.6) |
| Unknown server name | `proxy_lsp` → close `4004` before accept | (registry never requests one) | n/a (R7.3) |
| Unauthorized (non-loopback, no token) | `app.py` route → close `1008` | no spawn | connection fails; not a language error (R7.1) |
| Caller disposes (file closed) | `LSP_Connection.dispose` | cancel timer, close socket; client stop+dispose | indicator removed (R1.4, R2.4, R5.6) |
| Monaco service init fails | `ensureServicesInitialized` | client not started; connection may retry | file operates without LSP features (R4.6) |

The connection never throws to the caller: all failure signaling is via the
`onState` callback and the close-code policy.

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all
valid executions of a system — a formal statement about what the system should
do. Properties bridge human-readable specifications and machine-verifiable
correctness guarantees.*

### Property 1: Connection URL

*For any* TCP port and allowlisted `Server_Name`, `LSP_Connection` opens its
WebSocket at exactly `ws://127.0.0.1:{port}/v1/lsp/{server_name}/ws`, using the
port returned by `resolveAgentPort`.

**Validates: Requirements 1.1**

### Property 2: Reconnect backoff schedule

*For any* sequence of connection closes with no intervening successful open, the
scheduled reconnect delays are `500ms` first and thereafter each delay is
`min(2 × previous, 5000)ms`; and *for any* successful open, the next reconnect
delay is reset to `500ms`.

**Validates: Requirements 1.2, 1.3**

### Property 3: Disposal is authoritative

*For any* interleaving of `close` events and reconnect-timer firings after a
caller `dispose()`, a disposed `LSP_Connection` opens no further socket and
leaves no pending reconnect timer, and `dispose()` closes the current socket.

**Validates: Requirements 1.4, 1.5**

### Property 4: Close-code policy

*For any* established `LSP_Connection`, observing the abnormal-server-termination
`Application_Close_Code` schedules a reconnect under the Requirement 1 backoff
policy and reports `starting`; observing the server-not-installed
`Application_Close_Code` schedules no reconnect and reports `error`; and a caller
`dispose()` schedules no reconnect and opens no socket.

**Validates: Requirements 6.5, 6.6**

### Property 5: Server lifecycle reconciliation

*For any* set of open files, after `LSP_Registry` reconciles, the set of running
servers equals exactly the set of `Server_Name`s that at least one open file's
`Language_Id` maps to — at most one running server per `Server_Name`, and no
running server for a `Language_Id` that maps to none.

**Validates: Requirements 2.2, 2.4, 2.5, 2.6**

### Property 6: Reuse is idempotent

*For any* set of open files, reconciling a second time with no change to the
open files starts no additional server and disposes no running server (a server
already running for a still-required `Server_Name` is reused, not restarted).

**Validates: Requirements 2.3**

### Property 7: Single language client per server

*For any* sequence of `start`/`stop` operations, `LSP_Client` holds at most one
`MonacoLanguageClient` per `Server_Name`, and stopping a server disposes the
client registered for it.

**Validates: Requirements 3.4, 3.5**

### Property 8: LSP features are gated on a connected server

*For any* `Language_Id` and any map of server states, editor LSP features are
active for a file if and only if the file's `Language_Id` maps to a `Server_Name`
whose state is `connected`.

**Validates: Requirements 4.5, 4.6**

### Property 9: Status view derivation

*For any* `Language_Server_State`, `LSP_Status_Formatter` yields a non-empty
display label and a display state that is `starting` when the server is starting
or reconnecting, `connected` when its connection is established, and `error` when
it failed to start or reported an error.

**Validates: Requirements 5.1, 5.2, 5.3, 5.4**

### Property 10: One indicator per open Language_Id

*For any* set of open files, the status bar renders exactly one
`LSP_Status_Indicator` per distinct `Language_Id` among the open files that maps
to a `Server_Name`, and none for a `Language_Id` that has no open file or maps to
no `Server_Name`.

**Validates: Requirements 5.5, 5.6**

### Property 11: Spawn-failure classification

*For any* allowlisted `Server_Name`, if the spawn seam raises a missing-binary
error (`FileNotFoundError`) the `LSP_Proxy` closes the WebSocket with the
server-not-installed `Application_Close_Code`, and if it raises any other spawn
error (for example a permission error) the `LSP_Proxy` closes with the
abnormal-server-termination `Application_Close_Code` — in both cases without
propagating an unhandled error.

**Validates: Requirements 6.2, 6.7**

### Property 12: Abnormal termination while connected

*For any* allowlisted `Server_Name`, if the language-server subprocess ends while
the client WebSocket is still open, the `LSP_Proxy` closes the socket with the
abnormal-server-termination `Application_Close_Code`.

**Validates: Requirements 6.3**

### Property 13: The subprocess is always terminated

*For any* allowlisted `Server_Name` whose subprocess was spawned, the `LSP_Proxy`
terminates that subprocess before returning, regardless of which side ended the
session.

**Validates: Requirements 6.4**

### Property 14: Admission and allowlist precede spawn

*For any* Gateway settings and presented credential that the request-admission
policy denies, the LSP route closes the WebSocket and no language server is
spawned; and *for any* `Server_Name` absent from the `Server_Allowlist`, the
`LSP_Proxy` closes the WebSocket with the unknown-server `Application_Close_Code`
and no subprocess is spawned.

**Validates: Requirements 7.1, 7.2, 7.3**

### Property 15: Workspace pinning and rootUri injection

*For any* `Workspace_Root`, a spawned language server's working directory equals
the resolved `Workspace_Root`, and an `initialize` request forwarded through the
`LSP_Proxy` has its `rootUri`, `rootPath`, and `workspaceFolders` set to that
`Workspace_Root`.

**Validates: Requirements 7.4, 7.5**

---

## Testing strategy

Dual approach: property tests (`fast-check` on the frontend, generator-driven
`asyncio.run` tests on the gateway) for universal behavior, and example/
integration/smoke tests for specific scenarios and infrastructure. Each property
test runs a minimum of 100 iterations and is tagged
`Feature: monaco-lsp-integration, Property {n}: {property_text}`.

### Frontend unit tests (`apps/frontend/src/lib/__tests__/` or `features/editor/lsp/__tests__/`)

- **`lsp-connection`** — with a fake `LspSocketFactory` (mirroring
  `index-progress.test.ts`) and fake timers:
  - P1: URL construction over arbitrary ports/servers; `resolveAgentPort` mocked.
  - P2: drive open/close sequences; assert the observed `setTimeout` delay
    schedule equals the capped-doubling sequence and resets on open.
  - P3: dispose after scheduling a reconnect; assert `clearTimeout` + `close`,
    and that firing the (cleared) timer / a later close never calls the factory
    again.
  - P4: emit each close code; assert reconnect-with-backoff for the abnormal
    code, no-reconnect + `error` for the not-installed code, and no reconnect
    after dispose.
- **`lsp-registry`** — pure functions, no store:
  - `serverForLanguage` example locks the six mappings + unmapped `undefined`
    (2.1).
  - P5: `fast-check` over arbitrary open-file arrays — `requiredServers` ==
    running after `reconcile`, set-valued, unmapped excluded.
  - P6: `reconcile(required, required)` yields empty `start`/`stop`
    (idempotence).
- **`lsp-client`** — with a fake `createLanguageClient` and fake socket factory:
  - P7: arbitrary `start`/`stop` sequences; assert `clients` map has ≤1 per
    server and `stop` calls the fake client's `stop`+`dispose`.
- **`lsp-status`** — pure:
  - P9: `formatLspStatus` over all states → correct `state`/`tone`, non-empty
    `label` (style of `status-bar.test.ts`).
  - P8: `isLspActive` over arbitrary language ids + server-state maps.
  - P10: `lspIndicatorViews` over arbitrary open-file arrays → one view per
    distinct mapped Language_Id, none otherwise.
- Example (5.7): a state change updates the store slice synchronously (no timer).
- Smoke (3.1): assert `monaco-languageclient` and `vscode-ws-jsonrpc` are in
  `apps/frontend/package.json` dependencies.

### Gateway unit tests (`services/gateway/tests/test_lsp_proxy.py`, extending existing fakes)

Extend the existing in-memory fakes (no real binary, R7.6):
- `_FakeWebSocket` gains a "hold open" mode where `receive_text` awaits an
  `asyncio.Event` (client stays connected while the server dies).
- `_FakeProcess.wait()` awaits an event set by `terminate()` or an explicit
  `simulate_exit(code)`; constructible with empty stdout (immediate EOF).
- `spawn` fakes that raise `FileNotFoundError` / `PermissionError`.

Tests:
- P11: fake spawn raises `FileNotFoundError` → `closed_code ==
  SERVER_NOT_INSTALLED_CLOSE_CODE`, no exception; `PermissionError` →
  `ABNORMAL_SERVER_TERMINATION_CLOSE_CODE`. Parametrized over the three servers.
- P12: held-open fake WS + dying fake process (stdout EOF / `simulate_exit`) →
  `closed_code == ABNORMAL_SERVER_TERMINATION_CLOSE_CODE`.
- P13: for each server, after any end path that spawned, `process.terminated is
  True` (extends the existing terminate test).
- P14: non-allowlisted name → `closed_code == UNKNOWN_SERVER_CLOSE_CODE`, no
  spawn (existing test kept); plus an `is_request_admitted` property test over
  loopback/non-loopback settings and credentials (the pure admission function),
  and an app-level check that a denied request closes `1008` without spawning.
- P15: `inject_root_uri` sets all three fields (existing tests kept); spawn `cwd`
  equals resolved root (existing test kept), generalized over arbitrary roots.
- Regression (8.5): the full existing `test_lsp_proxy.py` suite passes unchanged.

Integration/manual (not PBT): R4.1–R4.4 (F12/Shift+F12/F2/hover) against a real
server; R6.1 one-spawn-per-connection; R3.2/R3.3 real `MonacoLanguageClient`
handshake.

### Setup / doctor verification

- Smoke (8.1): `make install` in a clean environment installs the three
  binaries (CI/manual).
- Example (8.2, 8.3): run `make doctor`; assert the output names
  `pyright-langserver`, `typescript-language-server`, and `rust-analyzer`, and
  that a simulated-missing binary line includes its install command.
- Table invariant (8.6): every binary the doctor checks has a non-empty install
  command (the checked set equals the install-table keys).

---

## Requirements coverage

| Requirement | Satisfied by |
| --- | --- |
| R1.1–1.6 connection + backoff | `lsp-connection.ts` (injected factory, 500→5000 backoff, authoritative `disposed`); Properties 1–3 |
| R2.1–2.6 on-demand lifecycle | `lsp-registry.ts` `LANGUAGE_SERVERS` + `requiredServers`/`reconcile`; Properties 5, 6 |
| R3.1–3.5 Monaco client registration | `package.json` deps; `lsp-client.ts` singleton map + `MonacoLanguageClient`/`vscode-ws-jsonrpc`; Property 7 |
| R4.1–4.4 editor features | `MonacoLanguageClient` document selectors + Monaco built-in F12/Shift+F12/F2/hover actions (integration) |
| R4.5–4.6 no LSP without connection | `isLspActive` predicate; start registers providers only on `onOpen`, `onClose` deregisters; Property 8 |
| R5.1–5.7 status indicator | `lsp-status.ts` pure `formatLspStatus`/`lspIndicatorViews`; `LspStatusIndicators.tsx` in `StatusBar.tsx`; synchronous slice updates; Properties 9, 10 |
| R6.1–6.7 gateway resilience | new close codes; `FileNotFoundError`/`OSError` classification; three-task exit detection; terminate-on-close; frontend close-code policy; Properties 4, 11, 12, 13 |
| R7.1–7.6 security + testability | unchanged admission/allowlist/pinning/`inject_root_uri`; preserved `Protocol` seams; Properties 14, 15 |
| R8.1–8.6 setup automation | `scripts/install-language-servers.sh` + `make install`; `make doctor` section with install commands; shared binary→command table |
