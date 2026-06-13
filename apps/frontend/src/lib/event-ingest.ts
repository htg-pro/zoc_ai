/**
 * Agent_Event ingestion and ordering (R7.3, R8.2, R8.3, R8.4, R8.7, R8.8, R11.1).
 *
 * Pure logic that decides whether an incoming event is applied, buffered (while
 * paused), or discarded (duplicate/stale or after stop), plus the timeline
 * upsert-by-id/order-by-seq rule, isolated plan-step updates, tool-call status
 * labeling, and checkpoint ordering by creation time.
 */
import type {
  AgentEvent,
  PlanStep,
  ReplitCheckpoint,
  ToolCallStatus,
} from "@llama-studio/shared-types";

export type IngestDecision = "apply" | "buffer" | "discard";

export interface IngestState {
  /** Highest sequence number already processed for the session (R8.6). */
  highestSeq: number;
  /** True while the run is paused — events are buffered, not applied (R7.3). */
  paused: boolean;
  /** True once the run's stream has been stopped/terminated (R8.8). */
  stopped: boolean;
}

/**
 * Decide how to handle an event of a given sequence number:
 *  - discard if it is a duplicate/stale (`seq <= highestSeq`) (R8.7),
 *  - discard if the stream has been stopped (R8.8),
 *  - buffer if the run is paused (R7.3),
 *  - otherwise apply.
 */
export function decideIngest(seq: number, st: IngestState): IngestDecision {
  if (seq <= st.highestSeq) return "discard";
  if (st.stopped) return "discard";
  if (st.paused) return "buffer";
  return "apply";
}

/** Sequence number of any Agent_Event. */
export function eventSeq(event: AgentEvent): number {
  return event.seq;
}

/**
 * Stable identity used for timeline upsert. Message/tool/plan-step events carry
 * a domain id; others fall back to a type+seq composite so they remain unique.
 */
export function eventEntryId(event: AgentEvent): string {
  switch (event.type) {
    case "message":
      return `msg:${event.message.id}`;
    case "tool_call":
    case "tool.started":
    case "tool.completed":
      return `tool:${event.tool_call.id}`;
    case "plan_step":
      return `step:${event.step.id}`;
    default:
      return `${event.type}:${event.seq}`;
  }
}

export interface TimelineEntry {
  id: string;
  seq: number;
}

/**
 * Append the entry when its id is new, replace the existing entry when its id
 * already exists, and keep the result ordered ascending by `seq` (ties broken
 * by id for determinism) (R4.4, R8.2).
 */
export function upsertById<T extends TimelineEntry>(
  entries: readonly T[],
  entry: T,
): T[] {
  const next = entries.filter((e) => e.id !== entry.id);
  next.push(entry);
  next.sort((a, b) => (a.seq !== b.seq ? a.seq - b.seq : a.id.localeCompare(b.id)));
  return next;
}

/**
 * Drain buffered events on resume: apply only those past the resume cursor, in
 * ascending sequence order (R7.4). Returns the ordered events to apply and the
 * new highest sequence number.
 */
export function drainBuffer(
  buffer: readonly AgentEvent[],
  highestSeq: number,
): { apply: AgentEvent[]; highestSeq: number } {
  const apply = buffer
    .filter((e) => e.seq > highestSeq)
    .slice()
    .sort((a, b) => a.seq - b.seq);
  const newHighest = apply.reduce((m, e) => Math.max(m, e.seq), highestSeq);
  return { apply, highestSeq: newHighest };
}

/** The status label for a tool-call event, drawn from the event itself (R8.3). */
export function toolCallStatusLabel(status: ToolCallStatus): ToolCallStatus {
  return status;
}

/**
 * Apply a plan-step update in isolation: the matching step's status is set to
 * the event value; every other step is unchanged. An unknown step id is
 * appended (R8.4).
 */
export function applyPlanStep(steps: readonly PlanStep[], step: PlanStep): PlanStep[] {
  let found = false;
  const next = steps.map((s) => {
    if (s.id === step.id) {
      found = true;
      return { ...s, status: step.status, done: step.status === "done" };
    }
    return s;
  });
  if (!found) next.push(step);
  return next;
}

/** Order checkpoint entries by creation time, ties broken by id (R11.1, R32). */
export function orderCheckpoints(
  checkpoints: readonly ReplitCheckpoint[],
): ReplitCheckpoint[] {
  return checkpoints
    .slice()
    .sort((a, b) => {
      const ta = Date.parse(a.created_at);
      const tb = Date.parse(b.created_at);
      if (ta !== tb) return ta - tb;
      return a.id.localeCompare(b.id);
    });
}

/**
 * Extract the error detail to display from an error Agent_Event (R8.5). The
 * timeline content is retained by the caller (this function reads only).
 */
export function errorDetail(event: AgentEvent): string | null {
  if (event.type === "error") return event.detail ?? event.message;
  if (event.type === "agent.error") return event.detail ?? event.message ?? null;
  return null;
}
