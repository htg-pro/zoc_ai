/**
 * run-lifecycle.ts — the pure Run_Lifecycle_Controller reducer (R8.1–R8.5).
 *
 * The controller was four independent `useEffect` scans in
 * `useAgentRunLifecycle.ts`, each re-deriving terminal state from the whole
 * event array — which is why a stalled or disconnected run had no
 * representation. It becomes one pure reducer plus a thin effect layer.
 *
 * The clock is always an input (`atMs`), never `Date.now()`, so the stall,
 * reconnect, and cancel timings are testable without a wall clock.
 *
 * Terminal phases are ABSORBING: `reduceRun` on a record whose phase is already
 * terminal returns it unchanged. That single rule guarantees a settled run
 * never returns to "running" when a late frame arrives (Property 19).
 */
import type { AgentEvent } from "./useAgentStream";
import { sanitizeErrorForDisplay } from "@/lib/errors";
import type { AgentMode } from "./gateway-client";
import { type ReportedStage, isReportedStage } from "./stage-report";

export type RunPhase =
  | "starting"
  | "running"
  | "paused"
  | "stalled"
  | "reconnecting"
  | "interrupted"
  | "stopping"
  | "cancelled"
  | "done"
  | "failed";

export interface RunRecord {
  runId: string;
  mode: AgentMode; // R8.1
  startedAt: number; // R8.1
  phase: RunPhase;
  stage: ReportedStage | null;
  lastEventAt: number;
  /** Frozen once the run settles; drives the elapsed readout (R8.2). */
  endedAt: number | null;
  filesChanged: number; // R8.7
  outcomeReason: string | null; // R8.8
  reconnectAttempts: number;
}

export type LifecycleInput =
  | { kind: "event"; event: AgentEvent; atMs: number }
  | { kind: "tick"; atMs: number } // R8.3 stall detection
  | { kind: "disconnected"; atMs: number } // R8.4
  | { kind: "reconnect-failed"; atMs: number } // R8.4
  | { kind: "cancel-requested"; atMs: number } // R8.5
  | { kind: "cancel-acknowledged"; atMs: number }; // R8.5

/** A run with no Agent_Event for this long is stalled (R8.3). */
export const STALL_THRESHOLD_MS = 120_000;
/** A cancellation settles within this window of the Gateway acknowledgement (R8.5). */
export const CANCEL_SETTLE_MS = 2_000;

const TERMINAL_PHASES: ReadonlySet<RunPhase> = new Set<RunPhase>([
  "done",
  "failed",
  "cancelled",
  "interrupted",
]);

export function isTerminalPhase(phase: RunPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

/** A fresh run record in the `starting` phase (R8.1). */
export function startRun(input: {
  runId: string;
  mode: AgentMode;
  startedAt: number;
}): RunRecord {
  return {
    runId: input.runId,
    mode: input.mode,
    startedAt: input.startedAt,
    phase: "starting",
    stage: null,
    lastEventAt: input.startedAt,
    endedAt: null,
    filesChanged: 0,
    outcomeReason: null,
    reconnectAttempts: 0,
  };
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function safeOutcomeReason(value: unknown): string | null {
  const text = str(value);
  return text ? sanitizeErrorForDisplay("run_failed", text).message : null;
}

/** Interpret one Agent_Event against a live (non-terminal) record. */
function applyEvent(record: RunRecord, event: AgentEvent, atMs: number): RunRecord {
  const type = (event as { type?: unknown }).type;
  // Any live frame means the run is working again — recover from stall/reconnect.
  let phase: RunPhase =
    record.phase === "stalled" ||
    record.phase === "reconnecting" ||
    record.phase === "starting"
      ? "running"
      : record.phase;
  let stage = record.stage;

  if (type === "stage") {
    const s = (event as { stage?: unknown }).stage;
    if (isReportedStage(s)) stage = s;
  }

  if (type === "done") {
    const ok = (event as { ok?: unknown }).ok;
    const reason = safeOutcomeReason((event as { reason?: unknown }).reason);
    const filesChanged =
      num((event as { files_changed?: unknown }).files_changed) ??
      num((event as { filesChanged?: unknown }).filesChanged) ??
      record.filesChanged;
    return {
      ...record,
      phase: ok === false ? "failed" : "done",
      stage,
      lastEventAt: atMs,
      endedAt: atMs,
      filesChanged,
      outcomeReason: reason ?? record.outcomeReason,
    };
  }

  if (type === "error") {
    const message = safeOutcomeReason((event as { message?: unknown }).message);
    return {
      ...record,
      phase: "failed",
      stage,
      lastEventAt: atMs,
      endedAt: atMs,
      outcomeReason: message ?? record.outcomeReason,
    };
  }

  return { ...record, phase, stage, lastEventAt: atMs };
}

/**
 * The reducer. Pure: identical `(record, input)` yields an identical record.
 * A terminal record is returned unchanged for every input (absorbing).
 */
export function reduceRun(record: RunRecord, input: LifecycleInput): RunRecord {
  if (isTerminalPhase(record.phase)) return record;

  switch (input.kind) {
    case "event":
      return applyEvent(record, input.event, input.atMs);

    case "tick": {
      if (record.phase === "running" || record.phase === "starting") {
        if (input.atMs - record.lastEventAt >= STALL_THRESHOLD_MS) {
          // Retain the last known stage (Property 19).
          return { ...record, phase: "stalled" };
        }
      }
      return record;
    }

    case "disconnected":
      return {
        ...record,
        phase: "reconnecting",
        reconnectAttempts: record.reconnectAttempts + 1,
      };

    case "reconnect-failed":
      return { ...record, phase: "interrupted", endedAt: input.atMs };

    case "cancel-requested":
      return { ...record, phase: "stopping" };

    case "cancel-acknowledged":
      return { ...record, phase: "cancelled", endedAt: input.atMs };

    default:
      return record;
  }
}

/** Elapsed run duration in ms, frozen once the run has settled (R8.2). */
export function elapsedMs(record: RunRecord, nowMs: number): number {
  const end = record.endedAt ?? nowMs;
  return Math.max(0, end - record.startedAt);
}
