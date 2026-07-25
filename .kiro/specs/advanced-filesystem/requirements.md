# Requirements: Advanced File System (Part 7)

## Introduction

Part 7 hardens agent file writes and workspace trust:

- **7.1 Workspace trust wiring** — route every agent tool through the unified
  permission engine before it executes, surface a `prompt` decision as a
  `decision_required` event, auto-lower autonomy on destructive intent, and add
  a Security → Audit Log panel. (The pure engine `permissions-engine.ts` +
  `trust.ts` audit already exist; this wires them into the run flow.)
- **7.2 Atomic multi-file transaction** — make multi-file agent writes
  all-or-nothing with rollback, via a reusable `Transaction` primitive; on a
  successful commit in a git repo, create a `zoc: pre-run checkpoint` commit
  when there are pending changes.

## Requirements

### Requirement 1 — Atomic multi-file transaction (7.2)

**User Story:** As a user, I want a multi-file agent edit to either fully apply
or leave my workspace untouched.

#### Acceptance Criteria
1. A `Transaction` SHALL stage write and delete operations and apply them via
   `commit()`.
2. WHEN committing THEN each write SHALL first go to a temp file in the same
   directory; only after every temp write succeeds SHALL the temps be renamed
   into place.
3. IF any operation fails THEN `commit()` SHALL roll back every already-applied
   change from an in-memory backup and return the failing path; the workspace
   SHALL be left exactly as before.
4. A delete of a missing file SHALL be a no-op (not an error); missing parent
   directories for a write SHALL be created.
5. `commit()` SHALL be pure of Tauri so it is unit-testable in the hot-path
   crate; the desktop `apply_patch`/multi-file apply command SHALL use it.
6. AFTER a successful commit in a git repo with pending changes, a
   `zoc: pre-run checkpoint` commit SHOULD be created (skipped when the tree is
   clean, to avoid empty commits).

### Requirement 2 — Workspace trust wiring (7.1)

**User Story:** As a user, I want agent actions gated by workspace trust and
permissions, with an audit trail.

#### Acceptance Criteria
1. BEFORE executing any agent tool THEN the run SHALL evaluate a permission for
   the action (kind + name + target) and, on `deny`, refuse; on `prompt`, emit a
   `decision_required` approval and wait.
2. WHEN the user's message contains destructive intent (`delete all`,
   `drop table`, `rm -rf`) THEN autonomy SHALL drop to the cautious level with a
   visible warning banner.
3. A Security → Audit Log panel SHALL list every permission decision
   (allow/deny/prompt) with timestamp, kind, name, target, and reason.

## Non-goals
- The `Transaction` primitive lives in the pure `crates/hotpath` crate (cargo-
  testable); the Tauri command wiring + git checkpoint are verified in the
  desktop build environment (they require the Tauri toolchain).
