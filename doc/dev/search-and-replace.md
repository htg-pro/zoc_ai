# Workspace search & replace (Phase 3)

A real text search over the workspace with regex / case / whole-word toggles,
include/exclude globs, `.gitignore` awareness, results grouped by file, and a
preview→apply replace flow with one-click undo. The semantic (index-backed)
search is preserved as a separate mode.

## Engine (`crates/hotpath/src/search.rs`)

The hot-path crate (which already has `ignore` + `regex`) hosts the engine:

| Fn | Purpose |
|----|---------|
| `grep(root, &SearchOptions, paths?)` | Walk text files, match per line, group by file with line/column spans. |
| `replace_preview(root, &ReplaceOptions)` | Per-file before/after line previews and counts — no writes. |
| `replace_apply(root, &ReplaceOptions)` | Write replacements; returns each file's original content for undo. |

`SearchOptions`: `query`, `is_regex`, `case_sensitive`, `whole_word`,
`includes`, `excludes`, `use_gitignore`, `max_results`. The regex is built from
the query (escaped unless `is_regex`, wrapped in `\b…\b` for whole-word,
case-insensitive unless `case_sensitive`). The walker uses `ignore`'s
`WalkBuilder` + `OverrideBuilder` for include/exclude globs and a `.gitignore`
toggle, and always skips heavy dirs (`node_modules`, `.git`, `target`, …). Files
over 4 MB are skipped. Replace is applied line-by-line so original line endings
and a trailing newline round-trip exactly; capture groups (`$1`) work.

## Tauri commands (`apps/desktop/src/search_commands.rs`)

`fs_search`, `fs_replace_preview`, `fs_replace_apply` — thin layer that
validates the workspace root (and each path in a replace subset) via
`ensure_within_workspace`, then calls the engine. Registered in `lib.rs`.

## Frontend

`apps/frontend/src/lib/tauri-bridge.ts` — typed `SearchOptions`/`ReplaceOptions`
/results + `fsSearch` / `fsReplacePreview` / `fsReplaceApply` wrappers.

`apps/frontend/src/lib/store.ts` — actions `searchWorkspace`, `previewReplace`,
`applyReplace`, `undoLastReplace`, and `lastReplaceUndo` state. `applyReplace`
refreshes any open editor buffers for changed files (from disk truth) and stashes
the per-file originals; `undoLastReplace` writes them back. All no-op gracefully
outside the desktop runtime.

`apps/frontend/src/features/search/SearchPanel.tsx` — two modes:
- **Text**: query + replace inputs; Match Case / Whole Word / Regex toggles;
  include/exclude globs; results grouped by collapsible file with highlighted
  matches; per-file Replace and Replace All; an Undo-replace affordance. When a
  replacement is typed, results switch to a before/after preview (the
  preview-before-write contract).
- **Semantic**: the original index-backed search (works only with the agent
  index; shows the hash-fallback note).

Text mode is the default on the desktop; in the browser preview only Semantic is
available (the Text tab is disabled, since search needs the Tauri FS).

## Acceptance checks (develop.md)

- Search works without the indexer ✓ (pure filesystem walk; no embeddings).
- Replace uses a preview before writing ✓ (separate preview command + the
  before/after view; apply is an explicit button).
- Replace can be undone ✓ (`undoLastReplace` restores captured originals).

## Tests

- Rust `crates/hotpath/src/search.rs`: grouping + columns, whole-word ×
  case-sensitivity, include/exclude globs, regex + truncation, preview/apply
  round-trip (file untouched by preview; original returned), capture-group
  replacement.
- Frontend `store.test.ts`: `applyReplace` stashes undo + refreshes open
  buffers; `undoLastReplace` restores originals; `searchWorkspace` empty outside
  desktop.
- Frontend `search-text.test.tsx`: text mode renders grouped results; Replace
  All invokes `applyReplace` with the replacement.

## Not yet

Single-match "Replace one" (the bulk engine replaces all matches in a file at
once); the current granularity is Replace-in-file and Replace-all. Streaming
results for very large workspaces (results are currently capped at
`max_results = 5000` and reported as `truncated`).
