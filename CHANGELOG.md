# Changelog

All notable changes to Zoc AI.

## [2.0.0] - 2026-05-28

Full rewrite. The pre-rewrite Electron/Python codebase under `legacy/` has been
removed.

### Architecture

- **Desktop shell**: Tauri v2 (Rust) replaces the previous Electron container.
  Single-instance, loopback-only, no remote web origins.
- **Agent**: FastAPI sidecar (Python 3.11+) shipped as a single-file
  PyInstaller binary via Tauri's `externalBin`. No system Python required at
  runtime.
- **Hot path**: Standalone Rust crate `llama-studio-hotpath` (PTY, fs watcher,
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
- Configuration files moved from `~/.config/llama-studio-electron/` to the
  platform-appropriate Tauri config directory.
- Plugin/extension surface from the legacy app is **not** carried over.

### Out of scope for this release

- Code signing and notarization (documented in `README.md`; certs not bundled).
- Publication to package registries or app stores.
