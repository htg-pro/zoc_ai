/**
 * run-presence.ts — one answer to "is a run happening, and since when?".
 *
 * The panel header used to derive this inline from four unrelated signals:
 *
 *     const runActive = activeTrackedRuns.length > 0
 *       || (trackedRuns.length === 0 && streaming)
 *       || reviewRunning
 *       || testRunning;
 *
 * while each run card independently derived its own "active" from
 * `trace.status`. Two computations of the same fact drift: the header can read
 * "Building…" with a live pulse while every card below it says the run is done.
 *
 * The elapsed clock had a second, separate problem. It was started from
 * `Date.now()` whenever `runActive` flipped true, so it measured *how long the
 * header had been showing a run* rather than how long the run had been going.
 * Switching focus between concurrent runs, or a remount, restarted it at 0:00
 * for a run that had been working for minutes. Elapsed is now derived from the
 * run's own `startedAt`.
 */
import { activeRuns, isTerminal, type TrackedRun } from "./agent-runs";

export type RunPhase = "idle" | "running" | "paused";

export interface RunPresence {
  /** Whether anything is in flight — the single flag the chrome reacts to. */
  active: boolean;
  phase: RunPhase;
  /** The run the header describes and the stop control targets. */
  focusedRun?: TrackedRun;
  /** Wall-clock start of the described run, for the elapsed readout. */
  startedAt: number | null;
  /** The mode to label the panel with. */
  mode: string;
  /** The user-facing status sentence. */
  statusText: string;
  /** The run id a stop action applies to, if any. */
  stopRunId?: string;
}

export interface RunPresenceInput {
  trackedRuns: readonly TrackedRun[];
  focusedRunId?: string | null;
  /** Legacy flag for a run with no tracked entry (slash commands, legacy paths). */
  streaming: boolean;
  reviewRunning?: boolean;
  testRunning?: boolean;
  agentPaused?: boolean;
  viewerReadOnly?: boolean;
  /** The composer's toggle, used only when nothing is running. */
  agentMode: string;
  /** The mode of the run in flight, when one is known. */
  activeRunMode?: string | null;
  /** Fallback start time for a run with no tracked entry. */
  runStartedAt?: number | null;
}

export function deriveRunPresence(input: RunPresenceInput): RunPresence {
  const {
    trackedRuns,
    focusedRunId,
    streaming,
    reviewRunning = false,
    testRunning = false,
    agentPaused = false,
    viewerReadOnly = false,
    agentMode,
    activeRunMode,
    runStartedAt,
  } = input;

  const activeTracked = activeRuns(trackedRuns);
  // A run with no tracked entry (a slash command, or a legacy path that never
  // registered one) still counts as in flight — that is what `streaming` is for.
  const untrackedStreaming = trackedRuns.length === 0 && streaming;
  const active = activeTracked.length > 0 || untrackedStreaming || reviewRunning || testRunning;

  const focusedRun = active
    ? trackedRuns.find((run) => run.runId === focusedRunId) ??
      activeTracked[activeTracked.length - 1]
    : undefined;

  const phase: RunPhase = !active ? "idle" : agentPaused ? "paused" : "running";
  const mode = focusedRun?.mode ?? (active ? activeRunMode ?? agentMode : agentMode);

  const stopCandidate =
    focusedRun && !isTerminal(focusedRun)
      ? focusedRun
      : activeTracked[activeTracked.length - 1];

  return {
    active,
    phase,
    ...(focusedRun ? { focusedRun } : {}),
    // Prefer the run's own start time; fall back to the store's run clock for an
    // untracked run. Never "now": that is what reset the timer on every focus
    // change.
    startedAt: focusedRun?.startedAt ?? runStartedAt ?? null,
    mode,
    statusText: viewerReadOnly
      ? "Watching…"
      : agentPaused
        ? "Paused"
        : mode === "ask"
          ? "Answering…"
          : mode === "plan"
            ? "Planning…"
            : "Building…",
    ...(stopCandidate ? { stopRunId: stopCandidate.runId } : {}),
  };
}
