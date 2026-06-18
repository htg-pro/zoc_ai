# Zoc AI Full IDE Development Roadmap

This file collects the missing product and engineering work needed to move Zoc AI from an agentic coding shell toward a full AI IDE comparable to Cursor and VS Code.

The current project already has a strong base: Tauri desktop shell, React/Vite frontend, FastAPI sidecar, Rust hotpath, Monaco editor, xterm terminal, live agent sessions, tool calls, approvals, diff review, isolated review-before-apply, checkpoints, memory, model/provider settings, and workspace indexing.

The largest gap is not the agent chat panel. The missing work is the developer IDE layer around it: command infrastructure, file operations, source control, debugging, diagnostics, tasks, extensions, richer search, terminal management, deeper agent tooling, and the UI/UX details included later in this file.

## Guiding Goal

Build Zoc AI as a real developer workbench first, with the AI agent integrated everywhere rather than isolated in the right panel.

Every major user action should be available through:

- A visible button or menu where users expect it.
- A command palette command.
- A keyboard shortcut where common.
- A typed frontend action.
- A backend or Tauri API when it touches disk, shell, Git, diagnostics, debug, or extensions.
- Tests for the state transition and error path.

## Phase 1 - Command System And Palette

> STATUS: ✅ Implemented. See [`doc/dev/command-system.md`](doc/dev/command-system.md).
> Central registry at `apps/frontend/src/lib/commands.ts` (ids, titles,
> categories, keybindings, aliases, enablement, disabled-reasons, handlers);
> keybindings + palette both resolve through it; palette has Go-to-File /
> command (`>`) / symbol (`@`) modes backed by live `searchContextCandidates`
> (no mock data in live mode); recent files/commands; unavailable views (SCM /
> Debug / Extensions) listed but disabled with a reason. Remaining: routing the
> rest of the toolbar/activity-bar buttons through `runCommand` (incremental),
> and richer symbol results once the symbol index lands.

Current state:

- `CommandPalette.tsx` uses `MOCK_FILE_CONTENT` for file results.
- `key-bindings.ts` only supports a small hardcoded shortcut set.
- There is no central command registry.
- Palette text promises files, commands, and settings, but does not provide real workspace-backed command coverage.

Implement:

- Create a central command registry in `apps/frontend/src/lib/commands.ts`.
- Add command IDs, titles, categories, default keybindings, enablement predicates, and handlers.
- Route Activity Bar, Top Bar, Bottom Dock, Agent buttons, Diff buttons, and Settings buttons through commands where practical.
- Replace mock palette file search with live workspace file search.
- Add Quick Open mode for files.
- Add command mode for all commands.
- Add settings search mode.
- Add symbol mode once symbol index is available.
- Add recent files and recently used commands.
- Add command aliases for Cursor/VS Code familiar names.

Required commands:

- `workbench.action.quickOpen`
- `workbench.action.showCommands`
- `workbench.view.explorer`
- `workbench.view.search`
- `workbench.view.scm`
- `workbench.view.debug`
- `workbench.view.extensions`
- `workbench.action.terminal.toggleTerminal`
- `workbench.action.tasks.runTask`
- `workbench.action.debug.start`
- `workbench.action.files.save`
- `workbench.action.files.saveAll`
- `workbench.action.files.revert`
- `zoc.agent.ask`
- `zoc.agent.run`
- `zoc.agent.reviewChanges`
- `zoc.agent.applyRun`
- `zoc.agent.discardRun`
- `zoc.agent.restoreCheckpoint`

Acceptance checks:

- Command palette never reads from `MOCK_FILE_CONTENT` in live mode.
- Every Activity Bar item is openable from the palette.
- Shortcuts use the same registry as palette commands.
- Disabled commands explain why they are disabled.

## Phase 2 - Explorer File Operations

> STATUS: ✅ Implemented. See [`doc/dev/file-operations.md`](doc/dev/file-operations.md).
> Tauri commands `fs_stat/create_file/create_dir/rename/move/delete/duplicate/reveal`
> (all workspace-scoped via `ensure_within_workspace`, both endpoints validated
> for move/rename). Explorer UI: toolbar (new file/folder, refresh, collapse),
> right-click context menu, inline create + in-place rename, delete confirmation
> (with unsaved-changes warning), drag-and-drop move, copy path / relative path.
> Open editor tabs follow rename/move and close on delete. Rust + frontend tests
> cover the workspace-escape rejection and the tab-sync logic. Remaining:
> multi-select / Compare Selected / Open to Side (Phase 9), Open in Integrated
> Terminal (Phase 8).

Current state:

- `FileTree.tsx` can list and open files.
- Tauri commands expose `fs_list_dir`, `fs_read_text`, `fs_write_text`, `fs_watch_start`, and `fs_watch_stop`.
- There is no frontend context menu for file management.
- There are no Tauri commands for create directory, rename, delete, move, reveal in OS, copy path, or duplicate.

Implement Tauri commands:

- `fs_create_file`
- `fs_create_dir`
- `fs_rename`
- `fs_delete`
- `fs_move`
- `fs_duplicate`
- `fs_reveal`
- `fs_copy_path`
- `fs_stat`

Implement Explorer UI:

- New File button.
- New Folder button.
- Rename.
- Delete with confirmation.
- Duplicate.
- Move by drag/drop.
- Multi-select.
- Compare selected.
- Open to side.
- Open in integrated terminal.
- Reveal in native file explorer.
- Copy absolute path.
- Copy relative path.
- Collapse all.
- Refresh.
- Filter tree.
- Respect ignored folders and configured excludes.

Acceptance checks:

- All file operations reject paths outside the active workspace.
- File watcher refreshes changed folders after create/rename/delete/move.
- Open editor tabs update after rename/move.
- Deleting an open dirty file asks for confirmation.

## Phase 3 - Real Workspace Search And Replace

> STATUS: ✅ Implemented. See [`doc/dev/search-and-replace.md`](doc/dev/search-and-replace.md).
> Engine in `crates/hotpath/src/search.rs` (`grep` / `replace_preview` /
> `replace_apply`) using `ignore` + `regex`: regex/case/whole-word, include/
> exclude globs, `.gitignore` toggle, grouped line/column matches, line-by-line
> replace preserving endings + capture groups. Tauri commands `fs_search` /
> `fs_replace_preview` / `fs_replace_apply` (workspace-validated). UI: Text mode
> (toggles, globs, grouped results, per-file + all replace, before/after preview,
> undo) plus the preserved Semantic mode. Works without the indexer; replace
> previews before writing; undo restores originals. Remaining: single-match
> "replace one" and streaming for very large repos (currently capped at 5000
> matches, reported as truncated).

Current state:

- `SearchPanel.tsx` only uses semantic index query.
- There is no global text search/replace.
- No regex, case-sensitive, whole-word, include/exclude globs, or replace preview.

Implement backend/Tauri search:

- Workspace text search powered by ripgrep or Rust hotpath.
- Stream results for large workspaces.
- Support regex, case-sensitive, whole-word.
- Support include/exclude globs.
- Support `.gitignore`.
- Support replace preview and apply.

Implement UI:

- Search input.
- Replace input.
- Regex/case/word toggles.
- Include files.
- Exclude files.
- Result tree grouped by file.
- Match preview with line/column.
- Replace one, replace file, replace all.
- Preserve semantic search as separate mode or tab.

Acceptance checks:

- Search works without indexer.
- Replace uses preview before writing.
- Replace can be undone by checkpoint/local history.

## Phase 4 - Source Control

