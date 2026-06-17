# Editor Workbench (develop.md Phase 9)

Brings the Monaco editor surface up to VS Code / Cursor parity for the
in-editor workbench: split editor groups, tab management, breadcrumbs with an
outline, view toggles (minimap / sticky scroll / breadcrumbs), diagnostics
squiggles, and the common Monaco built-in actions (format document, go to line,
go to symbol) wired through the command registry.

> **Scope / deferrals.** Full cross-file LSP features (go-to-definition across
> files, workspace find-references, rename, code actions, hover, inlay hints)
> are **deferred**. Monaco's bundled TS/JS worker already provides the
> *in-model* versions of these, and they're surfaced as built-in editor
> actions. The offline `outline` extractor below keeps the breadcrumb/outline
> and Go-to-Symbol working for **every** language we ship (TS/JS, Python, Rust,
> Go) without a language server.

## What landed

| Piece | File |
|-------|------|
| Pure symbol extractor (`extractOutline` / `filterOutline`) | `apps/frontend/src/lib/outline.ts` |
| Command ⇄ live-Monaco bridge (`setActiveEditor` / `runEditorAction` / `formatDocument` / `goToLine` / `goToSymbolInFile` / `revealLine`) | `apps/frontend/src/lib/editor-actions.ts` |
| Store: `editorSettings` + `toggleEditorSetting`; split groups (`splitView` / `rightActiveFile` / `splitEditor` / `openToSide` / `closeRightGroup` / `setRightActiveFile`); tab mgmt (`closeOtherFiles` / `closeSavedFiles` / `closeAllFiles`) | `apps/frontend/src/lib/store.ts` |
| Monaco view: minimap / sticky-scroll options, active-editor registration, diagnostics → `setModelMarkers` | `apps/frontend/src/features/editor/MonacoView.tsx` |
| Breadcrumbs + Symbols dropdown | `apps/frontend/src/features/editor/Breadcrumbs.tsx` |
| Tab strip with split-group props + overflow actions menu | `apps/frontend/src/features/editor/EditorTabs.tsx` |
| Two-group layout (left + optional right split) | `apps/frontend/src/features/editor/EditorArea.tsx` |
| Editor commands (format / go-to-line / go-to-symbol / split / toggles) | `apps/frontend/src/lib/commands.ts` |

## Outline extractor

`extractOutline(text, language)` is a dependency-free, line-based scanner that
returns a flat, in-document-order list of `{ name, kind, line }`. It recognizes
top-level declarations per language:

- **TS/JS** (default for unknown languages): `function`, `class`, `interface`,
  `type`, `enum`, and `const X = (…) =>` / `const X = function`.
- **Python**: `def` (including indented methods) and `class`.
- **Rust**: `fn`, `struct`, `enum`, `trait`.
- **Go**: `func` (including receivers), `type … struct`, `type … interface`.

`filterOutline(symbols, query)` is a case-insensitive substring filter used by
the Symbols dropdown. Both are pure and fully unit-tested
(`src/lib/__tests__/outline.test.ts`).

## Editor actions bridge

Monaco editor instances aren't serializable, so they don't live in the Zustand
store. Instead `MonacoView` registers the focused editor with
`setActiveEditor()` on mount and on `onDidFocusEditorText`, and clears it on
unmount. Commands then call thin helpers that trigger Monaco's built-in actions
by id:

| Helper | Monaco action id |
|--------|------------------|
| `formatDocument()` | `editor.action.formatDocument` |
| `goToLine()` | `editor.action.gotoLine` |
| `goToSymbolInFile()` | `editor.action.quickOutline` |
| `revealLine(n)` | (caret move + `revealLineInCenter` + focus) |

Each returns `false` when no editor is focused, so callers/commands degrade
gracefully. Covered by `src/lib/__tests__/editor-actions.test.ts`.

## Split editor groups

`splitEditor()` mirrors the active file into a second group (`splitView=true`,
`rightActiveFile=activeFile`); `openToSide(path)` opens a file directly into the
right group. Both groups share the underlying Monaco model (edits in one show in
the other). `EditorArea` renders a horizontal flex: the left group always, plus
a divider and the right group when `splitView && rightCurrent`. The right
group's `EditorTabs` is driven by `activeFile`/`onSelect` overrides and has a
close-split button. `closeRightGroup()` collapses back to a single group.

Tab management (`closeOtherFiles` / `closeSavedFiles` / `closeAllFiles`) keeps
the right group consistent — it drops `rightActiveFile`/`splitView` whenever the
split target is no longer open.

## View toggles & diagnostics

`editorSettings { minimap, stickyScroll, breadcrumbs }` (breadcrumbs on by
default) is flipped by `toggleEditorSetting(key)` and surfaced as commands and
in the palette. `MonacoView` reads `minimap`/`stickyScroll` into the editor
options; `EditorArea` conditionally renders `Breadcrumbs`.

Diagnostics from Phase 5 (`store.diagnostics`) are pushed into Monaco as
squiggle markers via `monaco.editor.setModelMarkers(model, "zoc-diagnostics",
…)`, mapping our `Severity` to `MarkerSeverity`. Markers refresh whenever the
diagnostics map, the file path, or the editor mount changes.

## Commands & keybindings

New `Editor`-category commands (all run through the registry, so they appear in
the palette and respond to keybindings):

| Command | Keybinding | Action |
|---------|-----------|--------|
| Format Document | `mod+shift+i` | `formatDocument()` |
| Go to Line/Column… | `mod+g` | `goToLine()` |
| Go to Symbol in Editor… | `mod+shift+o` | `goToSymbolInFile()` |
| View: Split Editor | `mod+\` | `splitEditor()` |
| View: Close Split Editor | — | `closeRightGroup()` |
| View: Toggle Minimap | — | `toggleEditorSetting("minimap")` |
| View: Toggle Sticky Scroll | — | `toggleEditorSetting("stickyScroll")` |
| View: Toggle Breadcrumbs | — | `toggleEditorSetting("breadcrumbs")` |

Format / go-to commands disable themselves (with a reason) when there's no
active file; Split disables without an active file; Close Split disables unless
`splitView`.

## Tests

- `src/lib/__tests__/outline.test.ts` — extractor per language + `filterOutline`.
- `src/lib/__tests__/editor-actions.test.ts` — active-editor registration, action
  dispatch, `revealLine`, and `clearActiveEditor` identity check.
- `src/__tests__/store.test.ts` — `toggleEditorSetting`, split lifecycle,
  `setRightActiveFile`, and `closeOtherFiles` / `closeSavedFiles` / `closeAllFiles`.

Run: `node_modules/.bin/vitest run` from `apps/frontend`.
