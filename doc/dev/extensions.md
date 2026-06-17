# Extension & Plugin Architecture (develop.md Phase 12)

An internal plugin system — deliberately **not** full VS Code compatibility.
Plugins declare a manifest with a `contributes` block; the host installs,
enables/disables, isolates failures, logs activity, and wires contributed
commands/views into the running app. This pass lands the manifest model,
lifecycle, contribution wiring, and host log — all pure/JS-testable. Executing
plugin code in a real sandbox, reading a folder / extracting a zip from disk,
and Open VSX compatibility are deferred to the desktop runtime.

## What landed

| Piece | File |
|-------|------|
| Manifest schema + parser/validator | `apps/frontend/src/lib/plugin-manifest.ts` |
| Plugin host: install/uninstall, enable/disable, error isolation, logs, contributions | `apps/frontend/src/lib/plugins.ts` |
| Contributed-command hook in the registry (`setContributedCommands`) | `apps/frontend/src/lib/commands.ts` |
| Extensions UI (install, toggle, uninstall, host log) | `apps/frontend/src/features/settings/sections/Extensions.tsx` |
| Settings deep-link (`openSettings("extensions")`) + enabled `workbench.view.extensions` command | `apps/frontend/src/lib/store.ts`, `commands.ts` |
| Hydrate plugins at startup | `apps/frontend/src/App.tsx` |

## Manifest

```jsonc
{
  "id": "hello-world",          // [a-z0-9._-], required
  "name": "Hello World",        // required
  "version": "1.0.0",           // semver, required
  "description": "…",
  "activationEvents": ["onStartup"],
  "contributes": {
    "commands":  [{ "id": "hello.say", "title": "Say Hi", "category": "Hello" }],
    "views":     [{ "id": "hello.view", "name": "Hello", "location": "sidebar" }],
    "tasks":     [{ "id": "t", "label": "Build", "command": "make" }],
    "snippets":  [{ "language": "ts", "name": "log", "prefix": "log", "body": "…" }],
    "themes":    [{ "id": "x", "label": "X", "type": "dark" }],
    "languages": [{ "id": "toml", "extensions": [".toml"], "aliases": ["TOML"] }]
  }
}
```

`parsePluginManifest(stringOrObject)` returns `{ manifest, errors }`. Identity
problems (missing/invalid id, name, or version) are **fatal** → `manifest:
null`. Per-contribution problems (a command with no `title`, a view with no
`name`) are collected as errors but don't abort parsing, so the install dialog
can surface every issue at once.

## Host lifecycle & isolation

`lib/plugins.ts` keeps the installed set in memory and persists it to
localStorage (`zoc.plugins`). All mutations are isolated and logged:

- `installPlugin(manifest, source)` → parses; on failure logs an error and
  returns the error list **without throwing** or touching other plugins; on
  success adds/updates by id (preserving the prior enabled state on update).
- `setPluginEnabled(id, on)` / `uninstallPlugin(id)` — re-sync contributions.
- `reportPluginError(id, msg)` — marks a plugin errored (e.g. activation threw);
  its contributions are dropped but it stays visible with the error.
- `getPluginLogs()` / `clearPluginLogs()` — the plugin host log.

**Error isolation** is the core safety property (acceptance check): a bad
manifest or an errored plugin never removes another plugin's contributions and
is always visible in the host log.

## Contributions

`activeContributedCommands()` and `activeContributedViews()` return the
contributions from plugins that are **enabled and not errored**. On every
lifecycle change the host calls `setContributedCommands(...)` in the command
registry, so `getCommands()` (the palette) and `getCommand(id)` (keybindings /
`runCommand`) immediately include or drop a plugin's commands. Disabling or
uninstalling a plugin therefore removes its commands and views (acceptance
check).

> Contributed command `run()` handlers currently record an invocation in the
> host log. Executing real plugin code requires the sandbox runtime (deferred),
> but the contribution is wired end-to-end and observable today.

## UI

Settings → **Extensions** (`ExtensionsSection`): install from a pasted manifest
(stands in for folder/zip install), per-plugin enable/disable switch, uninstall,
a contribution summary (counts + command/view names), and the host log with
clear. The `workbench.view.extensions` command (palette: "View: Show
Extensions") deep-links here via `openSettings("extensions")`.

## Acceptance checks (develop.md)

- **Plugin can contribute one command and one view** — `installPlugin` →
  `getCommand(id)` resolves and `activeContributedViews()` includes the view.
- **Plugin failure is isolated and visible in logs** — bad manifest / errored
  plugin logged, others intact (`plugins.test.ts`).
- **Disabling plugin removes contributed commands/views** — `setPluginEnabled`
  toggles `getCommand(id)` / `activeContributedViews()`.

## Tests

- `src/lib/__tests__/plugin-manifest.test.ts` — full parse, defaults, fatal vs
  per-contribution errors, bad id/version, non-JSON input.
- `src/lib/__tests__/plugins.test.ts` — install/contribute, disable removes,
  error isolation, `reportPluginError`, uninstall, persistence/re-hydrate,
  update preserves enabled state.

Run: `node_modules/.bin/vitest run` from `apps/frontend`. Full suite: 284 green.

## Deferred (runtime)

- Sandboxed plugin code execution (a real activation/host process).
- Install from a local folder or `.zip` on disk (manifest paste stands in here).
- Wiring contributed **views** into the activity bar / panels as live surfaces
  (today they're tracked + listed).
- Contributed tasks/snippets/themes/languages activation (parsed + displayed).
- Open VSX marketplace compatibility.
