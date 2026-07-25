# Requirements: Plugin System (Part 5)

## Introduction

Part 5 completes the plugin system whose manifest model, lifecycle, logs, and
contribution wiring already exist in `apps/frontend/src/lib/plugins.ts` (which
explicitly *defers* actual code execution to "the runtime sandbox"). Two
capabilities are added:

- **5.1 Plugin Sandbox** — execute a plugin's contribution code in an isolated
  Web Worker, exposing only a minimal `zoc.*` API surface (no DOM, no `fetch`,
  no filesystem). Privileged operations (notably `terminal.run`) are proxied to
  the main thread and gated by the existing permission engine. A crashing
  plugin is isolated without affecting the host or other plugins.
- **5.2 Plugin Marketplace** — a Settings panel that lists installable plugins
  from a remote registry (with a bundled offline fallback), supports
  search/filter, install, and an Installed tab, reusing `installPlugin` from
  `plugins.ts`.

Both are frontend-only and additive; the existing `plugins.ts` /
`plugin-manifest.ts` / `permissions-engine.ts` modules are reused, not replaced.

## Requirements

### Requirement 1 — One isolated worker per plugin (5.1)

**User Story:** As a developer, I want each enabled plugin to run in its own
isolated worker, so a plugin cannot touch the DOM, network, or filesystem
directly.

#### Acceptance Criteria
1. WHEN the sandbox loads a plugin THEN it SHALL create exactly one dedicated
   Web Worker for that plugin and post its contribution code as a string.
2. WHEN the worker initializes THEN plugin code SHALL only be able to reference
   a `zoc.*` API object and SHALL NOT have access to `window`/`document`,
   `fetch`, or any filesystem API.
3. WHEN a plugin is stopped or uninstalled THEN the sandbox SHALL terminate its
   worker and remove its registered commands.
4. WHEN the sandbox creates a worker THEN it SHALL do so through an injectable
   factory so the message protocol is testable without a real Web Worker.

### Requirement 2 — The `zoc.*` API surface (5.1)

**User Story:** As a plugin author, I want a small, stable API to interact with
the editor, terminal, storage, and UI.

#### Acceptance Criteria
1. The worker SHALL expose `zoc.commands.register(id, handler)`,
   `zoc.editor.getText()/setText(s)/getSelection()`,
   `zoc.terminal.run(cmd) → Promise<string>`, `zoc.storage.get(k)/set(k,v)`,
   and `zoc.ui.showMessage(msg, level)`.
2. WHEN plugin code calls a privileged API (`editor.*`, `terminal.*`,
   `storage.*`, `ui.*`) THEN the worker SHALL forward the call to the main
   thread as a request with a unique id and SHALL resolve/reject the returned
   Promise when the main thread responds.
3. WHEN the main thread receives an API request THEN it SHALL dispatch it to the
   matching host handler and SHALL post back a response referencing the request
   id.

### Requirement 3 — Permission-gated `terminal.run` (5.1)

**User Story:** As a user, I want plugin terminal commands to obey workspace
trust and permissions, so a plugin cannot run arbitrary commands unchecked.

#### Acceptance Criteria
1. WHEN a plugin calls `zoc.terminal.run(cmd)` THEN the main thread SHALL
   evaluate a `terminal` permission for that command via the permission engine
   before running anything.
2. IF the decision is `allow` THEN the host SHALL run the command via the
   gateway terminal and resolve with its output.
3. IF the decision is `deny` (or `prompt` that is not approved) THEN the host
   SHALL resolve the request with `{ error: "permission denied" }` and SHALL
   NOT run the command.

### Requirement 4 — Command-palette contribution + invocation (5.1)

**User Story:** As a user, I want plugin commands in the command palette and to
actually execute the plugin's handler when I run them.

#### Acceptance Criteria
1. WHEN a loaded plugin registers a command THEN it SHALL appear in the command
   palette under the plugin's name/category with a puzzle-piece affordance.
2. WHEN a contributed command is invoked THEN the sandbox SHALL post an invoke
   message to the owning worker so the registered handler runs.
3. WHEN a contributed command's owning plugin is not loaded/errored THEN the
   command SHALL NOT be invocable.

### Requirement 5 — Worker failure isolation (5.1)

**User Story:** As a user, I want one bad plugin to never break the app or
other plugins.

#### Acceptance Criteria
1. WHEN a worker posts an uncaught error (or its `onerror` fires) THEN the
   sandbox SHALL mark that plugin errored (via `reportPluginError`) and
   terminate its worker.
2. WHEN one plugin's worker fails THEN every other plugin's worker and the host
   SHALL remain running and usable.

### Requirement 6 — Marketplace listing + search (5.2)

**User Story:** As a user, I want to browse and search installable plugins.

#### Acceptance Criteria
1. WHEN the marketplace opens THEN it SHALL fetch the registry from the remote
   URL AND fall back to a bundled `plugins.json` when the fetch fails.
2. WHEN the user types a query THEN the grid SHALL filter live by name and tags.
3. Each plugin card SHALL show name, author, a 2-line description, tags, star
   count, a verified badge when `verified` is true, and an Install button.
4. An "Installed" tab SHALL list installed plugins with enable/disable and
   uninstall controls, reusing the `plugins.ts` lifecycle.

### Requirement 7 — Install flow (5.2)

**User Story:** As a user, I want installing a plugin to validate it and add it
to my plugin list.

#### Acceptance Criteria
1. WHEN the user installs a plugin THEN the app SHALL fetch its artifact,
   extract a `manifest.json`, validate it via `parsePluginManifest`, and on
   success call `installPlugin(manifest, "zip")`.
2. IF the manifest is missing or invalid THEN the install SHALL fail with a
   visible message and SHALL NOT add a plugin.
3. WHEN an install succeeds THEN the app SHALL show a success message and the
   plugin SHALL appear in the Installed tab.

## Non-goals
- Full VS Code / Open VSX API compatibility.
- Real zip extraction is behind an injectable seam; a signed-registry / update
  protocol is out of scope for v1.
