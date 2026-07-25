# Zoc AI v0.0.2 — Linux production-hardening patch

Released: 2026-07-25

This patch completes the advanced local-first agent/editor feature set and
closes the repository-wide regression, typing, lint, packaging, and runtime
integration backlog.

## Linux downloads

| Package | Use |
|---|---|
| `Zoc AI_0.0.2_amd64.deb` | Debian, Ubuntu, and derivatives |
| `Zoc AI-0.0.2-1.x86_64.rpm` | Fedora, RHEL, openSUSE, and derivatives |
| `zoc-studio-0.0.2-linux-x86_64.tar.gz` | Portable x86_64 Linux bundle |
| `SHA256SUMS` | Artifact integrity verification |

Verify downloads from the directory containing the files:

```bash
sha256sum --check SHA256SUMS
```

## Implementation patches

- **Reasoning and execution:** model-backed reasoning, strict structured plans,
  bounded ReAct tool execution, verification/remediation, pause/resume, and
  recovery ceilings.
- **Context engine:** persistent BM25/vector hybrid search, reciprocal-rank
  fusion, incremental indexing, token budgets, conversation compression, and
  workspace file steering.
- **Editor intelligence:** Monaco LSP diagnostics/navigation/rename/hover,
  Problems integration, cancellable inline completions, and safe Cmd+K edits.
- **MCP:** stdio JSON-RPC host, layered configuration, namespaced tools,
  permissions, child crash/timeout isolation, frozen-sidecar support, and
  built-in docs/Git/web-search servers.
- **Plugins:** constrained worker sandbox, bounded ZIP installation, validated
  manifests, namespaced storage, lifecycle timeouts, command registration, and
  marketplace controls.
- **Terminal:** up to four split panes, profiles, focus shortcuts, bounded
  transcripts, clickable output annotations, and agent-command correlation.
- **Workspace safety:** trust enforcement, destructive-intent detection,
  audited approvals, atomic Rust transactions, rollback, path/symlink
  confinement, and Git checkpoints.
- **Edit UX:** approval-aware multi-file staging, one-undo-group animated edits,
  dirty/stale-buffer protection, reduced motion, cursor reveal, and edit toasts.

## Bug-fix patches

- Restored disconnected browser-preview saves without bypassing real desktop or
  connected-web persistence.
- Eliminated stale completion and Cmd+K application races and stopped animated
  edit sequences when users modify Monaco mid-operation.
- Made approval decisions single-shot and replaced settled controls with an
  immutable result badge.
- Updated completion wording, accessibility labels, icon mocks, selectors, and
  preservation snapshots to the production Composer/AgentPanel design.
- Validated benchmark history JSON, retained camelCase external contracts, and
  rejected malformed quality-score values.
- Closed all strict Python typing errors in hardware probing, model streaming,
  and benchmark persistence.
- Fixed MCP process reaping, concurrent framing, timeout reporting, workspace
  propagation, frozen dispatch, and first-save configuration behavior.
- Hardened plugin archive limits, worker startup/invocation failure handling,
  import restrictions, command revocation, and update reloads.
- Fixed terminal session deduplication, subscriptions, lifecycle ownership,
  pane synchronization, and disposal.
- Made accepted review application atomic and surfaced checkpoint failures
  without rolling back already-valid committed edits.

## Validation evidence

- Frontend: **664 tests passed** across 119 files.
- Gateway: **823 passed, 1 skipped**.
- Rust workspace: **49 unit tests passed**, plus doc tests.
- Schema drift check, all TypeScript typechecks, strict mypy over 63 source
  files, Ruff, workspace ESLint, and Clippy with `-D warnings` passed.
- Production builds passed for Vite, the PyInstaller gateway sidecar, Rust
  hotpath/desktop, Tauri, `.deb`, `.rpm`, and portable `.tar.gz` packaging.

Non-failing development warnings remain for existing React test `act()` usage,
jsdom canvas/Radix descriptions, Monaco CSS loading under Node, nine ESLint
warnings, and Vite's Monaco chunk-size/dynamic-import notices.

## Install

Debian/Ubuntu:

```bash
sudo apt install ./Zoc\ AI_0.0.2_amd64.deb
```

RPM-based distributions:

```bash
sudo rpm -Uvh ./Zoc\ AI-0.0.2-1.x86_64.rpm
```

Portable bundle:

```bash
tar -xzf zoc-studio-0.0.2-linux-x86_64.tar.gz
./zoc-studio-0.0.2/bin/zoc-studio
```

Linux packages are unsigned. Code signing, notarization, and the Tauri updater
remain disabled unless separately configured by the distributor.
