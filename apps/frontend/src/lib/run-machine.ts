/**
 * Run lifecycle state machine (R7, R4.11, R4.14).
 *
 * Pure reducer over the Run slice. The store wires side effects (aborting the
 * previous stream, opening the SSE connection) around these transitions, but
 * the lifecycle rules themselves live here so they can be exercised with
 * generated action sequences.
 *
 * Bug #4 (start ordering) is enforced at the store layer by aborting the
 * previous controller before dispatching `start`; the reducer guarantees the
 * post-condition that a started run is the single active run (Property 24).
 */

export type RunLifecycle =
  | "idle"
  | "running"
  | "paused"
  | "stopped"
  | "completed"
  | "error"
  // Redesign (Part 3): a run whose execution finished with file changes
  // waits for the user's explicit Apply/Discard decision before touching
  // the main workspace.
  | "awaiting_review"
  | "applying"
  | "applied"
  | "discarded";

export type AutonomyLevel = "Low" | "Medium" | "High";

export interface RunConfig {
  autonomy: AutonomyLevel;
  model: string;
  mode: "plan" | "build";
}

export const DEFAULT_RUN_CONFIG: RunConfig = {
  autonomy: "Medium",
  model: "",
  mode: "build",
};

export interface RunState {
  lifecycle: RunLifecycle;
  /** The BACKEND-issued run id of the active run (was client-only) (R1.3). */
  runId: string | null;
  /**
   * The user `Message.id` this run answers, recorded on `start` (R1.1).
   * Preserved through terminal transitions so a completed run record still
   * carries the message it was bound to.
   */
  boundMessageId: string | null;
  startedAt: number | null;
  config: RunConfig;
  /**
   * Retained field, but the authoritative seq floor now lives in the shared
   * `SeqCursor` (Component 3 / `seq-cursor.ts`). The reducer no longer resets
   * this on `start`, so a fresh run cannot strand a prior run's stale events
   * as "new".
   */
  highestSeq: number;
  error: string | null;
  /** Single pending message held while a run is active (R4.11). */
  queuedMessage: string | null;
}

export const INITIAL_RUN_STATE: RunState = {
  lifecycle: "idle",
  runId: null,
  boundMessageId: null,
  startedAt: null,
  config: { ...DEFAULT_RUN_CONFIG },
  highestSeq: 0,
  error: null,
  queuedMessage: null,
};

export type RunAction =
  | {
      type: "start";
      runId: string;
      boundMessageId: string;
      at: number;
      config?: Partial<RunConfig>;
    }
  | { type: "start-failed"; detail: string }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop" }
  | { type: "done" }
  | { type: "error"; detail: string }
  | { type: "stream-lost"; detail: string }
  | { type: "queue"; text: string }
  | { type: "config"; config: Partial<RunConfig> }
  // Redesign (Part 3): review lifecycle for runs that produced changes.
  | { type: "await-review" }
  | { type: "apply" }
  | { type: "applied" }
  | { type: "discard" };

const TERMINAL: ReadonlySet<RunLifecycle> = new Set([
  "stopped",
  "completed",
  "error",
  "applied",
  "discarded",
]);

export function isTerminal(lifecycle: RunLifecycle): boolean {
  return TERMINAL.has(lifecycle);
}

export function isActive(lifecycle: RunLifecycle): boolean {
  return lifecycle === "running" || lifecycle === "paused";
}

/** On entering a terminal state the active run id is cleared (R7.10). */
function enterTerminal(
  state: RunState,
  lifecycle: RunLifecycle,
  error: string | null,
): RunState {
  return { ...state, lifecycle, runId: null, error };
}

export function runReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case "start":
      // R1.8: a run cannot start without a bound user message. The caller
      // (store, task 9.1) is responsible for resolving the bound message id;
      // the reducer must not invent a binding. If none is supplied, stay put
      // and retain the prior run/message association unchanged.
      if (!action.boundMessageId) {
        return state;
      }
      // Start from any state yields exactly one active run with a fresh id
      // bound to the triggering message. The seq floor is owned by the shared
      // cursor (Component 3), so we deliberately do NOT reset `highestSeq`
      // here — resetting it would strand a prior run's stale events as "new".
      return {
        ...state,
        lifecycle: "running",
        runId: action.runId,
        boundMessageId: action.boundMessageId,
        startedAt: action.at,
        error: null,
        config: action.config
          ? { ...state.config, ...action.config }
          : state.config,
      };

    case "start-failed":
      // Failed start: stay idle, no run id, record the error (R7.2).
      return {
        ...state,
        lifecycle: "idle",
        runId: null,
        startedAt: null,
        error: action.detail,
      };

    case "pause":
      return state.lifecycle === "running"
        ? { ...state, lifecycle: "paused" }
        : state;

    case "resume":
      return state.lifecycle === "paused"
        ? { ...state, lifecycle: "running" }
        : state;

    case "stop":
      return isActive(state.lifecycle)
        ? enterTerminal(state, "stopped", state.error)
        : state;

    case "done":
      return isActive(state.lifecycle)
        ? enterTerminal(state, "completed", state.error)
        : state;

    case "await-review":
      // A run that produced changes finished executing and now waits for
      // the user's Apply/Discard decision. Keep the run id so the review
      // controls can reference it.
      return isActive(state.lifecycle)
        ? { ...state, lifecycle: "awaiting_review" }
        : state;

    case "apply":
      return state.lifecycle === "awaiting_review"
        ? { ...state, lifecycle: "applying" }
        : state;

    case "applied":
      return state.lifecycle === "applying" || state.lifecycle === "awaiting_review"
        ? enterTerminal(state, "applied", state.error)
        : state;

    case "discard":
      return state.lifecycle === "awaiting_review"
        ? enterTerminal(state, "discarded", state.error)
        : state;

    case "error":
    case "stream-lost":
      // An error can arrive at any time; retain prior content (R8.5).
      return enterTerminal(state, "error", action.detail);

    case "queue":
      // Only hold a queued message while a run is active (R4.11).
      return isActive(state.lifecycle)
        ? { ...state, queuedMessage: action.text }
        : state;

    case "config":
      return { ...state, config: { ...state.config, ...action.config } };
  }
}

export interface ControlAvailability {
  pause: boolean;
  resume: boolean;
  stop: boolean;
  /** Whether to render the resume control in place of pause (R7.7). */
  showResume: boolean;
}

/** Enabled/disabled state of the run controls, purely from the lifecycle (R7.8). */
export function controlAvailability(
  lifecycle: RunLifecycle,
): ControlAvailability {
  switch (lifecycle) {
    case "running":
      return { pause: true, resume: false, stop: true, showResume: false };
    case "paused":
      return { pause: false, resume: true, stop: true, showResume: true };
    // idle and all terminal states disable every control.
    default:
      return { pause: false, resume: false, stop: false, showResume: false };
  }
}

/**
 * Release the pending queued message exactly once on a terminal transition
 * (R4.14). Returns the text to start a new run with (or null) and the state
 * with the queue cleared.
 */
export function releaseQueuedMessage(state: RunState): {
  state: RunState;
  start: string | null;
} {
  if (isTerminal(state.lifecycle) && state.queuedMessage !== null) {
    return {
      state: { ...state, queuedMessage: null },
      start: state.queuedMessage,
    };
  }
  return { state, start: null };
}
