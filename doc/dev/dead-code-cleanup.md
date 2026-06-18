# Dead File / Code Cleanup

A conservative pass to remove genuinely dead files from the repo. Only items
with **zero references** and a clear "why" were removed, and only **tracked**
files (recoverable from git history if a removal turns out wrong). Untracked
candidates are documented but left in place, since their deletion would be
unrecoverable.

After the cleanup: frontend `tsc --noEmit` clean, **122 frontend tests pass**,
backend untouched.

## Deleted (tracked → recoverable via git)

| File / dir | Why it's dead | Evidence |
|------------|---------------|----------|
| `Text File.txt` | Scratch file — a bug-investigation prompt, a Mermaid architecture diagram, and the (now-redacted) Groq key. Never imported, built, or referenced. | No code/build reference; was a one-off note committed in the `testsprite` snapshot. |
| `apps/frontend/src/features/agent/AgentEmptyState.tsx` | Exported React component (`AgentEmptyState`) with **zero importers**. The agent timeline uses the separate, in-use `EmptyState.tsx`. | `grep "AgentEmptyState"` matches only its own definition; `EmptyState` is the one imported by `AgentTimeline.tsx`. |
| `src-tauri/gen/schemas/acl-manifests.json` | Orphaned Tauri-generated ACL/capability schemas at the **repo root**. The real Tauri app is `apps/desktop`, which generates into `apps/desktop/gen/` (gitignored). The root is not a Tauri project and not a Cargo workspace member. | `Cargo.toml` workspace = `apps/desktop`, `crates/hotpath` only; no reference to root `src-tauri` in `package.json`/`tauri.conf.json`/`scripts`. |
| `src-tauri/gen/schemas/capabilities.json` | Same as above. | Same. |
| `src-tauri/gen/schemas/desktop-schema.json` | Same as above. | Same. |
| `src-tauri/gen/schemas/linux-schema.json` | Same as above. | Same. |
| `src-tauri/` (now-empty dir) | Removed after its only contents (the stray `gen/schemas`) were deleted. | — |
| `apps/frontend/tsconfig.tsbuildinfo` | TypeScript **incremental build cache** accidentally committed. Regenerated on every `tsc` run; should never be in version control. | Build artifact; now added to `.gitignore` as `*.tsbuildinfo`. |

## Also changed

- `.gitignore`: added `*.tsbuildinfo` so the TS build cache can't be
  re-committed.

## Investigated and KEPT (not dead)

To avoid false positives, these plausible-looking candidates were checked and
**kept** because they are actually used:

- `*.stories.tsx` (`agent.stories.tsx`, `marketing.stories.tsx`,
  `button.stories.tsx`, …) — consumed by **Ladle** (`apps/frontend/.ladle/config.mjs`
  globs `src/**/*.stories.{ts,tsx}`).
- `apps/frontend/src/lib/mock-data.ts` — imported by the store, `FileTree`,
  `IndexerPanel`, `Models`, `MemoryIndicator`, `CommandPalette`, `ShowcaseView`,
  and the stories.
- `features/showcase/ShowcaseView.tsx` — rendered in `Shell` and covered by
  `showcase.test.tsx`.
- All other `features/agent/*` components (`AgentMenu`, `ContextLimitDialog`,
  `MessageItem`, `ModelPicker`, `ToolCallCard`, `SlashAutocomplete`,
  `AttachmentChips`, `DiffCard`, `MemoryIndicator`, `ContextBar`) — each has ≥1
  external importer.
- `replit_workflow.py` and the legacy planning layer — **not dead**, just
  pending the deliberate collapse documented in
  [`agent-collapse-plan.md`](./agent-collapse-plan.md). Do not delete ad hoc.

## Candidates NOT deleted (need your confirmation — unrecoverable)

These are **untracked** (not in git), so deleting them can't be undone. They
look abandoned but may be intentional local experiments — please confirm before
removing:

- `python/` (root) — contains `zoc_studio_neural/` and `tests/`. **Not** a uv
  workspace member (`pyproject.toml` lists only `services/agent` and
  `packages/shared-types/python`) and not referenced by any build. Almost
  certainly an old experiment. To remove: `rm -rf python/` (after confirming
  there's nothing you want to keep).
- Build caches on disk (`.mypy_cache/`, `.ruff_cache/`, `.pytest_cache/`,
  `**/__pycache__/`) — already gitignored and regenerated; harmless clutter.
  Optional: `git clean -ndX` to preview, then `-fdX` to remove ignored files.

## Reference material left intact

`zoc-ai-redesign-code/`, `.kombai/` (design canvases), `attached_assets/`,
`doc/*.me`, and `agent.me` are design/reference/notes, not dead code. They were
intentionally retained.
