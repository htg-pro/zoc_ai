# zocai-migration

Build-gated clean-rebuild migration controller for the Zoc AI Ecosystem
(Requirement 13).

This package implements the `MigrationController`: the policy engine that
enforces the **preservation-branch-first → replace-before-delete →
per-language build-gate** discipline before any legacy directory is removed.

The controller is pure policy. It performs no real git, build, or filesystem
mutation itself — it drives injectable `VersionControl`, `BuildRunner`, and
`FileSystem` abstractions. This keeps it deterministic and unit/property
testable (tasks 1.3–1.8) and lets the real legacy cutover (task 15) wire in
concrete git/cargo/pnpm/uv implementations.

## Guarantees enforced

- A committed preservation branch must exist before *any* legacy directory is
  removed (R13.2).
- Branch-creation failure and branch-commit failure are two independent halt
  conditions; both delete nothing (R13.3, R13.8).
- A legacy directory is never removed before its named replacement exists and
  its language build returns exit code 0 (R13.4, R13.6).
- Shared workspace build configuration is retained on every removal (R13.5).
- On any stage build failure the migration halts, retains the branch for
  rollback, and emits a failure indication naming the failed stage and the
  affected build (R13.7).
