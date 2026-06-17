# Agent Run Flow

How a user message becomes agent work, and how changes reach the real
workspace. Read this before touching `v1/agent_run.py`, `agent/orchestrator.py`,
or `agent/zoc_run.py`.

## The big picture

There is one conceptual object: an **Agent Run**. The agent plans *as part of*
running by maintaining a live to-do list (`todo_write` tool → `todo_update`
event), executes tools, and streams everything back. Two modes:

- **Ask** (read-only): tools restricted to `ASK_MODE_TOOLS` (read/search/list).
  No writes, no checkpoint, no review. Pure Q&A.
- **Agent** (full autonomy): all tools available. With `reviewChanges: true`,
  the run executes in an **isolated copy** of the workspace so the real project
  is never touched until the user clicks **Apply**.

## Request → response

`POST /v1/sessions/{id}/agent/run` (`v1/agent_run.py`):

1. Resolve the workspace path and (optionally) bring-your-own provider creds.
2. **If `review_changes` and mode == agent:** `prepare_isolated_run(...)`
   copies the workspace to a temp dir and emits a `checkpoint.created` event.
   The orchestrator then runs against the *copy*, not the source.
3. Run the orchestrator under `asyncio.wait_for(..., timeout=AGENT_RUN_TIMEOUT_S)`
   inside `state.runs.track(session.id)` (liveness for approval recovery).
4. **On any failure or cancellation:** the isolated run is discarded (see
   "Invariants"). On timeout specifically → HTTP 504.
5. **On success with an isolated run:** `finalize_isolated_run(...)` computes
   the aggregated diff + validation results, sets status `awaiting_review`
   (or `applied` if nothing changed), and emits `run.awaiting_review` +
   `diff.ready`. The JSON response also carries a `review` object.

The streaming events (not the JSON body) drive the UI; the body is a
convenience/summary.

## SSE events (`AgentEvent` union)

Defined in `packages/shared-types/python/shared_schema/models.py`, mirrored in
TS. The agent emits both **legacy** `agent.*`/`diff`/plan events (which still
drive the live UI) and the newer **redesign** events, additively:

| Event | `type` | Meaning |
|-------|--------|---------|
| `TodoUpdateEvent` | `todo_update` | Full snapshot of the agent's live to-do list |
| `RunLifecycleEvent` | `run.started` / `run.context_ready` / `run.awaiting_review` / `run.applied` / `run.discarded` / `run.error` | Run lifecycle transitions |
| `CheckpointCreatedEvent` | `checkpoint.created` | Pristine snapshot taken before changes (carries `run_id`) |
| `DiffReadyEvent` | `diff.ready` | Aggregated patches + validation at end of run |
| `DiffEvent` | `diff` | Per-write file change (legacy, still drives diff cards) |
| `ToolStarted/Completed/ToolCallEvent` | `tool.*` | Tool activity |

When adding an event: add the Pydantic model, include it in the `AgentEvent`
union, run `pnpm schema:generate`, and handle it in the frontend
`applyAgentEvent` (in `store.ts`). New events should be no-ops in the frontend
until intentionally wired, to keep migration safe.

## Apply / Discard

Two endpoints resolve an isolated run:

- `POST /runs/{run_id}/apply` → `apply_isolated_run(run)` copies each changed
  file from the isolated copy onto the real workspace. **The single explicit
  approval gate.** Returns `applied_files` and `failed_files`.
- `POST /runs/{run_id}/discard` → `discard_isolated_run(run)` throws the copy
  away; the real workspace is untouched.

Both return 404 if the run id is unknown for the session; apply returns 409 if
the run is not `awaiting_review`/`applying`.

## Isolation invariants (don't break these)

These are enforced in `agent/zoc_run.py` and covered by `tests/test_zoc_run.py`:

1. **The copy lives outside the source workspace.** `_runs_root()` anchors runs
   under `tempfile.gettempdir()/zoc-agent-runs/<sha1(data_dir)>`. Putting it
   inside the workspace causes `copytree` to recurse into its own destination
   ("File name too long"). This was a real bug — keep it in temp.
2. **No leaks on failure.** Any abnormal termination (provider error, tool
   error, client-disconnect `CancelledError`, timeout) discards the isolated
   run, removing both the registry entry and the temp dir. `apply_isolated_run`
   cleans up in a `finally`.
3. **Partial apply is reported, not hidden.** Files are applied independently;
   a per-file failure is recorded on `run.failed` and surfaced as
   `failed_files`. If *nothing* applied, the endpoint returns 500. The frontend
   (`applyCurrentRun` in `store.ts`) surfaces partial failures instead of
   silently collapsing the review.
4. **`changed_files` uses a size short-circuit** before reading file bytes — a
   differing size means differing content, so large files aren't fully read
   unless sizes match.

## Frontend run lifecycle

The pure reducer in `apps/frontend/src/lib/run-machine.ts` models the lifecycle:

```
idle → running → (paused ⇄ running) → completed | stopped | error
running → awaiting_review → applying → applied
                          → discarded
```

Terminal states: `stopped`, `completed`, `error`, `applied`, `discarded`.
A terminal transition releases any queued message exactly once
(`releaseQueuedMessage`, R4.11/R4.14). The store wires side effects (abort the
previous stream *before* assigning the new run id — bug #4) around these
transitions.
