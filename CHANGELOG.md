# Changelog

All notable changes to Zoc AI.

## [0.0.2] - 2026-07-25

Production-hardening patch release for the local-first agent runtime, advanced
editor, MCP/plugin ecosystem, terminal integration, and atomic workspace edit
flow.

### Implementation patches

- Added model-backed reasoning with bounded `<think>` extraction, strict
  structured planning, a 30-step ReAct tool loop, verification, remediation,
  pause/resume, and recovery-budget enforcement.
- Added persistent hybrid workspace context search using BM25/vector reciprocal
  rank fusion, token-budgeted context injection, conversation compression,
  file steering, and debounced incremental indexing.
- Completed Monaco LSP integration for TypeScript/JavaScript, Python, and Rust,
  including diagnostics, hover, definition, references, rename, status badges,
  Problems grouping, navigation, and agent-assisted fixes.
- Added cancellable inline completions and Cmd+K inline edits with stale-buffer
  protection, contextual prompts, reduced-motion support, undo grouping, edit
  animation, cursor reveal, and completion toasts.
- Completed MCP stdio hosting, framed JSON-RPC, configuration layering,
  namespaced tools, trust/permission gating, crash and timeout isolation,
  frozen-sidecar dispatch, built-in documentation/Git/web-search servers, and
  live settings controls.
- Added a constrained plugin worker sandbox and marketplace with bounded ZIP
  extraction, manifest validation, lifecycle timeouts, namespaced storage,
  command registration, update handling, and gateway-backed terminal tools.
- Added split terminal panes, profiles, pane focus shortcuts, bounded transcript
  capture, clickable output annotations, test/stack/progress parsing, and
  agent-terminal command correlation.
- Added workspace trust, destructive-intent detection, permission auditing,
  fail-closed approval handling, Rust atomic write/delete/patch transactions,
  rollback, path/symlink confinement, and pre-run Git checkpoints.
- Added approval-aware multi-file edit staging so Monaco animation occurs only
  after the gateway commits accepted review files.
- Added exact package-local ESLint tooling for generated shared TypeScript
  schemas and restored complete all-workspace lint coverage.

### Bug-fix patches

- Restored disconnected browser-preview saves while retaining real Tauri and
  connected-browser filesystem writes.
- Prevented stale inline completions, recursive Monaco refreshes, dirty-buffer
  overwrite, stale Cmd+K application, and multi-step edit continuation after
  user divergence.
- Fixed duplicate approval decisions by making settled rows immutable and
  ignoring rapid follow-up actions.
- Corrected completion-row wording, Composer/AgentPanel accessibility labels,
  current production snapshots, toolbar selectors, and icon mocks.
- Hardened benchmark persistence by validating untrusted JSON, preserving
  camelCase API aliases, using typed internal fields, and rejecting malformed
  quality scores.
- Narrowed model-stream frames after sentinel handling and documented the
  guarded optional `psutil` import for strict typing.
- Replaced ignored filesystem exceptions with scoped suppression and corrected
  mutable test fixtures and intentional external-output Unicode markers.
- Fixed MCP child reaping, serialization, timeout classification, workspace
  restart propagation, frozen executable dispatch, and first-save workspace
  configuration behavior.
- Fixed plugin archive expansion limits, startup and invocation failures,
  dynamic-import escapes, command revocation, and worker update reloads.
- Fixed terminal session deduplication, pre-creation subscriptions, pane/session
  synchronization, lifecycle ownership, and safe disposal.
- Fixed isolated-review application so accepted files commit atomically and
  checkpoint failures are reported without corrupting successful edits.

### Validation

- Frontend: 119 test files, 664 tests passed.
- Gateway: 823 passed, 1 skipped.
- Rust workspace: 49 unit tests plus doc tests passed.
- Schema drift, TypeScript typechecks, strict mypy (63 source files), Ruff,
  workspace ESLint, and Clippy with `-D warnings` passed.
- Production build passed for the Vite frontend, PyInstaller gateway sidecar,
  Rust hotpath/desktop crates, Tauri desktop binary, Debian package, RPM
  package, and portable Linux tarball.

### Release assets

- `Zoc AI_0.0.2_amd64.deb`
- `Zoc AI-0.0.2-1.x86_64.rpm`
- `zoc-studio-0.0.2-linux-x86_64.tar.gz`
- `SHA256SUMS`

## [0.0.1] - 2026-07-23

Preview release. Re-baselines the project version to `0.0.1` while the new
architecture stabilizes ahead of a public `1.0`.

### Added

- **About section** in Settings (product name, version, application ID,
  runtime, copyright, and a link to the project repository).
- Build-time app version injection (`__APP_VERSION__`) sourced from the
  canonical `VERSION` file, so the UI always reflects the shipped build.

### Changed

- Project version stamped to `0.0.1` across all manifests (`package.json`,
  `Cargo.toml`, `pyproject.toml`, `tauri.conf.json`).

## [2.0.0] - 2026-05-28

Full rewrite. The pre-rewrite Electron/Python codebase under `legacy/` has been
removed.

### Architecture

- **Desktop shell**: Tauri v2 (Rust) replaces the previous Electron container.
  Single-instance, loopback-only, no remote web origins.
- **Agent**: FastAPI sidecar (Python 3.11+) shipped as a single-file
  PyInstaller binary via Tauri's `externalBin`. No system Python required at
  runtime.
- **Hot path**: Standalone Rust crate `zoc-studio-hotpath` (PTY, fs watcher,
  code indexer) invoked as a child CLI from the agent. No PyO3 coupling.
- **Shared schema**: Pydantic v2 models are the single source of truth and are
  projected to TypeScript via `pnpm schema:generate`.
- **Frontend**: React + Vite + TypeScript + Tailwind + shadcn/ui. Talks to the
  agent over HTTP/WS on a port discovered from the Tauri shell.

### Features

- End-to-end agentic loop with permission gating and patch application.
- Per-workspace persistence (`desktop.json`) with legacy import flow.
- File system watcher with debounced `fs://changed` events.
- Secret storage via OS keyring.
- Streaming chat over SSE.
- Reproducible release pipeline (`make release` / `pnpm release`) that builds
  the frontend, bundles the sidecar, builds the Rust workspace, and produces
  per-OS Tauri installers under `dist/installers/`.
- Auto-update channel scaffolded (Tauri updater) with a documented placeholder
  endpoint, **disabled by default**.

### Breaking changes vs legacy

- The Electron app, its IPC protocol, and the `legacy/python/` agent are
  removed. Workspaces created by the legacy app can be imported on first run.
- Configuration files moved from `~/.config/zoc-studio-electron/` to the
  platform-appropriate Tauri config directory.
- Plugin/extension surface from the legacy app is **not** carried over.

### Out of scope for this release

- Code signing and notarization (documented in `README.md`; certs not bundled).
- Publication to package registries or app stores.
