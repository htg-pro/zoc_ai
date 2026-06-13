/**
 * SSE reconnection policy (R7.4, R8.6, R8.9).
 *
 * Pure decision function: a (re)subscription always requests events after the
 * highest processed sequence number; on interruption before a terminal state
 * the stream re-subscribes from that cursor for up to 5 attempts, then gives up
 * with a stream-lost detail.
 */

export const MAX_RECONNECTS = 5;

export const STREAM_LOST_DETAIL =
  "stream lost: the agent event stream was interrupted and could not be" +
  " re-established after 5 attempts.";

/** The `since_seq` cursor for a (re)subscription is the highest processed seq (R8.6). */
export function subscribeCursor(highestSeq: number): number {
  return Math.max(0, highestSeq);
}

export type ReconnectDecision =
  | { kind: "resubscribe"; sinceSeq: number; attempt: number }
  | { kind: "give-up"; detail: string };

/**
 * Decide the next action after a stream interruption.
 *
 * @param highestSeq highest processed sequence number (resume cursor)
 * @param attempts   number of reconnection attempts already made
 */
export function nextReconnect(
  highestSeq: number,
  attempts: number,
): ReconnectDecision {
  if (attempts >= MAX_RECONNECTS) {
    return { kind: "give-up", detail: STREAM_LOST_DETAIL };
  }
  return {
    kind: "resubscribe",
    sinceSeq: subscribeCursor(highestSeq),
    attempt: attempts + 1,
  };
}
