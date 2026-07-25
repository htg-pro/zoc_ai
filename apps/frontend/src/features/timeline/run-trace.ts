/**
 * Run trace model for the timeline viewer (§16.1).
 *
 * Turns a run's raw event list into the three things the panel renders: a
 * horizontal band of FSM stage segments, a flat chronological event list, and a
 * critical path. All pure, so the arithmetic that decides segment widths and
 * "where did the time go" is testable without a DOM.
 */
import type { AgentEvents } from "@zoc-studio/shared-types";

/** The FSM stages the timeline bands, with their documented colours (§16.1). */
export const STAGE_COLORS: Readonly<Record<string, string>> = {
  INTAKE: "#60a5fa", // blue
  ANALYZE: "#a78bfa", // purple
  PLAN: "#fbbf24", // amber
  APPLY: "#4ade80", // green
  VERIFY: "#2dd4bf", // teal
  SUMMARY: "#a1a1aa", // gray
};

/** Fallback colour for an event that maps to no known stage. */
export const UNKNOWN_STAGE_COLOR = "#52525B";

/**
 * Which stage an event type belongs to.
 *
 * The event contract does not carry a stage field, so the mapping lives here —
 * one place to change if the FSM gains a stage, rather than scattered `switch`
 * statements in the renderer.
 */
const EVENT_STAGE: Readonly<Record<string, string>> = {
  intent: "INTAKE",
  thinking: "ANALYZE",
  "map-files": "ANALYZE",
  "read-files": "ANALYZE",
  "context-compressed": "ANALYZE",
  plan: "PLAN",
  "plan-update": "PLAN",
  "plan-ready": "PLAN",
  approval: "PLAN",
  permission: "PLAN",
  "edit-file": "APPLY",
  command: "VERIFY",
  review: "VERIFY",
  "test-results": "VERIFY",
  "recovery-attempt": "VERIFY",
  summary: "SUMMARY",
  done: "SUMMARY",
  budget: "SUMMARY",
};

export function stageForEventType(type: string): string {
  return EVENT_STAGE[type] ?? "UNKNOWN";
}

export function stageColor(stage: string): string {
  return STAGE_COLORS[stage] ?? UNKNOWN_STAGE_COLOR;
}

/** A single event, normalised for display. */
export interface TraceEvent {
  seq: number;
  type: string;
  stage: string;
  /** Absolute epoch ms; 0 when the event carried no parseable timestamp. */
  ts: number;
  /** Milliseconds since the run started. */
  offsetMs: number;
  /** Milliseconds until the next event — the time attributable to this one. */
  durationMs: number;
  summary: string;
  /** The full original payload, for the expandable JSON view. */
  payload: Record<string, unknown>;
}

/** One contiguous band of a single stage. */
export interface StageSegment {
  stage: string;
  color: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  eventCount: number;
  /** Tokens first reported while this contiguous stage was active. */
  tokenCount: number;
  /** Fraction of the total run duration, 0–1. */
  ratio: number;
}

export interface RunTrace {
  runId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  events: TraceEvent[];
  segments: StageSegment[];
  totalTokens: number;
}

type RawEvent = AgentEvents.AgentEvent & Record<string, unknown>;

function parseTs(value: unknown): number {
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** One-line description of an event, chosen per type. */
export function summarizeEvent(event: Record<string, unknown>): string {
  const type = String(event.type ?? "");
  switch (type) {
    case "intent":
    case "thinking":
    case "summary":
      return String(event.text ?? "").split("\n")[0] || type;
    case "map-files":
    case "read-files": {
      const list = (event.readList ?? event.files ?? []) as unknown[];
      return `${list.length} file${list.length === 1 ? "" : "s"}`;
    }
    case "edit-file":
      return String(event.path ?? "");
    case "command":
      return String(event.command ?? "");
    case "plan": {
      const items = (event.items ?? []) as unknown[];
      return `${items.length} step${items.length === 1 ? "" : "s"}`;
    }
    case "plan-ready": {
      const steps = (event.steps ?? []) as unknown[];
      return `${steps.length} planned change${steps.length === 1 ? "" : "s"}`;
    }
    case "approval":
      return String(event.prompt ?? "");
    case "budget":
      return `${event.tokensUsed ?? 0} / ${event.tokenLimit ?? 0} tokens`;
    case "done":
      return event.ok ? "completed" : `failed: ${event.reason ?? "unknown"}`;
    default:
      return type;
  }
}

/**
 * Build the display trace from a run's events.
 *
 * Event *duration* is derived as the gap to the next event, because the contract
 * carries timestamps but not durations. The final event gets zero duration
 * rather than an invented one — pretending to know how long the last step took
 * would distort the critical path.
 */
export function buildRunTrace(runId: string, raw: readonly RawEvent[]): RunTrace {
  const ordered = [...raw]
    .filter((event) => event && typeof event.type === "string")
    .sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));

  if (ordered.length === 0) {
    return {
      runId,
      startedAt: 0,
      endedAt: 0,
      durationMs: 0,
      events: [],
      segments: [],
      totalTokens: 0,
    };
  }

  const stamps = ordered.map((event) => parseTs(event.ts));
  const known = stamps.filter((value) => value > 0);
  const startedAt = known.length ? Math.min(...known) : 0;
  const endedAt = known.length ? Math.max(...known) : 0;
  const durationMs = Math.max(0, endedAt - startedAt);

  const events: TraceEvent[] = ordered.map((event, index) => {
    const ts = stamps[index];
    const nextTs = stamps.slice(index + 1).find((value) => value > 0) ?? 0;
    return {
      seq: Number(event.seq ?? index),
      type: String(event.type),
      stage: stageForEventType(String(event.type)),
      ts,
      offsetMs: ts && startedAt ? ts - startedAt : 0,
      durationMs: ts && nextTs > ts ? nextTs - ts : 0,
      summary: summarizeEvent(event),
      payload: event as Record<string, unknown>,
    };
  });

  const totalTokens = ordered.reduce(
    (max, event) =>
      event.type === "budget" ? Math.max(max, Number(event.tokensUsed ?? 0)) : max,
    0,
  );

  return {
    runId,
    startedAt,
    endedAt,
    durationMs,
    events,
    segments: buildSegments(events, durationMs),
    totalTokens,
  };
}

