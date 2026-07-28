/**
 * keyboard-actions.ts — pure resolution of the submit/cancel key bindings and
 * the live-region announcement policy (R20.3, R20.4, R20.6).
 *
 * A keyboard start obeys exactly the same gate as the Send button, and cancel
 * issues at most one request and only while a run is active. Streaming
 * announces on phase/stage change, never per token, so the number of live
 * updates is bounded by a small constant independent of token count.
 */
import type { RunGate } from "./model-availability";
import type { AgentEvent } from "./useAgentStream";

/** The submit key resolves to a run start exactly when the gate allows it. */
export function submitAction(gate: RunGate): "start" | "blocked" {
  return gate.canStart ? "start" : "blocked";
}

/** The cancel key resolves to one cancellation only while a run is active. */
export function cancelAction(activeRunCount: number): "cancel" | "noop" {
  return activeRunCount > 0 ? "cancel" : "noop";
}

/**
 * The number of live-region announcements a sequence of events produces. Only a
 * phase change (terminal frames) or a stage change is announced; token frames
 * are never announced, so the count is bounded independent of token count.
 */
export function announcementCount(events: readonly AgentEvent[]): number {
  let count = 0;
  let lastStage: string | null = null;
  for (const event of events) {
    const type = (event as { type?: unknown }).type;
    if (type === "stage") {
      const stage = (event as { stage?: unknown }).stage;
      if (typeof stage === "string" && stage !== lastStage) {
        lastStage = stage;
        count += 1;
      }
    } else if (type === "done" || type === "error") {
      count += 1;
    }
  }
  return count;
}