> STATUS: ✅ Implemented. See [`doc/dev/source-control.md`](doc/dev/source-control.md).
> Git layer in `apps/desktop/src/git.rs` (status/diff/stage/unstage/discard/
> commit/branches/checkout/create-branch/pull/push/log/conflicts/blame), all
> workspace-scoped via the `git` CLI; pure `parse_status` is unit-tested. Store
> actions + `git` state; `SourceControlPanel` (branch bar with switch/create,
> commit box, staged/changes/untracked/conflicts groups, per-file stage/unstage/
> discard + inline diffs, pull/push); Activity Bar item (⌘⇧G) + `workbench.view.scm`
> command; real branch + dirty count in the Top Bar. Remaining: git graph,
> blame gutter, 3-way conflict resolver, and stage-selected-hunks (Phase 9-era
> editor surfaces; `git_blame`/`git_conflicts` commands already exist).

Current state:

- Backend agent tools have `get_git_status` and `get_git_diff`.
- TopBar branch chip is hardcoded to `main`.
- There is no Source Control Activity Bar view.
- No staging, committing, branch switch, graph, blame, conflict UI, or Git timeline.

Implement backend/Tauri Git APIs:

- `git_status`
- `git_diff`
- `git_stage`
- `git_unstage`
- `git_commit`
- `git_branches`
- `git_checkout`
- `git_create_branch`
- `git_pull`
- `git_push`
- `git_log`
- `git_blame`
- `git_conflicts`
- `git_discard`

Implement UI:

- Source Control Activity Bar item.
- Change groups: staged, unstaged, untracked, conflicts.
- Per-file stage/unstage/discard.
- Commit message box.
- Commit button.
- Branch selector.
- Sync button.
- Diff editor integration.
- Git graph view.
- Blame annotation toggle.
- Merge conflict resolver.
- Status Bar branch and dirty count.

Acceptance checks:

- Branch chip reads actual Git branch.
- Staging a file updates the Source Control view and diff.
- Commit requires message and configured Git identity.
- Destructive Git operations require confirmation.

## Phase 5 - Diagnostics, Problems, Logs, And Output

> STATUS: ✅ Implemented. See [`doc/dev/diagnostics.md`](doc/dev/diagnostics.md).
> Pure problem-matcher parsers (`lib/problem-matchers.ts`: tsc/eslint/ruff/cargo),
> the allow-listed `run_check` Tauri command (`apps/desktop/src/checks.rs`),
> store diagnostics/output/logs slices + `runDiagnostics`, and real Problems /
> Logs / Output panels (Output channel selector; agent `log` SSE events routed
> into the Logs buffer + Agent channel). Problems is empty with no diagnostics,
> populates on running a checker with clickable entries, and shows a count badge.
> Remaining: on-save/streaming diagnostics, LSP-backed diagnostics, and task
> problem matchers beyond the four checkers (Phase 6).

Current state:

- `ProblemsPanel.tsx` uses static sample problems.
- `LogsPanel.tsx` uses static sample logs.
- There is no diagnostic event store.
- No problem matcher pipeline.
- No output channels.

Implement:

- Diagnostic store in frontend.
- Backend event stream for diagnostics/logs.
- Output channel abstraction.
- Task output parser with problem matchers.
- LSP/compiler diagnostics bridge.
- Problems panel backed by real diagnostics.
- Logs panel backed by sidecar/Tauri events.
- Output panel with selectable channels.

Sources of diagnostics:

- TypeScript.
- ESLint.
- Python pytest/ruff/compileall.
- Rust cargo check.
- Agent validation.
- Task problem matchers.
- Future LSP servers.

Acceptance checks:

- Problems panel is empty when no diagnostics exist.
- Running validation populates Problems with clickable file/line entries.
- Logs panel shows real sidecar/desktop events.
- Output panel can show Agent, Git, Tasks, MCP, Terminal, and Extension Host channels.

## Phase 6 - Task Runner And Test Explorer

> STATUS: ✅ Implemented (core). See [`doc/dev/tasks.md`](doc/dev/tasks.md).
> Pure discovery (`lib/tasks.ts`: tasks.json JSONC, npm/cargo/make/python), the
> `run_task` Tauri command, store `discoverTasks`/`runTask`/`runBuildTask`/
> `runTestTask` (output → Tasks channel, problem matcher → diagnostics, pass/fail
> status), Tasks bottom-dock panel (tests-first = Test Explorer role), and
> commands incl. ⌘⇧B for the build task. Remaining: output *streaming* +
> *cancellation* and background/watch tasks (share the PTY infra from Phase 8),
> and a per-test-case Test Explorer (today runs test tasks at task granularity).

Current state:

- Backend validation can discover project checks.
- `runTests` currently routes to test generation or an agent prompt.
- No task picker, task config, build task, test task, problem matcher UI, or Test Explorer.

Implement:

- Parse `.vscode/tasks.json` where present.
- Add Zoc task config fallback at `.zoc/tasks.json`.
- Auto-detect package scripts, cargo commands, Python commands, Makefile targets.
- Add Run Task command.
- Add Run Build Task command.
- Add Run Test Task command.
- Add task terminal presentation modes.
- Add problem matcher support.
- Add background/watch task support.
- Add Test Explorer Activity Bar item or bottom tab.

Acceptance checks:

- `Ctrl/Cmd+Shift+B` runs default build task.
- Task output streams to terminal/output panel.
- Problem matchers populate Problems.
- Tasks can be cancelled.

## Phase 7 - Run And Debug

> STATUS: ◑ Partially implemented (everything except the live adapter). See
> [`doc/dev/run-and-debug.md`](doc/dev/run-and-debug.md). Done: breakpoint model +
> store, the Monaco gutter (click to toggle, red glyphs), `launch.json` /
> `.zoc/launch.json` parsing (`lib/launch-configs.ts`), the Run & Debug Activity
> Bar view (config picker, breakpoints list, Variables/Watch/Call Stack
> placeholders), and ⌘⇧D. Deferred (needs the Phase 8 long-lived process
> runtime, shared with the terminal): the Debug Adapter Protocol client that
> spawns debugpy/node/lldb and drives stepping/variables/console — F5/Start are
> present but disabled with a reason until then.

Current state:

- No debug Activity Bar item.
- No breakpoint model.
- No debug adapter protocol integration.
- No launch configuration UI.
- No variables, watch, call stack, debug console, or debug toolbar.

Implement:

- Debug Activity Bar item.
- Breakpoint gutter support in Monaco.
- Breakpoint store.
- Parse `.vscode/launch.json`.
- Add `.zoc/launch.json` fallback.
- Debug Adapter Protocol client.
- Built-in Node/JS debug starter.
- Python debug via debugpy when available.
- Rust debug via lldb/gdb adapter when available.
- Debug toolbar: continue, pause, step over, step into, step out, restart, stop.
- Debug Console bottom tab.
- Variables, Watch, Call Stack, Breakpoints side views.

Acceptance checks:

- F5 starts selected debug configuration.
- Clicking editor gutter toggles breakpoint.
- Debug console receives runtime output.
- Stop terminates adapter and target process.

## Phase 8 - Terminal Upgrade

