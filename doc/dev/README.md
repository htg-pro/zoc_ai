# Developer Guide — Zoc Studio / Zoc AI

Onboarding notes for the next developer. This complements the top-level
[`README.md`](../../README.md) (which covers build/release) by documenting how
the agent actually works internally and where to make changes safely.

## Guides in this folder

| Guide | What it covers |
|-------|----------------|
| [`agent-run-flow.md`](./agent-run-flow.md) | The end-to-end agent run: request → orchestrator → SSE events → review/apply/discard. Isolation model and its invariants. |
| [`frontend-agent-panel.md`](./frontend-agent-panel.md) | Frontend agent feature: Zustand store shape, the pure `lib/*` modules, components, and the run lifecycle. |
| [`testing.md`](./testing.md) | How to run and write tests (backend pytest, frontend vitest + fast-check), plus the shell-output gotcha. |
| [`security.md`](./security.md) | Secret scanning tooling, known leaks to rotate, and how to purge a secret from git history. |
| [`agent-collapse-plan.md`](./agent-collapse-plan.md) | Migration plan for collapsing the legacy planning layer into the unified agent run. |
| [`dead-code-cleanup.md`](./dead-code-cleanup.md) | What dead files were removed and why, plus candidates left for confirmation. |
| [`build-and-packaging.md`](./build-and-packaging.md) | How the desktop app is built/bundled and the fix for stale-code rebuilds. |
| [`rebrand-status.md`](./rebrand-status.md) | Zoc AI rebrand — what's renamed, and the plan for the build-critical identifier rename. |
| [`checkpoints.md`](./checkpoints.md) | Checkpoints & Restore — one-click undo of an applied agent run. |
| [`inline-edit.md`](./inline-edit.md) | Inline edit (Cmd-K) — rewrite a selection with a reviewable diff. |
| [`project-rules.md`](./project-rules.md) | Project rules (.zoc/rules) — per-project conventions injected into the agent prompt. |
| [`context-mentions.md`](./context-mentions.md) | @-context picker — files/folders/symbols, plus the TS generator fix. |
| [`editor-save-and-secrets.md`](./editor-save-and-secrets.md) | Editor file save (Cmd-S) + the secure-store localStorage-shadow fix that unblocks provider keys / agent connect. |
| [`ask-mode.md`](./ask-mode.md) | Ask vs Agent mode — Ask is read-only Q&A (no plan/to-do/workflow cards); Agent keeps the full workflow timeline. |
| [`command-system.md`](./command-system.md) | Command registry + palette (Phase 1) — one source of truth for actions, keybindings, and the Go-to-File / command / symbol palette. |
| [`file-operations.md`](./file-operations.md) | Explorer file operations (Phase 2) — create/rename/delete/duplicate/move/reveal with workspace-scoped Tauri commands, context menu, and open-tab sync. |
| [`search-and-replace.md`](./search-and-replace.md) | Workspace text search & replace (Phase 3) — regex/case/word, globs, grouped results, preview→apply with undo; semantic search preserved as a mode. |
| [`source-control.md`](./source-control.md) | Source control (Phase 4) — Git status/stage/commit/branch/pull/push/diff/blame, the SCM panel, and the real branch in the top bar. |
| [`diagnostics.md`](./diagnostics.md) | Diagnostics, Problems, Logs & Output (Phase 5) — problem-matcher parsers, the `run_check` runner, and real Problems/Logs/Output panels. |
| [`tasks.md`](./tasks.md) | Task runner & Test Explorer (Phase 6) — task discovery (tasks.json/npm/cargo/make/python), the `run_task` runner, and the Tasks panel. |
| [`run-and-debug.md`](./run-and-debug.md) | Run and Debug (Phase 7) — breakpoints + Monaco gutter, launch.json parsing, the Run & Debug view (live DAP adapter deferred to the Phase 8 runtime). |
| [`terminal.md`](./terminal.md) | Terminal (Phase 8) — multi-session tabs, shell profiles, split, kill/rename, find, exit status, and clickable links over the sidecar PTY. |
| [`editor-workbench.md`](./editor-workbench.md) | Editor workbench (Phase 9) — split editor groups, tab management (close others/saved/all), breadcrumbs + outline, minimap/sticky-scroll/breadcrumb toggles, diagnostics squiggles, and Monaco built-in actions (format / go-to-line / go-to-symbol). |
| [`settings-and-keybindings.md`](./settings-and-keybindings.md) | Settings, Profiles & Keybindings (Phase 10) — user/workspace scopes with merge + search, the keybindings editor (conflict detection + JSON), and four switchable profiles with import/export. |
| [`agent-expansion.md`](./agent-expansion.md) | Cursor-style agent expansion (Phase 11) — multi-message queue controls (reorder, stop-and-send), rules visibility (.zoc/.cursor/AGENTS.md, nested), and MCP host config (transports + merge). Runtime pieces (live MCP, browser, web search, vision, skills, subagents, hooks) deferred. |
| [`extensions.md`](./extensions.md) | Extension & plugin architecture (Phase 12) — internal plugin manifest, host lifecycle (install/enable/disable + error isolation + logs), and contributed commands/views wired into the palette. Sandboxed execution, folder/zip install, and Open VSX deferred. |
| [`trust-and-permissions.md`](./trust-and-permissions.md) | Safety, Permissions & Trust (Phase 13) — Workspace Trust, a unified allow/deny/prompt engine across tools/terminal/tasks/git/mcp/plugins/fs, run modes, allowlists, protections, and a permission audit log. |
| [`status-bar.md`](./status-bar.md) | Status Bar & product polish (Phase 14) — a real bottom status bar with Git branch, dirty/diagnostics counts, agent/indexer/task state, line/column, language mode, encoding, terminals, active model, and a sidecar indicator (most click to navigate). |
| [`side-views.md`](./side-views.md) | Outline & Timeline side views + Extensions/Testing Activity Bar items (Missing UI Checklist) — symbol outline of the active file and a merged commit/checkpoint timeline. |

