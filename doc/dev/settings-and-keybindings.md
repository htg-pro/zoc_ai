# Settings, Profiles & Keybindings (develop.md Phase 10)

A typed settings system with **user** and **workspace** scopes, a settings
search, a full keybindings editor (with conflict detection + a raw JSON editor),
and four switchable profiles with import/export. Everything is built on small,
pure `lib/*` modules so it unit-tests without a DOM; persistence is localStorage
(the desktop shell can later route the same JSON shapes to real `settings.json`
files).

## What landed

| Piece | File |
|-------|------|
| Settings registry, scopes, merge, search, get/set/reset, pub/sub | `apps/frontend/src/lib/settings.ts` |
| Keybinding overrides, conflict detection, JSON import/export | `apps/frontend/src/lib/keybinding-overrides.ts` |
| Profiles (4 built-ins) + import/export | `apps/frontend/src/lib/profiles.ts` |
| Store: `applyEffectiveSettings()`, settings-aware `toggleEditorSetting` | `apps/frontend/src/lib/store.ts` |
| `matchKeybinding` consults user overrides | `apps/frontend/src/lib/commands.ts` |
| Apply settings at startup | `apps/frontend/src/App.tsx` |
| Settings UI: search box + new tabs | `apps/frontend/src/features/settings/SettingsView.tsx` |
| General (registry-driven), Keybindings, Profiles sections | `apps/frontend/src/features/settings/sections/{General,Keybindings,Profiles}.tsx` |

## Scopes & merge

The effective value of a setting is computed as:

```
default  <  user  <  workspace
```

`user` settings apply across every workspace; `workspace` settings override the
user value for the current project. Both scopes are stored as JSON under
`zoc.settings.user` / `zoc.settings.workspace`. `effectiveSource(key)` reports
which scope a value currently comes from (shown as a badge in the UI).

`applyEffectiveSettings()` (in the store) pushes the merged values into runtime
state — editor toggles (`editorSettings`) and `autonomy` live-update; the
default conversation mode (`agent.defaultMode`) is seeded once at startup via
`applyEffectiveSettings({ includeMode: true })`. The Phase 9
`toggleEditorSetting` now also writes through to the user scope so the editor's
view toggles and the Settings page stay in sync.

> **Registry discipline.** Only settings that are actually wired into the app
> are in `SETTINGS_REGISTRY` (editor minimap/sticky-scroll/breadcrumbs/font-size,
> agent default-mode/autonomy). Adding a row here without wiring it would be a
> dead toggle, so don't.

### Validation

`coerce(spec, value)` returns a valid value or `undefined`: booleans must be
boolean, numbers must be in `[min, max]`, enums must be a known option.
`sanitizeScope` drops unknown keys and invalid values on load and save, so a
hand-edited or imported file can never poison runtime state.

## Settings search

`searchSettings(query)` is a case-insensitive substring match over
label/key/description/category. The Settings sidebar has a search box that
filters the **Settings** (General) tab live; typing there also switches to that
tab.

## Keybindings editor

The command registry ships default chords; `keybinding-overrides.ts` layers a
persisted per-command map on top (`zoc.keybindings.overrides`). An override is
either a normalized chord string (`"mod+shift+p"`) or `null` to explicitly
**unbind** a default. `effectiveKeybinding(cmd)` resolves override → default, and
`matchKeybinding` (the global key handler) now consults it, so customizations
take effect immediately and survive restarts.

- **Recording** — clicking a binding captures the next chord via
  `eventToKeybinding`; `Escape` cancels.
- **Conflicts** — `detectConflicts(commands)` finds chords bound to more than
  one command; conflicting rows are highlighted and a banner lists them.
  `wouldConflict(...)` warns at assignment time.
- **JSON editor** — `exportKeybindings()` / `parseKeybindingsJson()` back an
  "Edit JSON" panel for power users; malformed JSON is rejected with a message.
- **Reset** — per-command reset and "Reset all".

## Profiles

Four built-in profiles (`default`, `local-first`, `cloud-agent`,
`strict-approval`) each carry a bundle of setting values. `applyProfile(id)`
validates and writes them into the **user** scope and records the active profile
(`zoc.profile.active`), so a workspace can still override individual keys
afterward.

Import/export is portable JSON carrying both settings and keybinding overrides:
`exportProfile()` serializes the current user settings + overrides;
`importProfile(json)` / `parseProfileExport(json)` sanitize and merge them in.
The Profiles UI copies the export to the clipboard and accepts a pasted import.

## Acceptance checks (develop.md)

- **User setting applies across workspaces** — user scope has no workspace key.
- **Workspace setting overrides user setting** — merge order + `effectiveSource`.
- **Keybinding changes survive restart** — persisted to localStorage, read by
  `matchKeybinding`.
- **Conflicts are visible** — `detectConflicts` + the banner/row highlight.

## Tests

- `src/lib/__tests__/settings.test.ts` — coerce, sanitize, merge, set/get/reset,
  effectiveSource, search.
- `src/lib/__tests__/keybinding-overrides.test.ts` — chord validation, override
  precedence/unbind, conflict + would-conflict detection, JSON round-trip.
- `src/lib/__tests__/profiles.test.ts` — the four profiles, apply, active id,
  import/export round-trip + sanitization.
- `src/__tests__/store.test.ts` — `applyEffectiveSettings` pushes persisted
  settings into runtime state.

Run: `node_modules/.bin/vitest run` from `apps/frontend`.

## Deferred

- A real `settings.json` file on disk (currently localStorage; the shapes are
  file-ready).
- Settings sync to a remote — out of scope; export/import is the local backup.
