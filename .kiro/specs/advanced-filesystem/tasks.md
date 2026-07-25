# Implementation Plan: Advanced File System (Part 7)

## Progress (2026-07-24)

- **7.2 atomic transaction CORE — DONE + verified.** `crates/hotpath/src/transaction.rs`
  (`Transaction` / `add_write` / `add_delete` / `commit` → temp+rename,
  all-or-nothing, in-memory rollback). `cargo test -p zoc-studio-hotpath
  transaction` = 5 pass; `cargo clippy … -D warnings` clean. Registered in
  `crates/hotpath/src/lib.rs`.
- **7.1 (partial) — DONE + verified (frontend pieces).** `lib/destructive-intent.ts`
  pure `detectDestructiveIntent` (delete-all / drop-table / rm -rf / git reset
  --hard / git clean -f / git push --force / truncate / mkfs / dd) —
  `destructive-intent.test.ts` (2). `features/settings/sections/AuditLog.tsx`
  Security → Audit Log panel over `trust.ts` `getAuditLog`/`subscribeTrust`/
  `clearAuditLog` — `AuditLog.test.tsx` (3). Typecheck + eslint clean.
  **Remaining 7.1:** wire `detectDestructiveIntent` into the Composer (lower
  autonomy + banner), mount `AuditLogSection` in the Settings nav, and add the
  gateway `check_permission` gate before `toolsets.py` tool execution.

- **7.1 gateway gate — DONE + verified.** `react.py` `ReActExecutor` gained an
  injectable `check_permission: PermissionGate` (`(kind, target) → allow/deny/
  prompt`); `_dispatch` refuses any side-effecting tool (write/delete/move/
  make_dir/run_shell) whose decision is not `allow` (fail-closed, surfaces a
  permission observation, loop continues); reads are always allowed. Defaults
  `None` (zero regression). `test_react_permission_gate.py` (3): fs-allowed
  executes, terminal-denied refused (no command row), deny-all blocks the write,
  allow-all runs both. Full gateway suite **781 passed** (3 new); ruff + mypy
  clean. **Still remaining:** thread a real permission source into
  `check_permission` from `run_pipeline`/`app` (the seam is in place, gate
  defaults off until wired) + the Composer/Settings-nav wiring above.

## Tasks

- [x] 1. Atomic transaction primitive (`crates/hotpath/src/transaction.rs`)
  - [x] 1.1 `Transaction` + `commit` (backup → temp → rename/delete → rollback).
    - _Requirements: 1.1–1.5_
  - [x]* 1.2 cargo tests: atomic multi-write, parent creation + overwrite, delete
    + missing no-op, failed-op-leaves-workspace-unchanged, empty tx.

- [x] 2. Desktop wiring (`apps/desktop/src/patch.rs`) — **DONE + verified**
  - [x] 2.1 `apply_transaction` command: validates each op path via
    `ensure_within_workspace`, builds a hot-path `Transaction` (`add_write`/
    `add_delete`), commits atomically; registered in `lib.rs` `generate_handler`.
    `cargo check -p zoc-studio-desktop` + clippy clean.
    - _Requirements: 1.5_
  - [x] 2.2 Post-commit `zoc: pre-run checkpoint` via `hotpath::checkpoint::
    git_checkpoint` (clean tree / non-repo → `None`; dirty → `add -A` + `commit
    --no-verify` + `rev-parse HEAD`). 3 temp-repo cargo tests; clippy clean.
    - _Requirements: 1.6_

- [x] 3. 7.1 Workspace trust wiring — **DONE + verified (end-to-end)**
  - [x] 3.1 Gateway permission gate: `permissions.py` (Python port of
    `permissions-engine.ts`, 8 tests) → `check_permission` seam threaded
    `run_pipeline` → `execute_run` → `ReActApplyExecutor` → `ReActExecutor._dispatch`
    (refuses any side-effecting tool whose decision is not `allow`, fail-closed) →
    built in `app.py` from the frontend-sent `AgentRunRequest.permission`. A
    `prompt` decision is now **interactive**: emits an `ApprovalEvent` and blocks
    on the existing `wait_for_approval_decision` channel (approve→proceed,
    reject/timeout/no-waiter→fail-closed refuse). Full gateway suite 801 passed;
    `test_react_permission_gate.py` = 8 tests; mypy+ruff clean.
    - _Requirements: 2.1_
  - [x] 3.2 Composer destructive-intent banner + `setRunMode("ask")` cautious mode
    (`detectDestructiveIntent`); frontend sends `getTrustConfig()` on the run
    request. `composer.destructive-intent.test.tsx` (3).
    - _Requirements: 2.2_
  - [x] 3.3 Security → Audit Log: `AuditLogSection` mounted in `SettingsView` nav;
    `AuditLog.test.tsx` (3). Typecheck + eslint clean on all changed frontend files.
    - _Requirements: 2.3_

## Notes
- The verified deliverable here is the pure `Transaction` core (task 1). Tasks 2
  and 3 are the Tauri/gateway integration, verified in their respective build
  environments.
