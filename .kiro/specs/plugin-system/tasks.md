# Implementation Plan: Plugin System (Part 5)

Frontend-only, additive over `plugins.ts`/`plugin-manifest.ts`/`permissions-engine.ts`.
Pure cores first (property-tested with fast-check + a FakeWorker), then wiring.
`*` sub-tasks are tests.

## Progress (2026-07-24)

Built + verified (frontend vitest: 12 tests green; typecheck clean on new files):
- **5.1 sandbox**: `lib/plugins-sandbox.ts` (`createPluginSandbox` manager + pure `resolveApiRequest`; one worker per plugin; permission-gated `terminal.run`; worker failure isolation; invoke routing) + `public/plugin-host.js` (worker runtime: `zoc.*` surface via `new Function("zoc", code)`, reqId Promise map). Property tests P1–P5 (+2) via a `FakeWorker`.
- **5.2 marketplace**: `lib/plugin-registry.ts` (`parseRegistry`/`filterPlugins`/`manifestFromArtifact`) + `features/settings/PluginMarketplace.tsx` (registry fetch + bundled `public/plugins.json` fallback, search, verified cards, Installed tab, install flow) + tests P6/P7 + a component smoke test.

**Task 4.1 live wiring — DONE (2026-07-24 session 3):** `InstalledPlugin`/`installPlugin` now carry optional contribution `code`; `plugins.ts` gained `setPluginCommandInvoker` (contributed-command `run()` routes through it after the `checkAction` plugin gate). `lib/plugin-runtime.ts`: pure `reconcilePlugins` + `initPluginRuntime(sandbox)` (subscribes to the lifecycle, loads/stops workers for enabled+coded plugins, wires the invoker) + `createDefaultPluginSandbox` (real deps: `new Worker("/plugin-host.js")`, permission-gated `terminal.run` via `checkAction`, editor via `editor-actions`, `localStorage`). Mounted once in `App.tsx`. Tests: `plugin-runtime.test.ts` (5) + existing `plugins.test.ts` still green; full plugin suite 32 tests; eslint + typecheck clean. `terminal.run` PTY output capture is best-effort in v1 (injectable `runTerminal`). **Part 5 COMPLETE.**

## Tasks

- [ ] 1. Sandbox message protocol + types (`lib/plugins-sandbox.ts` core)
  - [ ] 1.1 Define `SandboxWorker`, `SandboxDeps`, `PluginSandbox`, the main↔worker
    message types, and the pure `routeWorkerMessage(msg, deps, post)` dispatcher
    (register-command / api-request routing / error → intents).
    - _Requirements: 1.4, 2.2, 2.3, 3.1, 5.1_
  - [ ]* 1.2 Property test: API requests round-trip by id (**P2**). _Req 2.2, 2.3_
  - [ ]* 1.3 Property test: terminal.run permission gating (**P3**). _Req 3.1, 3.2, 3.3_

- [ ] 2. Sandbox manager (`createPluginSandbox`)
  - [ ] 2.1 Implement `load`/`invokeCommand`/`stop`/`stopAll`/`running` over the
    injectable `workerFactory`; wire `onmessage`/`onerror` to `routeWorkerMessage`;
    terminate on stop and remove commands.
    - _Requirements: 1.1, 1.3, 4.2, 4.3_
  - [ ]* 2.2 Property test: one worker per plugin (**P1**). _Req 1.1, 1.3_
  - [ ]* 2.3 Property test: worker failure isolation (**P4**). _Req 5.1, 5.2_
  - [ ]* 2.4 Property test: invoke targets the owning worker (**P5**). _Req 4.2, 4.3_

- [ ] 3. Worker runtime (`public/plugin-host.js`)
  - [ ] 3.1 Build the `zoc.*` surface (commands/editor/terminal/storage/ui),
    evaluate plugin code with `zoc` as its only free identifier, back privileged
    methods with a `reqId` Promise map, and handle `load`/`invoke`/`api-response`.
    - _Requirements: 2.1, 2.2, 4.1_

- [ ] 4. Wire the sandbox into the plugin host + command palette
  - [ ] 4.1 On enable/disable, `load`/`stop` the plugin in the sandbox; route
    contributed-command invocation through `invokeCommand`; report worker errors
    via `reportPluginError`.
    - _Requirements: 4.1, 4.2, 5.1_

- [ ] 5. Marketplace registry core (`lib/plugin-registry.ts`)
  - [ ] 5.1 `RegistryPlugin`, `parseRegistry`, `filterPlugins`, `manifestFromArtifact(extract)`.
    - _Requirements: 6.1, 6.2, 7.1, 7.2_
  - [ ]* 5.2 Property test: registry filtering (**P6**). _Req 6.2_
  - [ ]* 5.3 Property test: install validates before adding (**P7**). _Req 7.1, 7.2_

- [ ] 6. Marketplace UI (`features/settings/PluginMarketplace.tsx`) + bundled `public/plugins.json`
  - [ ] 6.1 Registry fetch + offline fallback, search box, card grid (verified
    badge, tags, stars), Installed tab (enable/disable/uninstall), install flow.
    - _Requirements: 6.1, 6.3, 6.4, 7.1, 7.3_
  - [ ]* 6.2 Component smoke test: render, filter, installed tab.

- [ ] 7. Final verification: `vitest run` for the new suites; typecheck clean on new files.

## Notes
- No real Web Worker in tests: a `FakeWorker` implements `SandboxWorker`.
- `evaluatePermission` (already tested) is the terminal gate.
- Real zip extraction is an injected `extract` seam; v1 default handles a
  manifest-json artifact.