> STATUS: ✅ Implemented (core). See [`doc/dev/terminal.md`](doc/dev/terminal.md).
> Multi-session store model + platform-aware profiles; a `terminal-manager`
> singleton that owns xterm + the sidecar PTY in detached containers (sessions
> persist across bottom-dock tab switches); `TerminalPane` with tabs, profile
> dropdown, new/kill/rename, split view, find (Ctrl/Cmd+F), exit-status badges,
> and `file:line` clickable links. The fake hardcoded agent-approval overlay was
> removed (real approval is the agent panel's permission card). Remaining:
> shell-integration decorations (OSC 133), copy/paste + open-at-folder
> affordances, and rewiring task streaming/cancellation + the debug adapter onto
> this process channel.

Current state:

- `TerminalPane.tsx` spawns one default shell.
- No terminal tabs, splits, profiles, restart, kill, or terminal search.
- Agent control overlay is fake and hardcoded.

Implement:

- Terminal session list in store.
- Terminal tabs.
- Split terminals.
- Terminal profiles dropdown.
- New terminal button.
- Kill terminal.
- Restart terminal.
- Rename terminal.
- Terminal find.
- Copy/paste actions.
- Open terminal at selected folder.
- Shell integration decorations.
- Command exit status tracking.
- Clickable file/line links.
- Real agent terminal governance using permission flow.

Acceptance checks:

- Multiple terminals persist while switching bottom tabs.
- Terminal kill stops backend session.
- Shell profile selection is honored.
- Agent approval card shows actual command and result.

## Phase 9 - Editor Workbench Features

> **STATUS: DONE (core) — 2026-06-16.** Implemented split editor groups
> (`splitEditor`/`openToSide`/`closeRightGroup`/`setRightActiveFile`, two-group
> `EditorArea` sharing models), tab management (close others/saved/all + Save
> All/Revert from Phase 1), breadcrumbs with an outline Symbols dropdown,
> minimap / sticky-scroll / breadcrumb toggles, an offline outline extractor
> (`lib/outline.ts`, TS/JS/Py/Rust/Go), diagnostics squiggles
> (`setModelMarkers`), and Monaco built-in actions wired as commands:
> Format Document (`mod+shift+i`), Go to Line (`mod+g`), Go to Symbol in Editor
> (`mod+shift+o`), Split Editor (`mod+\`). Acceptance checks met: `mod+P` files,
> `mod+shift+O` symbols, `mod+G` line, breadcrumbs navigate folders/symbols,
> split shows two independently-active files.
>
> **Deferred:** cross-file LSP features — go-to-definition across files, find
> references, rename symbol, code actions, hover, inlay hints. Monaco's bundled
> TS/JS worker provides the in-model versions; a real language-server
> integration is out of scope for this phase. See
> [`doc/dev/editor-workbench.md`](doc/dev/editor-workbench.md).
>
> Tests: `outline.test.ts` (8), `editor-actions.test.ts` (7), store Phase 9
> cases; full suite 230 vitest green, tsc + eslint clean.

Current state:

- Monaco editor is present.
- Minimap is disabled.
- Inline edit exists for selected text.
- No breadcrumbs, sticky scroll, outline, go-to-definition, references, rename symbol, format, code actions, or editor groups.

Implement:

- Editor split groups.
- Open to side.
- Move tab to group.
- Close all / close others / close saved.
- Save all.
- Revert file.
- Breadcrumbs.
- Minimap toggle.
- Sticky scroll toggle.
- Outline view.
- Go to symbol in file.
- Go to definition.
- Find references.
- Rename symbol.
- Format document.
- Code actions.
- Diagnostics squiggles.
- Hover provider.
- Inlay hints where language support exists.

Acceptance checks:

- `Ctrl/Cmd+P` opens files.
- `Ctrl/Cmd+Shift+O` opens symbols.
- `Ctrl/Cmd+G` jumps to line.
- Breadcrumbs navigate folders/files/symbols.
- Split editor works with two independently active files.

## Phase 10 - Settings, Profiles, And Keybindings

> **STATUS: DONE (core) — 2026-06-16.** Added a typed settings system with
> **user** and **workspace** scopes (merge order `default < user < workspace`,
> `effectiveSource` badges), a settings search box, and `applyEffectiveSettings`
> wiring the merged values into runtime state (editor toggles + autonomy live,
> default mode seeded at startup). Built a full keybindings editor: per-command
> overrides persisted and consulted by `matchKeybinding`, chord recording,
> conflict detection (banner + row highlight + assign-time warning), a raw
> `keybindings.json` editor, and per-command/all reset. Shipped the four
> required profiles (default, local-first, cloud-agent, strict-approval) with
> one-click apply and portable JSON import/export (settings + keybindings).
> Acceptance checks met: user setting applies across workspaces; workspace
> overrides user; keybinding changes persist across restart; conflicts are
> visible. See [`doc/dev/settings-and-keybindings.md`](doc/dev/settings-and-keybindings.md).
>
> **Deferred:** real on-disk `settings.json` files (currently localStorage, but
> the JSON shapes are file-ready) and remote settings sync (export/import is the
> local backup).
>
> Tests: `settings.test.ts` (6), `keybinding-overrides.test.ts` (9),
> `profiles.test.ts` (6), store `applyEffectiveSettings`; full suite 252 vitest
> green, tsc + eslint clean.

Current state:

- Settings exist for models, providers, indexer, permissions, appearance.
- No full settings search.
- No keybinding editor.
- No profile system.
- No workspace/user settings separation.

Implement:

- User settings file.
- Workspace settings file.
- Settings search.
- Keybindings editor.
- Keybinding conflict detector.
- Keybindings JSON editor.
- Profiles: default, local-first, cloud-agent, strict-approval.
- Import/export profile.
- Settings sync placeholder or local backup.

Acceptance checks:

- User setting applies across workspaces.
- Workspace setting overrides user setting.
- Keybinding changes survive restart.
- Conflicts are visible.

## Phase 11 - Cursor-Style Agent Expansion

> **STATUS: PARTIAL (testable core done) — 2026-06-16.** Landed the local-first,
> verifiable core of three pillars:
> - **Queue controls** — the single held message became a real `messageQueue`
>   with `queueUserMessage`/`dequeueMessage`/`reorderQueue`/`clearQueue`/
>   `stopAndSend`; messages release one-by-one as runs complete. UI:
>   `MessageQueue.tsx` (drag + up/down reorder, remove) + a "Stop & send" button.
>   ✅ acceptance: "Queue can hold multiple messages and reorder them."
> - **Rules visibility** — `lib/rules-sources.ts` classifies `.zoc/rules`,
>   `.cursor/rules`, `AGENTS.md`, and nested rules; `RulesDialog.tsx` (opened from
>   the composer Rules badge) shows sources + merged rule text before a run.
>   ✅ acceptance: "Rules are visible before a run starts."
> - **MCP host config** — `lib/mcp-config.ts` parses `.zoc/mcp.json` + user config
>   (stdio/sse/http transports), merges with workspace precedence, and backs
>   `autoApprove`; Settings → MCP Servers lists them.
>
> **Deferred (runtime/external — not verifiable here, not stubbed):** the live
> MCP client (transports, handshake, tool discovery, OAuth); browser tool +
> screenshots; web search tool; image attachment/vision + image generation;
> skills system; subagents; tool/apply hooks. The MCP approval-card path reuses
> the existing tool-approval flow once a client is connected. See
> [`doc/dev/agent-expansion.md`](doc/dev/agent-expansion.md).
>
> Tests: `mcp-config.test.ts` (9), `rules-sources.test.ts` (8), store queue
> cases; full suite 270 vitest green, tsc + eslint clean. Remaining acceptance
> checks (MCP tools after approval, browser screenshot) depend on the deferred
> runtime.

Current state:

- Agent has Ask/Agent modes, tool approvals, checkpoints, diff review, memory, context mentions, local/cloud model selection.
- Missing Cursor-level browser, web search, MCP, rules UI, skills, subagents, hooks, and stronger queue controls.

Implement:

- Plan mode UI.
- Debug mode UI.
- Browser tool integration.
- Web search tool with permission control.
- Image attachment and vision context.
- Image generation tool, saved to workspace assets.
- MCP host:
  - `.zoc/mcp.json`
  - user-level MCP config
  - stdio transport
  - SSE transport
  - streamable HTTP transport
  - OAuth/static token support later
- MCP tools in chat with approval cards.
- Rules UI:
  - `.zoc/rules`
  - `.cursor/rules` compatibility
  - `AGENTS.md` support
  - nested rules
  - rule create/edit/import
- Skills system:
  - local skill folders
  - skill picker
  - skill invocation from slash commands
- Subagents:
  - spawn background read-only research agent
  - spawn reviewer agent
  - merge results into main session
- Hooks:
  - before tool call
  - after tool call
  - before apply
  - after apply
- Queue controls:
  - queue message
  - steer current run
  - stop and send
  - drag reorder queued messages

Acceptance checks:

- Rules are visible before a run starts.
- Agent can use MCP tools after user approval.
- Browser tool can open local dev server and capture screenshot.
- Queue can hold multiple messages and reorder them.

## Phase 12 - Extension And Plugin Architecture

> **STATUS: DONE (core) — 2026-06-16.** Built an internal plugin system (not full
> VS Code compat): `lib/plugin-manifest.ts` parses/validates a manifest
> (id/name/version/activationEvents + `contributes` commands/views/tasks/
> snippets/themes/languages — fatal identity errors vs collected per-contribution
> errors); `lib/plugins.ts` is the host — install/uninstall, enable/disable,
> persistence, a plugin host log, error isolation, and live contributions wired
> into the command palette via `setContributedCommands`. Settings → Extensions
> installs from a manifest, toggles plugins, and shows the host log; the
> `workbench.view.extensions` command is now enabled and deep-links there.
> All three acceptance checks pass: a plugin contributes a command + a view;
> a bad/errored plugin is isolated and logged without affecting others; disabling
> removes the contributed commands/views. See
> [`doc/dev/extensions.md`](doc/dev/extensions.md).
>
> **Deferred (runtime):** sandboxed plugin *code* execution, install from a local
> folder / `.zip` on disk (manifest paste stands in), rendering contributed views
> as live activity-bar/panel surfaces, activating contributed tasks/snippets/
> themes/languages, and Open VSX compatibility.
>
> Tests: `plugin-manifest.test.ts` (7), `plugins.test.ts` (7); full suite 284
> vitest green, tsc + eslint clean.

Current state:

- No extension marketplace/runtime.
- No contributed commands, views, tasks, debuggers, languages, themes, or snippets.

Implement carefully:

- Start with internal plugin manifest, not full VS Code compatibility.
- Manifest fields:
  - id
  - name
  - version
  - contributes.commands
  - contributes.views
  - contributes.tasks
  - contributes.snippets
  - contributes.themes
  - contributes.languages
  - activationEvents
- Plugin sandbox.
- Plugin host logs.
- Enable/disable plugin.
- Install from local folder.
- Install from zip.
- Later evaluate Open VSX compatibility.

Acceptance checks:

- Plugin can contribute one command and one view.
- Plugin failure is isolated and visible in logs.
- Disabling plugin removes contributed commands/views.

## Phase 13 - Safety, Permissions, And Trust

> **STATUS: DONE (core) — 2026-06-16.** Added a unified, workspace-aware
> permission model on top of the existing per-tool grants. `lib/permissions-engine.ts`
> is a pure `evaluatePermission` returning allow/deny/prompt across all action
> kinds (agent tools, terminal, tasks, git, mcp, plugins, fs) with: a Workspace
> Trust gate (restricted blocks execution kinds until trusted), filesystem
> protections (deletion / dotfile / external), destructive-action gating
> (confirm or allowlist — even in "Run everything"), network allowlist, and the
> four run modes (ask / allowlist / sandboxed / all). `lib/trust.ts` persists the
> config (command/MCP/network allowlists + protections) and records every
> decision via `checkAction` into an audit log. Wired into `runTask` and plugin
> command execution; Settings → Trust & Safety drives it all; palette command
> "Workspace: Manage Trust & Safety". All three acceptance checks pass.
> See [`doc/dev/trust-and-permissions.md`](doc/dev/trust-and-permissions.md).
>
> **Deferred (runtime):** hooking the same `checkAction` gate into the terminal
> PTY send path, live Git ops, MCP invocation, and agent fs writes (mechanical
> call-site wiring); a true OS-level sandbox for "sandboxed" mode; rendering
> `prompt` decisions as a confirmation dialog at every call site (the agent
> tool-approval flow already covers tools).
>
> Tests: `permissions-engine.test.ts` (17), `trust.test.ts` (5), store
> restricted-task case; full suite 307 vitest green, tsc + eslint clean.

Current state:

- Agent tools have permission scopes and approval flow.
- Ask mode uses read-only tools.
- Agent mode can run isolated review-before-apply.
- Terminal and normal IDE commands do not share a full trust model.

Implement:

- Workspace Trust mode.
- Unified permission model for:
  - agent tools
  - terminal commands
  - tasks
  - Git operations
  - MCP tools
  - plugin actions
  - filesystem operations
- Run modes:
  - Ask every time
  - Allowlist
  - Sandboxed when possible
  - Run everything
- Command allowlist.
- MCP allowlist.
- Network allowlist.
- File deletion protection.
- Dotfile protection.
- External file protection.
- Clear audit log of tool and command actions.

Acceptance checks:

- Restricted workspace blocks terminal/task/plugin execution until trusted.
- Destructive actions require explicit confirmation or allowlist.
- Permission decisions are recorded.

## Phase 14 - Status Bar And Product Polish

> **STATUS: DONE — 2026-06-16.** Added a real bottom `StatusBar` wired to live
> store state, most indicators clickable for navigation: Git branch + dirty
> count (→ SCM), agent state (→ Agent panel), diagnostics error/warning counts
> (→ Problems), indexer chunk/live state (→ Indexer), background task count
> (→ Tasks), unsaved count, line/column (live Monaco caret via a new cursor
> pub/sub in `editor-actions`), file encoding (UTF-8), language mode, terminal
> count (→ terminal), active model (loaded local model preferred), and a
> sidecar Connected/Offline indicator. Pure formatters live in `lib/status-bar.ts`;
> indexer status added to the store (`indexStatus`/`loadIndexStatus`). All four
> acceptance checks pass (status bar updates on active-file change; real Git
> branch; diagnostics opens Problems; agent state opens Agent panel). See
> [`doc/dev/status-bar.md`](doc/dev/status-bar.md).
>
> **Deferred (runtime):** detecting/changing on-disk file encodings (shown as
> UTF-8) and a one-click "restart sidecar" action (represented by the
> Connected/Offline dot).
>
> Tests: `status-bar.test.ts` (8), `status-bar.test.tsx` (4); full suite 319
> vitest green, tsc + eslint clean.

Implement:

- Real Status Bar.
- Git branch.
- Dirty count.
- Active model.
- Agent state.
- Indexer state.
- Diagnostics counts.
- Current line/column.
- File encoding.
- Language mode.
- Terminal count.
- Background task status.
- Update/restart sidecar indicator.

Acceptance checks:

- Status Bar updates when active file changes.
- Git branch is real.
- Diagnostics count opens Problems.
- Agent state opens Agent Panel.

## Missing UI Checklist

> **STATUS: addressed — 2026-06-16.** All concrete items are implemented across
> Phases 1–14 plus the Outline & Timeline side views and the Extensions/Testing
> Activity Bar entries added here (see
> [`doc/dev/side-views.md`](doc/dev/side-views.md)). Activity Bar now has
> Explorer, Search, Source Control, Run and Debug, Testing, Extensions, Outline,
> Timeline, Indexer, Sessions. Side Panel has SCM, Run and Debug, Outline, and
> Timeline views (Extensions → Settings, Testing → Tasks dock). Bottom Dock has
> real Problems/Logs/Output + Tasks (Test Results/Task Log). Top Bar has the real
> branch, command center, and status indicators; the Status Bar (Phase 14) is
> live. **Runtime-deferred (not stubbed):** Debug Console (needs the DAP runtime,
> Phase 7), Ports, and Remote.

Activity Bar:

- Source Control.
- Run and Debug.
- Extensions.
- Testing.
- Remote/Ports later.

Side Panel:

- Source Control view.
- Run and Debug view.
- Extensions view.
- Testing view.
- Outline view.
- Timeline view.

Bottom Dock:

- Output.
- Debug Console.
- Test Results.
- Ports.
- Task Log.
- Real Problems.
- Real Logs.

Top Bar:

- Real branch.
- Command Center modes.
- Run/debug selector.
- Active task/debug config.
- Status indicators.

Editor:

- Split groups.
- Breadcrumbs.
- Minimap.
- Sticky scroll.
- Outline.
- Diagnostics.
- Code navigation.
- Code actions.

Agent:

- Plan mode.
- Debug mode.
- Browser tool.
- Web search tool.
- MCP tools.
- Rules manager.
- Skills.
- Subagents.
- Multi-message queue.
- Steer/stop-and-send.

## Backend/API Checklist

Tauri:

- File create/rename/delete/move/reveal/stat.
- Git command wrapper.
- Native open external path.
- Workspace trust storage.
- Plugin host launcher later.

FastAPI:

- Workspace search endpoint.
- Replace preview/apply endpoint.
- Diagnostics stream.
- Output channels.
- Task list/run/cancel endpoints.
- Git endpoints.
- Debug session endpoints.
- MCP server registry.
- Browser tool endpoints.
- Rules CRUD.
- Plugin metadata endpoints.

Rust hotpath:

- Fast text search.
- Replace preview support.
- File watcher improvements.
- Problem matcher helpers if useful.
- Git status parser if Python path is too slow.

## Test Strategy

Frontend:

- Command registry unit tests.
- Keybinding conflict tests.
- Explorer operation tests.
- Search panel tests.
- SCM state tests.
- Task runner UI tests.
- Terminal multi-session tests.
- Diagnostics store tests.

Backend:

- Git API tests with temp repos.
- Search/replace tests.
- Task discovery tests.
- Problem matcher tests.
- MCP config parser tests.
- Rules resolution tests.
- Permission/trust tests.

Desktop/Rust:

- Workspace path escape tests.
- Symlink protection tests.
- File operation tests.
- Watcher refresh tests.

Manual product checks:

- Open real repo.
- Create/rename/delete files.
- Search and replace text.
- Stage and commit change.
- Run build task.
- See diagnostics.
- Start terminal and run command.
- Ask agent to edit code.
- Review/apply/discard agent changes.
- Restore checkpoint.

## Priority Order

1. Command registry and live command palette.
2. Explorer file operations.
3. Real search and replace.
4. Source Control view.
5. Diagnostics, Problems, Logs, Output.
6. Tasks and Test Explorer.
7. Terminal tabs/profiles/splits.
8. Editor navigation and split groups.
9. Run and Debug.
10. Cursor-style MCP/rules/browser/web/skills/subagents.
11. Extension/plugin architecture.
12. Workspace trust and unified permissions.
13. Status Bar polish.

## Definition Of Done For Full IDE Parity V1

Zoc AI reaches practical full-IDE V1 when a developer can:

- Open a real project.
- Browse and manage files without leaving Zoc.
- Search and replace across the workspace.
- Edit multiple files with split editor groups.
- Run terminal sessions with tabs and profiles.
- See real diagnostics.
- Run build/test tasks.
- Stage, commit, branch, diff, and resolve Git conflicts.
- Start a debugger for at least Node/TypeScript and Python.
- Use command palette for every major action.
- Customize keybindings.
- Ask the agent to inspect, edit, run, review, and safely apply changes.
- Roll back agent changes with checkpoints.
- Extend the agent through rules and MCP tools.

## UI/UX Development Plan

> **STATUS: addressed — 2026-06-16.** The UI/UX gaps flagged below are resolved
> across Phases 1–14 plus the follow-ups: Outline & Timeline side views and
> Extensions/Testing Activity Bar entries ([`doc/dev/side-views.md`](doc/dev/side-views.md)),
> a real **Top Bar run/debug/task selector** (`RunSelector` + pure
> `lib/run-targets.ts` — lists launch configs + tasks, runs the selected target,
> shows a Configure action when none exist, and never silently means "generate
> tests"), and **Activity Bar badges** (Source Control changed-file count,
> Testing failing-task count). Empty/loading/error states, accessibility (ARIA
> labels, focus rings, reduced-motion), and the status-color system are honored
> by the implemented panels. Runtime-deferred items remain: Debug Console/DAP
> stepping (Phase 7), Ports/Remote, live browser/web-search/vision/skills/
> subagents (Phase 11), and on-disk encoding detection.

This section focuses on the visible product experience for Zoc AI. The sections above define the engineering roadmap; this section defines how the missing IDE features should feel, look, and behave.

Goal: make Zoc AI feel like a complete developer IDE, not only an AI chat panel beside an editor.

## Product Experience Principles

- The first screen is the real workbench: Explorer, editor, agent, terminal/status, and command access.
- The AI should feel integrated into the IDE, not separate from the IDE.
- Every visible control must do real work or clearly show why it is disabled.
- Important states must be obvious: unsaved file, dirty Git state, agent running, review pending, diagnostics failing, indexer stale, terminal busy.
- Layout must support long real projects, not only demo screenshots.
- UI density should match developer tools: compact, scannable, stable, and keyboard-friendly.
- Avoid marketing-style panels inside the product shell.
- Prefer familiar IDE icons and gestures over explanatory text.

## Current UI/UX Gaps

The current interface already has a good shell shape: top bar, activity bar, side panel, editor, bottom dock, and agent panel.

Missing or weak UI/UX areas:

- Activity Bar lacks Source Control, Run/Debug, Extensions, Testing, and Output/Ports access.
- Top Bar has a hardcoded branch and a vague Run button.
- Command Palette looks powerful but is thin and partly mock-backed.
- Explorer has no action toolbar or context menu.
- Search has no replace controls or search option toggles.
- Problems and Logs look like real panels but are static sample data.
- Terminal has no tabs, profiles, splits, or kill/restart UI.
- Editor has no breadcrumbs, split groups, outline, minimap toggle, sticky scroll, or diagnostics.
- Agent panel is the most developed part, but agent actions are not yet spread across Explorer, SCM, Tasks, Debug, and Terminal.
- Settings have feature sections but no full settings search/keybinding/profile experience.

## Workbench Layout Target

Primary shell:

- Activity Bar on the far left.
- Primary Side Bar for Explorer/Search/SCM/Debug/Extensions/Testing.
- Editor center with tabs and split groups.
- Secondary Side Bar for Agent by default.
- Bottom Panel for Terminal, Problems, Output, Debug Console, Test Results, Logs, Checkpoints.
- Status Bar at bottom.

Responsive behavior:

- Desktop wide: show side panel, editor, agent panel, bottom dock.
- Medium: collapse agent panel by default, keep side panel and editor.
- Narrow: activity bar plus one active main surface at a time.
- Panels must preserve state when hidden.

## Activity Bar UI

Add items in this order:

- Explorer.
- Search.
- Source Control.
- Run and Debug.
- Extensions.
- Testing.
- Indexer.
- Sessions.
- Settings.

Badges:

- Explorer: dirty/open file count when useful.
- Search: active search count after query.
- Source Control: changed file count.
- Run/Debug: active debug session indicator.
- Extensions: update count later.
- Testing: failing test count.
- Indexer: stale/error badge.
- Sessions: active/background agent count.

Interaction rules:

- Clicking active item toggles the side panel.
- Keyboard shortcuts should open the view and side panel.
- Tooltip shows name and shortcut.
- Badge must be visible but not noisy.

## Top Bar UX

Replace hardcoded state with real state:

- Workspace name/path.
- Real Git branch.
- Dirty count.
- Command Center.
- Run/Debug configuration selector.
- Start/Stop run button.
- Agent running indicator.
- Layout toggles.

Run button behavior:

- If a debug config exists, start selected config.
- If tasks exist, offer task/debug dropdown.
- If no config exists, show setup actions.
- Never silently mean "generate tests" unless the button says that.

## Status Bar UX

Add a real Status Bar with compact clickable segments:

- Git branch.
- Sync/dirty state.
- Diagnostics error/warning count.
- Active model.
- Agent status.
- Indexer status.
- Active task/debug state.
- Terminal count.
- Line/column.
- Language mode.
- Encoding.
- Workspace trust.

Click behavior:

- Git opens Source Control.
- Diagnostics opens Problems.
- Model opens model picker/settings.
- Agent opens Agent panel.
- Indexer opens Indexer.
- Task/debug opens related panel.

## Explorer UX

Toolbar:

- New file.
- New folder.
- Refresh.
- Collapse all.
- More menu.

Context menu:

- Open.
- Open to Side.
- Reveal in Native Explorer.
- Copy Path.
- Copy Relative Path.
- Rename.
- Delete.
- Duplicate.
- Compare Selected.
- Open in Integrated Terminal.
- Add to Agent Context.

Inline interactions:

- Rename should happen in-place.
- Create file/folder should use inline input.
- Drag/drop should move files with confirmation for risky operations.
- Multi-select should use familiar Ctrl/Cmd and Shift behavior.
- Dirty, added, modified, deleted states should use Git-aware badges.

Empty states:

- No workspace: choose/open workspace.
- Empty folder: new file/new folder/import/open terminal.
- Permission error: show exact denied path and action.

## Search UX

Search panel modes:

- Text Search.
- Replace.
- Semantic Search.

Controls:

- Search input.
- Replace input.
- Regex toggle.
- Case toggle.
- Whole word toggle.
- Include files.
- Exclude files.
- Use ignore files toggle.

Results:

- Group by file.
- Show match count per file.
- Show line preview with highlighted match.
- Click result opens file at line/column.
- Replace one/file/all with preview.

Semantic search:

- Label it clearly as semantic.
- Show index status.
- Show fallback warning only when fallback is active.

## Source Control UX

Source Control view:

- Commit message box.
- Commit button.
- Refresh.
- More menu.
- Staged changes.
- Changes.
- Untracked.
- Conflicts.

File row actions:

- Open diff.
- Stage/unstage.
- Discard.
- Add to Agent Context.

Diff review:

- Side-by-side and inline toggle.
- Stage selected hunks.
- Discard selected hunks.
- Open file.

Branch UX:

- Branch picker from top/status bar.
- New branch.
- Checkout branch.
- Pull/push/sync.
- Conflict state should be impossible to miss.

## Run, Tasks, And Debug UX

Run selector:

- Shows selected debug config or task.
- Dropdown lists launch configs, tasks, and detected scripts.
- Setup action appears when none exist.

Task panel:

- Detected tasks.
- Configured tasks.
- Recent tasks.
- Running tasks.
- Failed tasks.

Debug panel:

- Variables.
- Watch.
- Call stack.
- Breakpoints.
- Loaded scripts/modules later.

Debug toolbar:

- Continue.
- Pause.
- Step over.
- Step into.
- Step out.
- Restart.
- Stop.

Editor:

- Breakpoints in gutter.
- Current execution line.
- Inline variable hints later.

## Terminal UX

Header:

- Terminal tabs.
- New terminal.
- Profile dropdown.
- Split.
- Kill.
- Restart.
- More menu.

Tab row:

- Shell/profile name.
- Running status.
- Exit status.
- Close button.

Terminal features:

- Find in terminal.
- Copy/paste.
- Clear.
- Open current command output in editor.
- Clickable file links.
- Command decorations and exit markers.

Agent terminal control:

- Remove fake hardcoded approval.
- If agent wants terminal execution, show real command, cwd, risk, and approval choices.
- Show command output attached to tool card and terminal where appropriate.

## Editor UX

Tabs:

- Dirty dot.
- Close.
- Close others.
- Close saved.
- Reopen closed editor.
- Move to split group.

Editor groups:

- Split right.
- Split down.
- Move editor left/right.
- Drag tabs between groups.

Navigation:

- Breadcrumbs.
- Outline.
- Go to symbol.
- Go to definition.
- Find references.
- Line/column jump.

Code intelligence:

- Diagnostics squiggles.
- Hover.
- Code actions.
- Rename symbol.
- Format document.
- Minimap toggle.
- Sticky scroll toggle.

Agent overlays:

- Proposed edits should be visible inline.
- Apply/reject controls must stay close to the changed code.
- Review all should open a complete diff review.
- Agent editing animation must never hide code or shift layout.

## Agent Panel UX

Modes:

- Ask.
- Agent.
- Plan.
- Debug.

Composer:

- Context chips.
- File/folder/symbol mentions.
- Image attachments.
- Tool/MCP availability.
- Model picker.
- Autonomy/run mode control.
- Queue/steer/stop-send dropdown while running.

Timeline:

- User request.
- Plan.
- Tool calls.
- Permission requests.
- File edits.
- Validation.
- Review.
- Final summary.

Review:

- Apply all.
- Discard all.
- Restore checkpoint.
- Include/exclude files.
- Validation badges.
- Open changed file.

Queue:

- Multiple queued messages.
- Drag reorder.
- Remove queued item.
- Send immediately.

## Settings UX

Settings home:

- Search settings.
- Categories in left nav.
- Modified settings filter.
- Workspace/User toggle.

Required categories:

- Models.
- Providers.
- Local llama.cpp.
- Agent.
- Run Mode and Permissions.
- MCP.
- Rules.
- Indexer.
- Editor.
- Terminal.
- Source Control.
- Tasks.
- Debug.
- Appearance.
- Keybindings.
- Profiles.
- Extensions/Plugins later.

Keybindings:

- Search commands.
- Record shortcut.
- Conflict display.
- Reset command.
- Open JSON.

Profiles:

- Local-first.
- Strict approvals.
- Fast cloud.
- Review-heavy.
- Minimal UI.

## Empty, Loading, Error States

Every major view needs:

- Empty state.
- Loading state.
- Error state.
- Offline/sidecar unavailable state.
- Permission denied state.
- Retry action.

Avoid fake sample data in production views.

Production panels must not display hardcoded demo problems, logs, Git branches, or terminal approvals.

## Accessibility

Required:

- Keyboard navigable panels.
- Visible focus rings.
- ARIA labels for icon buttons.
- Role/aria-selected for tabs.
- Sufficient color contrast.
- No color-only status indicators.
- Reduced motion support for agent/editor animations.
- Resizable panels with accessible handles where possible.

Keyboard expectations:

- Command palette.
- Quick open.
- Toggle terminal.
- Toggle side bar.
- Save/save all.
- Search.
- Source control.
- Run task.
- Start debug.
- Go to line.
- Go to symbol.

## Visual Design System Updates

Keep:

- Compact IDE density.
- Dark workbench base.
- 8px or smaller radius for cards/panels.
- Lucide icons for commands.
- Clear active indicators.

Improve:

- Reduce one-note purple dominance.
- Use status colors consistently:
  - green: success/applied
  - amber: warning/pending
  - red: error/destructive
  - blue: information/debug
  - purple: agent/intelligence only
- Establish typography scale for:
  - shell chrome
  - panel headers
  - tree rows
  - editor tabs
  - cards
  - settings forms
- Ensure buttons do not resize or shift layout while loading.
- Add skeletons for async panels.

## UI Acceptance Checklist

Before calling a feature done:

- It has a visible entry point.
- It is available from command palette.
- It has keyboard support when common.
- It has empty/loading/error states.
- It works with real workspace data.
- It does not depend on mock data in live mode.
- It has responsive behavior.
- It has accessible labels/focus.
- It has a clear disabled state.
- It has at least one test for the core interaction.

## First UI/UX Implementation Priority

1. Real command palette and command registry.
2. Activity Bar additions and panel placeholders with honest empty states.
3. Explorer toolbar and context menu.
4. Status Bar with real workspace/Git/diagnostic/agent/indexer state.
5. Search/replace panel.
6. Source Control panel.
7. Terminal tabs/profiles.
8. Problems/Output/Logs backed by real data.
9. Editor breadcrumbs/splits/outline.
10. Agent Plan/Debug mode and stronger queue UX.

## Agent Panel Ask Mode Repair Plan

> STATUS: ✅ Implemented (backend + frontend + tests). See
> [`doc/dev/ask-mode.md`](doc/dev/ask-mode.md). Ask mode is now read-only in
> both backend behavior and frontend presentation: no planner, no to-dos, no
> workflow cards; the header reads `Zoc Ask / Read-only answers` and the
> autonomy control is replaced by a `Read-only` pill. Agent mode keeps the full
> workflow timeline. Plan/Debug remain future modes (config carries
> `presentation_mode` so they can be added without re-plumbing).

This section is based on the latest screenshot review of the right Agent panel,
the local source code, and current Cursor/VS Code behavior references.

External behavior baseline:

- Cursor Agent mode is for building, refactoring, editing files, running terminal
  commands, and using tools.
  Source: https://cursor.com/help/ai-features/agent.md
- Cursor Ask mode is for understanding code and exploring architecture. It is
  read-only and should not edit files.
  Source: https://cursor.com/help/ai-features/agent.md
- Cursor Plan mode is for complex features where the user reviews the approach
  before implementation.
  Source: https://cursor.com/help/ai-features/agent.md
- VS Code chat keeps the user interaction conversational, supports explicit
  context, and separates low-level tool/debug evidence from the main answer.
  Source: https://code.visualstudio.com/docs/chat/chat-overview

### Screenshot Problems Observed

The marked panel currently shows Ask mode selected, but the UI behaves like an
Agent run:

- Ask messages like `hi` and `hello` create `Workspace analysis`, `Plan`, and
  `Agent run` cards.
- A simple greeting creates a to-do item such as `Respond to greeting`.
- The assistant says it updated a to-do list even though the user only asked in
  Ask mode.
- Tool activity such as `get_project_summary` is shown inline with raw JSON-like
  input and output.
- A Plan step can display raw generated JSON text instead of a clean title and
  description.
- The user answer is visually buried under workflow cards.
- The header still says `Auto run` while the composer says Ask mode is
  read-only.
- The `High` autonomy pill remains visible in Ask mode, which makes the UI feel
  unsafe even when no file changes should happen.

Expected behavior:

- Ask mode must look and behave like a clean code Q&A transcript.
- Agent mode may show workspace analysis, plan, to-do, tool activity, diffs,
  permissions, checkpoints, and validation cards.
- Plan mode may show plan cards, but execution must wait for user approval.
- Debug mode may show runtime evidence, logs, browser screenshots, and tool
  activity because debugging needs evidence.

### Root Cause Source Map

Backend source:

- `services/agent/src/zoc_studio_agent/v1/agent_run.py`
  - Lines 67-84 define Ask mode as read-only by restricting real tools to
    read/search/status tools.
  - Lines 242-246 pass only `allowed_tools=ASK_MODE_TOOLS` when
    `payload.mode == "ask"`.
  - Missing behavior: Ask mode does not pass `skip_planner=True`.
  - Missing behavior: Ask mode does not disable the virtual `todo_write` tool.
  - Result: Ask mode is read-only for filesystem writes, but still plans and
    updates to-dos.

- `services/agent/src/zoc_studio_agent/agent/orchestrator.py`
  - Lines 376-379 force the model to call `todo_write` before doing anything.
  - Lines 383-384 expose `allowed_tools` and `skip_planner` in
    `OrchestratorConfig`.
  - Lines 547-560 run the planner whenever `skip_planner` is false.
  - Lines 583-585 always append `TODO_WRITE_TOOL_SCHEMA` to the available tool
    schemas.
  - Lines 1003-1020 intercept `todo_write` and emit `TodoUpdateEvent`.
  - Result: Ask mode can still emit plan and to-do events even when the user
    selected read-only Ask.

Frontend source:

- `apps/frontend/src/lib/store.ts`
  - Line 806 defaults `agentMode` to `agent`.
  - Lines 1075-1100 say Ask is read-only in a comment, but still build the same
    `RunAgentRequest` and start the streaming run path.
  - Lines 1161-1164 always consume the stream with the same handler.
  - Lines 2218-2318 route `workspace_analysis`, `plan`, `todo_update`,
    `tool_call`, `diff`, and final summary events through one shared event
    handler.
  - Lines 2382-2414 always create `workspace_analysis` cards.
  - Lines 2487-2500 always create tool cards.
  - Lines 2525-2548 always create plan cards.
  - Lines 2550-2559 always create to-do cards.
  - Lines 2739-2772 set `mode: "ask"` correctly, but there is no Ask-specific
    presentation pipeline.

- `apps/frontend/src/features/agent/AgentTimeline.tsx`
  - Lines 123-130 classify `workspace_analysis`, `todos`, `tool`, and `diff` as
    run body entries.
  - Lines 144-170 wrap those entries into an `AgentRunCard` when they include
    todos or diffs.
  - Lines 316-335 only compact some completed tool work in Ask mode. Other
    cards still render.
  - Lines 408-445 render `workspace_analysis`, `plan`, `todos`, `tool`, and
    `final_summary` for all modes.
  - Lines 999-1166 contain the visible `Workspace analysis`, `Plan`, `To-do`,
    and `Tool activity` card renderers seen in the screenshots.

- `apps/frontend/src/features/agent/Composer.tsx`
  - Lines 97 and 204-231 define Ask/Agent toggle state.
  - Lines 233-251 still show an autonomy control in Ask mode.
  - Lines 280-284 correctly describe Ask as read-only, but the rest of the
    application does not honor that presentation contract.

- `apps/frontend/src/features/agent/AgentPanel.tsx`
  - Lines 57-63 always brand the panel as `Zoc Agent` and `Auto run`, even when
    Ask mode is selected.
  - Lines 66-80 show idle/building state, but do not distinguish Ask answer
    streaming from Agent execution.

### Required Backend Fixes

1. Add an explicit Ask run profile.

In `services/agent/src/zoc_studio_agent/v1/agent_run.py`, compute an
`is_ask` flag and pass Ask-specific orchestration config:

```python
is_ask = payload.mode == "ask"

config=OrchestratorConfig(
    max_iterations=payload.max_iterations,
    max_repair_attempts=payload.max_repair_attempts,
    allowed_tools=ASK_MODE_TOOLS if is_ask else None,
    skip_planner=is_ask,
    enable_todos=not is_ask,
    presentation_mode="ask" if is_ask else "agent",
)
```

2. Extend `OrchestratorConfig`.

In `services/agent/src/zoc_studio_agent/agent/orchestrator.py`:

```python
enable_todos: bool = True
presentation_mode: Literal["ask", "agent", "plan", "debug"] = "agent"
```

If `Literal` creates import churn, use `str` first and validate at the endpoint.

3. Do not expose `todo_write` in Ask mode.

Change:

```python
tool_schemas.append(TODO_WRITE_TOOL_SCHEMA)
```

To:

```python
if cfg.enable_todos:
    tool_schemas.append(TODO_WRITE_TOOL_SCHEMA)
```

4. Make the system prompt mode-aware.

Current prompt always tells the model to call `todo_write`. Split the prompt:

- Ask system prompt:
  - Answer the user directly.
  - Use read/search tools only when needed.
  - Do not create plans.
  - Do not create to-do lists.
  - Do not claim files were changed.
  - If the request needs file edits, ask the user to switch to Agent mode.

- Agent system prompt:
  - Keep current planning, to-do, editing, validation, repair, and review flow.

5. Optional but cleaner: add a dedicated `/ask` backend path.

`POST /v1/sessions/{id}/ask` can return only:

- user message event
- assistant message delta/final
- compact context-used metadata
- error event

This avoids forcing Q&A through the same run event vocabulary as file-changing
Agent work.

### Required Frontend Fixes

1. Store the active run mode at send time.

In `apps/frontend/src/lib/store.ts`, capture the mode before streaming:

```ts
const runMode = get().agentMode;
```

Then pass it into `consumeStream(stream, set, { mode: runMode })`.

Do not rely only on current store state during rendering because the user can
switch modes while a response is streaming.

2. Add `mode` to workflow items.

Extend `AgentWorkflowItem` with:

```ts
mode?: "ask" | "agent" | "plan" | "debug";
runId?: string;
```

Every item created inside `consumeStream` should receive the captured mode.

3. Suppress workflow cards in Ask mode.

For `mode === "ask"`:

- Do not add `workspace_analysis` cards.
- Do not add `plan` cards.
- Do not add `todos` cards.
- Do not add `final_summary` cards when an assistant answer already exists.
- Do not add diff/review/checkpoint cards. If they appear, treat them as a
  contract violation and show an error badge.
- Convert read/search tool calls into a compact hidden metadata list, not a
  visible `Tool activity` card.

4. Create an Ask transcript renderer.

In `AgentTimeline.tsx`, branch before `groupRuns(buildFeed(items))`:

```tsx
const mode = useApp((s) => s.agentMode);
const renderedItems = mode === "ask"
  ? buildAskTranscript(items)
  : groupRuns(buildFeed(items));
```

Ask transcript should render only:

- user message bubble
- assistant message bubble
- optional compact `Context used` pill row
- optional collapsed `Details` drawer for read/search tools
- errors

No `AgentRunCard`, no `WorkspaceAnalysisBlock`, no `PlanBlock`, no
`TodoListBlock`, and no `ToolBlock` should appear in default Ask view.

5. Fix panel header copy.

In `AgentPanel.tsx`:

- Ask selected:
  - title: `Zoc Ask`
  - subtitle idle: `Read-only answers`
  - subtitle streaming: `Answering...`
  - no `Auto run`
- Agent selected:
  - title: `Zoc Agent`
  - subtitle idle: `Auto run`
  - subtitle running: `Building...`

6. Hide or lock autonomy in Ask mode.

In `Composer.tsx`:

- Hide the autonomy control when `agentMode === "ask"`, or replace it with a
  read-only `Read-only` pill.
- Keep autonomy visible only for Agent, Plan, and Debug execution modes.

7. Clean JSON-like plan text.

Even after Ask suppresses plan cards, Agent and Plan mode must sanitize plan
data:

- If `plan.goal` or a step title looks like raw JSON, attempt structured parse.
- If parse succeeds, use parsed `goal`, `steps[].title`, and `steps[].detail`.
- If parse fails, show `Generated plan` and move raw content into a collapsed
  debug drawer.
- Never render raw JSON as the primary visible step title.

8. Reset visual state correctly between turns.

For a new Ask message:

- Keep prior chat transcript messages.
- Do not carry previous Agent run cards into the active viewport as if they
  belong to the new Ask answer.
- Auto-scroll to the newest user/assistant pair.
- If old workflow cards remain in history, visually separate them by mode or
  session.

### Cursor-Style Ask UX Specification

Ask panel layout:

- Header: compact title, mode badge, model picker, menu.
- Transcript: clean user and assistant bubbles.
- Context chips: tiny, optional, collapsible.
- Composer: Ask/Agent segmented control, attach active file, send/stop.
- Footer: `Ask is read-only. Switch to Agent to edit files.`

Ask message behavior:

- `hi` -> one assistant greeting, no tools, no plan, no to-do.
- `hello` -> one assistant greeting, no tools, no plan, no to-do.
- `explain App.tsx` -> assistant explanation; optional collapsed context chip
  for `App.tsx`; no workspace card.
- `what changed in git?` -> assistant answer; optional collapsed `git status`
  context; no `Tool activity` card unless user expands details.
- `fix this bug` while Ask is selected -> assistant says it can explain the fix
  or switch to Agent to edit; it must not create a plan or to-do.

Agent message behavior:

- `Build a portfolio site` -> workspace/context card allowed.
- Plan card allowed.
- To-do card allowed.
- Tool activity allowed.
- Diff/review/checkpoint cards allowed.
- Apply/discard flow required before touching real project when review mode is
  enabled.

### Test Plan

Backend tests:

- Ask mode sends `skip_planner=True`.
- Ask mode does not include `TODO_WRITE_TOOL_SCHEMA`.
- Ask mode never emits `PlanCreatedEvent` or `TodoUpdateEvent`.
- Ask mode rejects write/shell tools.
- Ask mode final answer does not claim file changes for read-only prompts.

Frontend store tests:

- `sendUserMessage` in Ask passes mode `ask`.
- Ask stream with context events does not create `workspace_analysis` items.
- Ask stream with plan/todo events ignores them or records a contract error.
- Ask read/search tool events become collapsed context metadata.
- Agent stream still creates workflow cards.

Frontend rendering tests:

- Ask `hi` shows only user bubble and assistant bubble.
- Ask `explain App.tsx` shows no `Agent run`, `Plan`, `To-do`, or
  `Workspace analysis` card.
- Agent mode still renders `AgentRunCard` when to-dos/diffs exist.
- Header changes from `Zoc Agent / Auto run` to `Zoc Ask / Read-only answers`
  in Ask mode.
- Autonomy control is hidden or disabled in Ask mode.
- Raw JSON plan output never appears as visible step text.

Manual screenshot acceptance:

- Reproduce the four red-marked screenshots.
- Run the same messages in Ask mode:
  - `hi`
  - `hello`
  - `i have need a idea off web development need`
  - a workspace question that needs read/search context
- The red-marked cards must be gone in Ask mode.
- Repeat with Agent mode selected and confirm workflow cards still appear.

### Implementation Order

1. Backend safety first:
   - Add `enable_todos` to `OrchestratorConfig`.
   - Disable planner and to-dos for Ask.
   - Split Ask vs Agent system prompt instructions.
   - Add backend tests for no plan/no todo in Ask.

2. Frontend event pipeline:
   - Capture run mode at send time.
   - Pass run mode into `consumeStream`.
   - Stamp or filter workflow items by mode.
   - Suppress Ask workflow cards.

3. Frontend visual repair:
   - Add Ask transcript renderer.
   - Update header copy.
   - Hide or lock autonomy for Ask.
   - Convert read/search tools into collapsed context metadata.

4. Data cleanup:
   - Sanitize plan JSON.
   - Separate previous Agent workflow history from active Ask transcript.

5. Verification:
   - Unit tests.
   - Component tests.
   - Screenshot checks for Ask and Agent mode.

### Definition of Done

The bug is fixed only when:

- Ask mode is truly read-only in backend behavior and frontend presentation.
- Ask mode never displays Agent-run workflow cards by default.
- Ask mode never creates to-dos or plans.
- Ask mode never says it changed files or updated to-dos.
- Agent mode still keeps the full workflow timeline.
- Plan and Debug modes remain separate from Ask mode.
- The four screenshot cases are visually clean and Cursor-style.