## 30-second mental model

Zoc Studio is a **local-first agentic coding desktop app**: a Tauri v2 shell
spawns a bundled FastAPI sidecar (the "agent"), and a React webview talks to it
over loopback HTTP/SSE. The agent runs an LLM tool-use loop (read/write/run
files, etc.) and streams progress back as `AgentEvent`s.

```
React webview  ──HTTP/SSE──►  FastAPI agent  ──child CLI──►  hotpath (Rust)
(apps/frontend)               (services/agent)               (crates/hotpath)
        ▲                              │
        └────── shared-types ──────────┘   Pydantic ⇄ TS, single source of truth
                (packages/shared-types)
```

## Where things live

| Area | Path |
|------|------|
| FastAPI routes (v1) | `services/agent/src/zoc_studio_agent/v1/` |
| Agent orchestrator (LLM tool loop) | `services/agent/src/zoc_studio_agent/agent/orchestrator.py` |
| Isolated run (review-before-apply) | `services/agent/src/zoc_studio_agent/agent/zoc_run.py` |
| Workspace copy/diff primitives | `services/agent/src/zoc_studio_agent/agent/replit_workflow.py` |
| LLM providers (llama.cpp, OpenAI-compat, …) | `services/agent/src/zoc_studio_agent/providers/` |
| Shared schema (Pydantic) | `packages/shared-types/python/shared_schema/models.py` |
| Shared schema (TS mirror) | `packages/shared-types/typescript/src/index.ts` |
| Frontend store (Zustand) | `apps/frontend/src/lib/store.ts` |
| Frontend pure modules | `apps/frontend/src/lib/*.ts` (e.g. `run-machine`, `event-ingest`) |
| Frontend agent UI | `apps/frontend/src/features/agent/` |
| Diff review UI | `apps/frontend/src/features/diff/DiffReviewView.tsx` |
| Specs / plans | `.kiro/specs/studio-ui-redesign/` |

## Daily commands

```bash
make install      # one-time deps (Node + Python + Rust)
pnpm dev          # full stack (Tauri → Vite → agent → hotpath)
pnpm dev:frontend # frontend only, Vite on :1420
pnpm dev:agent    # agent only, auto-picked loopback port
make check        # lint + typecheck + tests across all languages
```

See [`testing.md`](./testing.md) for the exact per-language test invocations.

## Conventions that matter

- **Loopback only.** The agent must never bind to a public interface.
- **Schema is the source of truth.** Edit Pydantic models, then run
  `pnpm schema:generate` and commit *both* the Python and TS sides. Schema
  drift is a CI failure.
- **No silent fallbacks.** If something can't start, fail loudly with a clear
  message rather than degrading quietly.
- **Additive over destructive.** The agent redesign was rolled out additively
  on top of tested components (see the spec). Prefer mapping new behavior onto
  existing tested code over rip-and-replace.
- **Don't commit secrets.** `.gitignore` blocks `*.env`, `*.key`, `*.pem`,
  `secrets.json`, `credentials.json`, and `.claude/settings.local.json`. Put
  API keys in env vars or gitignored local config — never in tracked files.

## Known gotchas

- **Shell stdout can render empty in some tooling.** Redirect to a workspace
  file and read it back (e.g. `… > .out.txt 2>&1` then open `.out.txt`).
- **`services/agent/tests/smoke` needs a live model** and will hang in CI —
  always `--ignore` it in headless test runs.
- **Isolated runs live in the system temp dir**, not inside the workspace
  (`tempfile.gettempdir()/zoc-agent-runs/<hash>`), to avoid recursive copy.
  See `agent-run-flow.md`.
