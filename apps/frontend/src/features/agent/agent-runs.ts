/**
 * Multi-run model for the agent panel (§12.3).
 *
 * With up to `maxConcurrentRuns` runs in flight, the panel needs to answer three
 * questions: which runs exist, which one is focused, and how each is doing. That
 * bookkeeping is pure and lives here so the switcher's ordering, badge counts and
 * collapse rules are testable without rendering.
 */

/**
 * Lifecycle phases of a tracked run, mirroring the gateway's `RunState`
 * (`services/gateway/src/zocai_gateway/run_state.py`).
 *
 * `initializing` and `stopping` are the two transitions the user can see and
 * act on: the first covers the window between pressing Send and the gateway
 * accepting the run, the second the window between pressing Stop and the run
 * actually settling. Without them the UI had only "running", so a stop in
 * flight was indistinguishable from a run still working — and a failed stop
 * left the run stuck showing "Running…".
 */
export type RunPhase =
  | "initializing"
  | "running"
  | "stopping"
  | "paused"
  | "done"
  | "failed"
  | "cancelled";

export interface TrackedRun {
  runId: string;
  /** Mode the run was started in. */
  mode: "ask" | "plan" | "agent";
  phase: RunPhase;
  /** First line of the prompt, for the switcher label. */
  title: string;
  /** Epoch ms when the run started. */
  startedAt: number;
  /** Epoch ms when the run reached a terminal phase, if it has. */
  endedAt?: number;
  /** Latest stage/event type seen. */
  stage?: string;
  tokensUsed?: number;
  tokenLimit?: number;
}

const TERMINAL: ReadonlySet<RunPhase> = new Set<RunPhase>([
  "done",
  "failed",
  "cancelled",
]);

/** Whether a run has finished (and so should collapse to a summary card). */
export function isTerminal(run: Pick<TrackedRun, "phase">): boolean {
  return TERMINAL.has(run.phase);
}

/**
 * Whether the Stop control should be shown for this run: only while it is
 * initializing, running, or already stopping (Phase 3, stop-button rules).
 */
export function canStopRun(run: Pick<TrackedRun, "phase">): boolean {
  return run.phase === "initializing" || run.phase === "running" || run.phase === "stopping";
}

/**
 * Whether the Stop control should be disabled. True during the short `stopping`
 * transition, so rapid repeated clicks cannot queue duplicate cancellations.
 */
export function isStopPending(run: Pick<TrackedRun, "phase">): boolean {
  return run.phase === "stopping";
}

/** Short user-facing status label for a run (Phase 6). */
export function runStatusLabel(run: Pick<TrackedRun, "phase">): string {
  switch (run.phase) {
    case "initializing":
      return "Starting…";
    case "running":
      return "Running…";
    case "stopping":
      return "Stopping…";
    case "paused":
      return "Paused";
    case "done":
      return "Completed";
    case "cancelled":
      return "Stopped";
    case "failed":
      return "Failed";
  }
}

/** Runs still executing. */
export function activeRuns(runs: readonly TrackedRun[]): TrackedRun[] {
  return runs.filter((run) => !isTerminal(run));
}

/**
 * Display order for the stacked cards: active runs first (oldest first, so cards
 * do not jump as new runs start), then finished runs newest-first.
 */
export function orderRuns(runs: readonly TrackedRun[]): TrackedRun[] {
  const active = activeRuns(runs).sort((a, b) => a.startedAt - b.startedAt);
  const finished = runs
    .filter(isTerminal)
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
  return [...active, ...finished];
}

/** Label for the switcher's count badge, or null when a badge is pointless. */
export function runCountBadge(runs: readonly TrackedRun[]): string | null {
  const count = activeRuns(runs).length;
  return count > 1 ? String(count) : null;
}

/** Whether another run may be started. */
export function canStartRun(
  runs: readonly TrackedRun[],
  maxConcurrentRuns: number,
): boolean {
  return activeRuns(runs).length < Math.max(1, maxConcurrentRuns);
}

/** Short label for one run in the switcher list. */
export function runLabel(run: TrackedRun): string {
  const title = run.title.trim() || "Untitled run";
  return title.length > 48 ? `${title.slice(0, 47)}…` : title;
}

/** Which run should be focused after `runs` changes. */
export function resolveFocusedRun(
  runs: readonly TrackedRun[],
  focusedId: string | null,
): string | null {
  if (focusedId && runs.some((run) => run.runId === focusedId)) return focusedId;
  const ordered = orderRuns(runs);
  return ordered[0]?.runId ?? null;
}

/** Upsert a run, merging over any existing entry with the same id. */
export function upsertRun(
  runs: readonly TrackedRun[],
  next: TrackedRun,
): TrackedRun[] {
  const index = runs.findIndex((run) => run.runId === next.runId);
  if (index === -1) return [...runs, next];
  const merged = { ...runs[index], ...next };
  return [...runs.slice(0, index), merged, ...runs.slice(index + 1)];
}

/**
 * Mark a run terminal, stamping `endedAt` once.
 *
 * A run that is already terminal is left alone: several independent signals can
 * settle the same run (the terminal SSE frame, the cancel response, an
 * unexpected stream close) and whichever arrived first is the truth. Letting a
 * later signal overwrite it would, for example, relabel a run the user stopped
 * as "failed".
 */
export function finishRun(
  runs: readonly TrackedRun[],
  runId: string,
  phase: RunPhase,
  now: number,
): TrackedRun[] {
  return runs.map((run) => {
    if (run.runId !== runId) return run;
    if (isTerminal(run)) return run;
    return { ...run, phase, endedAt: run.endedAt ?? now };
  });
}

/** Human duration for a run card ("1m 04s"). */
export function runDuration(run: TrackedRun, now: number): string {
  const end = run.endedAt ?? now;
  const seconds = Math.max(0, Math.round((end - run.startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}