/**
 * Collapse consecutive same-stage events into bands.
 *
 * Consecutive rather than grouped-by-stage: a run that re-enters PLAN after a
 * failed APPLY should show two amber bands, which is exactly the information a
 * user is looking for when they open a timeline.
 */
export function buildSegments(
  events: readonly TraceEvent[],
  totalMs: number,
): StageSegment[] {
  const segments: StageSegment[] = [];
  let previousTokenReading = 0;
  for (const event of events) {
    const last = segments[segments.length - 1];
    // Budget frames are snapshots, not FSM transitions. Attribute their token
    // delta to the stage that was active immediately before the snapshot.
    const stage = event.type === "budget" && last ? last.stage : event.stage;
    const reading = event.type === "budget"
      ? Math.max(0, Number(event.payload.tokensUsed ?? 0))
      : previousTokenReading;
    const tokenDelta = Math.max(0, reading - previousTokenReading);
    if (event.type === "budget") previousTokenReading = Math.max(previousTokenReading, reading);

    if (last && last.stage === stage) {
      last.endMs = Math.max(last.endMs, event.offsetMs + event.durationMs);
      last.eventCount += 1;
      last.tokenCount += tokenDelta;
      continue;
    }
    segments.push({
      stage,
      color: stageColor(stage),
      startMs: event.offsetMs,
      endMs: event.offsetMs + event.durationMs,
      durationMs: 0,
      eventCount: 1,
      tokenCount: tokenDelta,
      ratio: 0,
    });
  }

  for (const segment of segments) {
    segment.durationMs = Math.max(0, segment.endMs - segment.startMs);
    segment.ratio = totalMs > 0 ? segment.durationMs / totalMs : 0;
  }
  return segments;
}

/**
 * The longest chain of blocking events — where the run actually spent time (§16.1).
 *
 * The run is a single sequential FSM, so its critical path *is* its slowest
 * events; the "chain" is the ordered subset accounting for most of the wall
 * clock. Returns the `seq` values covering at least `coverage` of the total
 * duration, so highlighting them explains the bulk of the run.
 */
export function criticalPath(trace: RunTrace, coverage = 0.8): number[] {
  const total = trace.events.reduce((sum, event) => sum + event.durationMs, 0);
  if (total <= 0) return [];
  const ranked = [...trace.events]
    .filter((event) => event.durationMs > 0)
    .sort((a, b) => b.durationMs - a.durationMs);

  const picked: number[] = [];
  let accumulated = 0;
  for (const event of ranked) {
    picked.push(event.seq);
    accumulated += event.durationMs;
    if (accumulated / total >= coverage) break;
  }
  return picked.sort((a, b) => a - b);
}

/** "1.2s" / "340ms" / "2m 05s" */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** "+1.4s" relative offset label for the event list. */
export function formatOffset(ms: number): string {
  return `+${formatDuration(ms)}`;
}

/** The JSON blob written by the export button. */
export function serializeTrace(trace: RunTrace): string {
  return JSON.stringify(
    {
      runId: trace.runId,
      startedAt: trace.startedAt ? new Date(trace.startedAt).toISOString() : null,
      endedAt: trace.endedAt ? new Date(trace.endedAt).toISOString() : null,
      durationMs: trace.durationMs,
      totalTokens: trace.totalTokens,
      segments: trace.segments,
      events: trace.events.map((event) => ({
        seq: event.seq,
        type: event.type,
        stage: event.stage,
        offsetMs: event.offsetMs,
        durationMs: event.durationMs,
        summary: event.summary,
        payload: event.payload,
      })),
    },
    null,
    2,
  );
}

/** Suggested filename for the exported trace. */
export function traceFilename(runId: string): string {
  const safe = runId.replace(/[^\w.-]/g, "-") || "run";
  return `zoc-trace-${safe}.json`;
}
