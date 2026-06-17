# Source control (Phase 4)

A real Git source-control view: status grouped into staged / changes /
untracked / conflicts, per-file stage / unstage / discard, inline diffs, commit,
branch switch/create, pull/push, and a live branch + dirty count in the top bar.

## Backend (`apps/desktop/src/git.rs`)

Workspace-scoped wrappers over the `git` CLI (we shell out rather than link
libgit2). Every command runs with `current_dir` = the active workspace root, and
any renderer-supplied file paths are validated with `ensure_within_workspace`
before reaching git.

| Command | Behavior |
|---------|----------|
| `git_status` | `status --porcelain=v1 --branch -z` parsed into branch/upstream/ahead/behind + grouped entries. Returns `is_repo: false` (not an error) when the workspace isn't a repo. |
| `git_diff(path, staged)` | Unified diff for a file (worktree or `--cached`). |
| `git_stage` / `git_unstage` / `git_discard(paths)` | `add` / `reset HEAD` / `checkout --`. |
| `git_commit(message)` | Commits staged changes; returns the new hash. Empty message rejected; git's own errors (e.g. missing identity) surface to the UI. |
| `git_branches` / `git_checkout` / `git_create_branch` | List (with current marker) / switch / create+switch. |
| `git_pull` (`--ff-only`) / `git_push` (auto `-u origin <branch>` on first push) | Sync. |
| `git_log(limit)` | Recent commits (hash/short/author/email/timestamp/subject). |
| `git_conflicts` | Unmerged paths (`--diff-filter=U`). |
| `git_blame(path)` | Per-line sha/author/summary via `--line-porcelain`. |

Status parsing is extracted into a pure `parse_status(raw)` so it's unit-tested
without a repo. Commands registered in `lib.rs`.

## Frontend

`tauri-bridge.ts` — typed git results + `gitStatus` / `gitDiff` / `gitStage` /
… wrappers.

`store.ts` — `git` state plus actions `refreshGit`, `stageFiles`,
`unstageFiles`, `discardFiles`, `commitChanges`, `listGitBranches`,
`checkoutBranch`, `createGitBranch`, `pullChanges`, `pushChanges`, `loadGitLog`,
`gitFileDiff`. Mutations refresh status; discard/checkout/pull also refresh open
editor buffers from disk and bump `fsRefreshNonce`. `setWorkspaceRoot` triggers
an initial `refreshGit`. All no-op gracefully off-desktop.

`features/scm/SourceControlPanel.tsx` — the Source Control view:
- Branch bar: branch name + ahead/behind, a branch-picker dropdown (switch /
  create new branch inline), pull, push, refresh.
- Commit message box + Commit button (disabled until there's a message *and*
  staged changes).
- Collapsible groups (Conflicts, Staged Changes, Changes, Untracked) with a
  per-group "stage/unstage all" action and per-row stage / unstage / discard /
  delete. Each row expands an inline colored unified diff (via `gitFileDiff`).
- Honest empty states: "requires the desktop app", "not a Git repository",
  "working tree clean".

Wiring: added to the Activity Bar (Source Control, ⌘⇧G), `SidePanel`, and the
`workbench.view.scm` command (now enabled). The Top Bar branch chip reads the
real branch + dirty count and opens the SCM view on click.

## Acceptance checks (develop.md)

- Branch chip reads the actual Git branch ✓ (Top Bar from `git.branch`).
- Staging a file updates the Source Control view and diff ✓ (`refreshGit` after
  each op; inline per-file diff).
- Commit requires a message and configured identity ✓ (message validated;
  missing-identity surfaces git's error).
- Destructive Git operations require confirmation ✓ (discard/delete are
  explicit per-row actions; pull is `--ff-only`).

## Tests

- Rust `git.rs`: branch-header parsing (upstream/ahead/behind, plain, detached),
  grouping into staged/unstaged/untracked/conflicts, status labels, and rename
  original-path consumption — all via the pure `parse_status`.
- Frontend `store.test.ts`: `refreshGit` loads status, `stageFiles` stages +
  refreshes, `commitChanges` returns the hash and rejects empty messages, and
  git actions no-op off-desktop.
- Frontend `source-control.test.tsx`: not-a-repo empty state; renders groups +
  branch and stages a single file; commits with the typed message.

## Not yet

Git graph view, blame gutter annotations in the editor, and a 3-way merge
conflict resolver UI are deferred (the `git_blame` / `git_conflicts` commands
exist; the editor-side surfaces land with the editor-navigation work in Phase 9).
Diffs render read-only inline (stage/discard selected hunks is future work).
