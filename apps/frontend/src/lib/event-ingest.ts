/**
 * Agent_Event timeline helpers (R8.2, R8.3, R8.4, R11.1).
 *
 * Pure timeline logic: the upsert-by-id/order-by-seq rule, buffered-event
 * draining on resume, isolated plan-step updates, tool-call status labeling,
 * and error-detail extraction.
 *
 * The ingest-decision gate (`decideIngest`) that previously lived here is
 * retired: the Event_Normalizer (`features/agent/normalize.ts`) is the single
 * path that decides what enters the feed, owning the cross-run, duplicate-seq,
 * and malformed discard rules (R9.1, R9.6). The helpers below have no overlap
 * with normalization and keep their own tests.
 */
import type {
  AgentEvent,
  PlanStep,
  ToolCallStatus,
} from "@zoc-studio/shared-types";

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

/**
 * Extract the error detail to display from an error Agent_Event (R8.5). The
 * timeline content is retained by the caller (this function reads only).
 */
export function errorDetail(event: AgentEvent): string | null {
  if (event.type === "error") return event.detail ?? event.message;
  if (event.type === "agent.error") return event.detail ?? event.message ?? null;
  return null;
}
