# Design: Advanced File System (Part 7)

## 7.2 Atomic transaction (implemented)

`crates/hotpath/src/transaction.rs` — a pure `std::fs` primitive reused by the
Tauri `apply_patch` command (which already depends on `zoc-studio-hotpath`).

```rust
pub struct Transaction { /* staged ops */ }
impl Transaction {
    pub fn new() -> Self;
    pub fn add_write(&mut self, path: impl Into<PathBuf>, content: impl Into<Vec<u8>>);
    pub fn add_delete(&mut self, path: impl Into<PathBuf>);
    pub fn commit(&self) -> Result<CommitResult, TransactionError>; // { written, deleted } | { path, source }
}
```

`commit()` is a three-phase algorithm:
- **Phase 0 (backup):** read every touched path into an in-memory `Backup`
  (`Some(bytes)` or `None` when absent). A non-`NotFound` read error aborts
  before any change (an unreadable file is never mistaken for absent).
- **Phase 1 (stage):** write each content to a `.<name>.zoc_tmp_<nanos>_<n>`
  temp in the same directory (creating parents); a failure cleans up temps and
  returns — no final path was touched (trivially atomic).
- **Phase 2 (apply):** `rename` each temp into place, then apply deletes. Any
  failure calls `restore(backups)` (rewriting originals / removing files that
  didn't exist) and removes leftover temps, then returns the failing path.

### Correctness Properties (cargo-tested)
- **P1 — Atomic apply.** A commit either applies every op or, on failure, leaves
  the workspace exactly as before (verified: `failed_operation_leaves_workspace_unchanged`).
- **P2 — Temp+rename.** Writes are staged as temps then renamed; parents are
  created; existing files are overwritten (`commit_applies_multiple_writes_atomically`,
  `commit_creates_missing_parents_and_overwrites`).
- **P3 — Delete semantics.** Deletes remove files; a missing delete is a no-op
  (`commit_deletes_files_and_ignores_missing`).

Tauri integration (desktop build env): a multi-file `apply_transaction` command
builds a `Transaction` from N `{path, content|delete}` ops (each validated via
`ensure_within_workspace`), commits it, and — when the workspace is a git repo
with pending changes — runs `git add -A && git commit -m "zoc: pre-run
checkpoint"` (skipped on a clean tree). This wiring is verified in the Tauri
toolchain (it needs webkit2gtk etc.), not in the pure-crate test run.

## 7.1 Trust wiring (planned)

Route `toolsets.py` tool execution through a `check_permission(kind, name,
target)` Tauri IPC (Rust `workspace.rs`/permissions) returning
`allow|deny|prompt`; `prompt` → `ApprovalEvent`. Composer detects destructive
intent and lowers autonomy. A Security → Audit Log panel renders `trust.ts`
`getAuditLog()`. Reuses the already-tested `evaluatePermission` engine.
