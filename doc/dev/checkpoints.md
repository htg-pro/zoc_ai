# Checkpoints & Restore — one-click "undo the agent's changes"

A competitive flagship feature (cf. Cursor / Claude Code "restore checkpoint").
When an agent run's changes are **applied** to the real workspace, Zoc first
snapshots the pre-change state of exactly the files about to change. The user
can then **Undo this run** to revert it completely.

## Flow

```
agent run (isolated copy) → review → Apply
                                       │
                                       ├─ snapshot pre-change files  → checkpoint (on disk, keyed by run_id)
                                       └─ copy changed files onto the real workspace
                                       
later:  Undo this run → restore_checkpoint(run_id) → workspace reverted
```

Restore is the exact inverse of the apply:
- modified file → pre-change bytes written back
- file the run **created** → deleted
- file the run **deleted** → recreated from the snapshot

## Backend

- `services/agent/src/zoc_studio_agent/agent/checkpoints.py` — persistent
  snapshot store under `tempfile.gettempdir()/zoc-agent-checkpoints/<hash>`,
  keyed by run id, surviving the isolated-run cleanup. Per-file capture is
  resilient (an unsnapshottable file is skipped, not fatal).
- `agent/zoc_run.py::apply_isolated_run` snapshots the changed files
  **before** writing them. Best-effort: a snapshot failure never blocks the
  apply (you just lose undo for that run).
- Endpoints (`v1/agent_run.py`):
  - `POST /v1/sessions/{id}/agent/runs/{run_id}/apply` → response now includes
    `checkpoint_id` (the restorable run id) and `failed_files`.
  - `POST /v1/sessions/{id}/agent/runs/{run_id}/restore` → `{ restored_files }`,
    404 if the checkpoint is unknown for the session.
  - `GET  /v1/sessions/{id}/agent/checkpoints` → list restorable checkpoints,
    newest first.

## Frontend

- `lib/agent-client.ts` — `restoreRun(sessionId, runId)` + `RestoreRunResult`;
  `ApplyRunResult.checkpoint_id`.
- `lib/store.ts` — `restorableRunId` captured from the apply result;
  `restoreCurrentRun()` action (emits `agent.run.restored` telemetry).
- `features/agent/AgentTimeline.tsx` — the resolved review card shows an
  **Undo this run** button while a checkpoint is restorable. After restore, the
  fs watcher refreshes open buffers.

## Tests

`services/agent/tests/test_checkpoints.py` (4): modify/create/delete revert,
wrong-session rejection, newest-first listing, and the end-to-end
apply→restore round-trip. Backend 193 / frontend 115 green; `tsc` + `ruff`
clean.

## Notes / future

- Checkpoints are captured for the **review-before-apply** (isolated) path.

## Timeline UI + retention (added)

- **GC:** `prune_checkpoints` evicts the oldest beyond `MAX_CHECKPOINTS_PER_SESSION`
  (25) per session, called automatically on each `create_checkpoint`, so the
  temp store stays bounded.
- **Typed endpoint:** `GET /v1/sessions/{id}/agent/checkpoints` → `CheckpointInfo[]`
  (run_id, label, created_at, files), newest first.
- **UI:** a **Checkpoints** tab in the bottom dock (`CheckpointsPanel`) lists the
  restore points with one-click **Restore** per entry, backed by store
  `checkpoints` + `loadCheckpoints()` + `restoreCheckpoint(runId)`; refreshed on
  session select and after each apply.
