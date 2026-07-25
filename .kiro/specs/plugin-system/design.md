# Design: Plugin System (Part 5)

## Overview

Two additive frontend capabilities over the existing plugin model
(`plugins.ts`, `plugin-manifest.ts`, `permissions-engine.ts`):

- **5.1 Sandbox** — `apps/frontend/src/lib/plugins-sandbox.ts` (main-thread
  manager) + `apps/frontend/public/plugin-host.js` (worker runtime). One worker
  per plugin; a small `zoc.*` API; privileged calls proxied to the main thread
  and gated by `evaluatePermission`; crashing workers isolated.
- **5.2 Marketplace** — `apps/frontend/src/features/settings/PluginMarketplace.tsx`
  + a pure registry/filter core in `apps/frontend/src/lib/plugin-registry.ts`
  + a bundled `apps/frontend/public/plugins.json` fallback.

The design keeps the *logic* (message routing, permission gating, registry
filtering, install validation) in pure/injectable cores so it is unit- and
property-testable without a real Web Worker, network, or DOM.

## Architecture

```
Command Palette ── invoke ──▶ PluginSandbox (main thread) ──postMessage──▶ Worker (plugin-host.js)
        ▲                          │  worker→main: ready / register-command / api-request / error
        │ register-command         │  main→worker: load / invoke / api-response
        └──────────────────────────┘
                                   │ api-request(terminal.run) ▶ evaluatePermission ─ allow ─▶ runTerminal(gateway)
                                   │                                             └ deny/prompt ▶ { error }
```

### Message protocol (pure, versioned)

Main → worker:
- `{ type: "load", pluginId, code }` — load + evaluate plugin code once.
- `{ type: "invoke", callId, commandId }` — run a registered command handler.
- `{ type: "api-response", reqId, ok, value?, error? }` — reply to an api-request.

Worker → main:
- `{ type: "ready", pluginId }`
- `{ type: "register-command", pluginId, commandId }`
- `{ type: "api-request", pluginId, reqId, api, method, args }`
- `{ type: "invoke-result", callId, ok, error? }`
- `{ type: "error", pluginId, message }`

`routeWorkerMessage(msg, deps)` is a **pure dispatcher**: given a worker→main
message and a `SandboxDeps` bundle (host API handlers + permission check +
terminal runner + error reporter), it returns the list of side-effect
*intents* (e.g. `post-api-response`, `mark-errored`, `register-command`) so the
routing + gating logic is tested without a real worker.

### `plugin-host.js` (worker runtime)

Runs in the worker context. It builds the `zoc` object and evaluates the plugin
code with `zoc` as its only free identifier (via `new Function("zoc", code)`),
so the plugin cannot see `self`, `postMessage` directly, DOM, `fetch`, etc.
Privileged methods return a Promise backed by a `reqId → {resolve,reject}` map;
each call posts an `api-request` and settles when the matching `api-response`
arrives. `zoc.commands.register(id, handler)` stores the handler and posts
`register-command`; an `invoke` message runs the stored handler.

### `plugins-sandbox.ts` (main-thread manager)

```typescript
export interface SandboxDeps {
  workerFactory: (pluginId: string) => SandboxWorker;   // injectable (real Worker by default)
  checkTerminalPermission: (cmd: string) => Decision;   // evaluatePermission wrapper
  runTerminal: (cmd: string) => Promise<string>;        // gateway /v1/terminal
  editor: { getText(): string; setText(s: string): void; getSelection(): string };
  storage: { get(k: string): unknown; set(k: string, v: unknown): void };
  ui: { showMessage(msg: string, level: string): void };
  onRegisterCommand: (pluginId: string, commandId: string) => void;
  onError: (pluginId: string, message: string) => void; // → reportPluginError
}

export interface PluginSandbox {
  load(pluginId: string, code: string): void;
  invokeCommand(pluginId: string, commandId: string): void;
  stop(pluginId: string): void;
  stopAll(): void;
  running(): ReadonlySet<string>;
}
```

`SandboxWorker` is the minimal surface (`postMessage`, `terminate`,
`onmessage`, `onerror`) that a real `Worker` satisfies and a fake implements.

`terminal.run` gating: on an `api-request` with `api === "terminal"`, the
manager calls `checkTerminalPermission(cmd)`; on `allow` it awaits `runTerminal`
and posts `api-response { ok:true, value: output }`; otherwise it posts
`api-response { ok:false, error: "permission denied" }` and never calls
`runTerminal`.

Failure isolation: `worker.onerror` and a worker `error` message both call
`onError(pluginId, message)` then `stop(pluginId)` (terminate + delete), leaving
other entries in the worker map untouched.

### 5.2 Marketplace

`plugin-registry.ts` (pure): `RegistryPlugin` type, `parseRegistry(text)`
(tolerant array parse, drops invalid entries), `filterPlugins(list, query)`
(case-insensitive match on name + tags), and `manifestFromArtifact(bytes,
extract)` which uses an injected `extract` to obtain `manifest.json` text and
returns `parsePluginManifest` output.

`PluginMarketplace.tsx`: fetches the remote registry, falls back to the bundled
`public/plugins.json` on failure; renders a search box + a card grid + an
Installed tab (from `getPlugins()`); the Install button runs the install flow
(fetch artifact → `manifestFromArtifact` → `installPlugin`) with success/error
toasts.

## Correctness Properties

- **P1 — One worker per plugin.** For any sequence of load/stop, the manager's
  worker map holds at most one worker per pluginId; stop terminates it.
- **P2 — API requests round-trip by id.** For any api-request the manager posts
  exactly one api-response with the same reqId, and the worker settles the
  matching pending Promise (and only that one).
- **P3 — terminal.run is permission-gated.** For any command and any permission
  decision, `runTerminal` is invoked iff the decision is `allow`; a non-allow
  decision yields `{ error: "permission denied" }` and zero terminal runs.
- **P4 — Worker failure isolation.** For any set of loaded plugins where one
  worker errors, only that plugin is marked errored and terminated; every other
  worker remains in the map.
- **P5 — Command invocation targets the owning worker.** Invoking a contributed
  command posts exactly one invoke to that plugin's worker and none to others;
  an unloaded plugin's command posts nothing.
- **P6 — Registry filtering.** `filterPlugins(list, q)` returns exactly the
  entries whose name or a tag contains `q` (case-insensitive); an empty query
  returns all entries; order is preserved.
- **P7 — Install validates before adding.** `manifestFromArtifact` returns a
  plugin only when a valid `manifest.json` is extracted; an invalid/missing
  manifest yields errors and installs nothing.

## Testing strategy

- **fast-check** property tests for P1–P7 (`{ numRuns: 200 }`), each tagged
  `Feature: plugin-system, Property N: <text>`.
- A `FakeWorker` (implements `SandboxWorker`, records posted messages, lets the
  test drive `onmessage`/`onerror`) exercises the manager with no real Worker.
- `evaluatePermission` is reused (already unit-tested) as the gate; the sandbox
  test injects decisions directly.
- Component smoke test for `PluginMarketplace` (render grid, filter, installed
  tab) using the existing Testing Library setup.
