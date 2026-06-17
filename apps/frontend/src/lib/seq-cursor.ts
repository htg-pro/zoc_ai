/**
 * Single per-session sequence-cursor authority (R1.4, R1.5).
 *
 * Replaces the three independent seq trackers (`RunState.highestSeq`,
 * `IngestState.highestSeq`, and `agent-client`'s `lastSeq` map) with one
 * authority so ingestion, the run machine, and the SSE resubscribe cursor
 * never disagree.
 *
 * The seq floor is monotonic and is **preserved across run starts** — the bug
 * this fixes is the run reducer resetting `highestSeq` to 0 while the client's
 * `lastSeq` map keeps the old value, which makes stale low-seq events look new.
 */

export interface SeqCursor {
  /** Highest seq durably processed for the session (monotonic, never resets). */
  highestSeq: number;
  /** The active backend run id; events from other runs are stale. */
  activeRunId: string | null;
}

/** The initial cursor for a session: nothing processed, no active run. */
export function initialCursor(): SeqCursor {
  return { highestSeq: 0, activeRunId: null };
}

/**
 * On run start: adopt the new run id; the seq floor is **preserved, never
 * reset to 0** (R1.5).
 */
export function onRunStart(cursor: SeqCursor, runId: string): SeqCursor {
  return { highestSeq: cursor.highestSeq, activeRunId: runId };
}

/**
 * Advance after applying an event; monotonic non-decreasing (R1.4).
 * `activeRunId` is unchanged.
 */
export function advance(cursor: SeqCursor, seq: number): SeqCursor {
  return { ...cursor, highestSeq: Math.max(cursor.highestSeq, seq) };
}

/** The `since_seq` cursor for a (re)subscription (mirrors `reconnect.ts`). */
export function subscribeCursor(cursor: SeqCursor): number {
  return Math.max(0, cursor.highestSeq);
}
