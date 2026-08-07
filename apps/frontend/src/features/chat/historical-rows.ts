/**
 * Historical legacy events, reduced to rows — zoc-agent-chat-rebuild R23.2, task 16.3.
 *
 * Feature: zoc-agent-chat-rebuild, task 16.3 (R23.2).
 *
 * A pre-upgrade conversation is a `Message` plus a set of rows from the legacy 43-type
 * `AgentEvent` contract. Most of those map onto a Message_Part; the ones that were user-facing and
 * have no counterpart become a *historical* row instead of failing, which is R23.2's whole point.
 * {@link ./HistoricalRow} draws one; this module decides how many there are.
 *
 * ## The event shape lives here rather than in the generated types, and that is temporary
 *
 * There is no `HistoricalPart` on the wire and there should not be: nothing the Agent_Runtime
 * produces is historical, so the union would carry a member no producer can ever emit. The legacy
 * reader (24.1) is what constructs these, from records it read out of the retained session tables.
 * {@link HistoricalEvent} is therefore the reader's *output* contract, declared here because the
 * row and its collapsing rule need it first.
 *
 * ## Why `stage` collapses and nothing else does
 *
 * The legacy FSM emitted a `stage` event per transition, so a single long Run left a dozen rows
 * saying nothing a reader can act on — the Python FSM is not the agent any more, and a tool loop
 * has steps rather than stages. Collapsing consecutive ones to a single row per Run keeps the
 * record without letting the highest-volume event kind bury the rest of the transcript.
 *
 * **Two words in that rule are load-bearing.** *Consecutive*, because a `stage` between two test
 * results is part of that ordering and merging non-adjacent ones would destroy it. And *per Run*,
 * because two Runs' stage progressions are two separate things: a run boundary breaks the
 * collapse even when the events are adjacent in the list.
 */

/**
 * One legacy event with no Message_Part equivalent, as the migration reader (24.1) produces it.
 */
export interface HistoricalEvent {
  /** Stable across re-renders, so a virtualised row keeps its measurement. */
  readonly id: string;
  readonly runId: string;
  /** The reader's re-numbered sequence, so a migrated Session satisfies the same invariant. */
  readonly seq: number;
  /** The legacy event's own `type` — `stage`, `review`, `test-results`, and so on. */
  readonly kind: string;
  /** What the row says: `Stage: ANALYZE`, `Test results`, `Run summary`. */
  readonly label: string;
  readonly ts: string;
  /** The original record, rendered verbatim on expand. Preserved rather than interpreted. */
  readonly raw: unknown;
  /** The pre-migration sequence number, retained for forensics. */
  readonly originalSeq?: number;
}

/** The one legacy kind volumous enough to collapse. */
export const COLLAPSED_KIND = "stage";

/** Either one historical event, or a Run's consecutive `stage` events as a single row. */
export type HistoricalItem =
  | { readonly kind: "event"; readonly event: HistoricalEvent }
  | {
      readonly kind: "stage-run";
      readonly runId: string;
      /** The last stage reached, which is the one worth showing. */
      readonly latest: HistoricalEvent;
      readonly members: readonly HistoricalEvent[];
    };

/**
 * Collapse consecutive same-Run `stage` events into one row each (R23.2).
 *
 * Order is the caller's and is never changed: the reader has already sorted by timestamp then
 * original sequence, and re-sorting here would give two modules an opinion about transcript order.
 *
 * A run of exactly one stays an ordinary event rather than becoming a one-member group. Both
 * render as one row, and the group form carries a count — `1 ×` is a count nobody needs and a
 * badge that makes a single event look like a summary of several.
 */
export function collapseHistorical(events: readonly HistoricalEvent[]): readonly HistoricalItem[] {
  const items: HistoricalItem[] = [];
  let index = 0;

  while (index < events.length) {
    const first = events[index] as HistoricalEvent;
    if (first.kind !== COLLAPSED_KIND) {
      items.push({ kind: "event", event: first });
      index += 1;
      continue;
    }

    let end = index + 1;
    while (
      end < events.length &&
      events[end]?.kind === COLLAPSED_KIND &&
      events[end]?.runId === first.runId
    ) {
      end += 1;
    }

    const run = events.slice(index, end);
    if (run.length === 1) {
      items.push({ kind: "event", event: first });
    } else {
      items.push({
        kind: "stage-run",
        runId: first.runId,
        latest: run[run.length - 1] as HistoricalEvent,
        members: run,
      });
    }
    index = end;
  }

  return items;
}

/**
 * The timestamp as the row shows it — local time of day, no date.
 *
 * A historical row sits in transcript position, so the date is already implied by what surrounds
 * it, and a full ISO string in a muted line is the widest thing on it. An unparseable timestamp
 * yields the empty string rather than `Invalid Date`: a legacy record with a broken `ts` should
 * lose its timestamp, not its row.
 */
export function formatHistoricalTime(ts: string): string {
  const parsed = new Date(ts);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * The raw record as the expanded row shows it.
 *
 * Pretty-printed JSON, and a value that cannot be serialised — a cycle, a `BigInt` — falls back to
 * `String(value)` rather than throwing. A migration row exists because something was already
 * unrecognisable; failing to render it would be the failure R23.2 is written to prevent.
 */
export function formatHistoricalRaw(raw: unknown): string {
  try {
    return JSON.stringify(raw, null, 2) ?? String(raw);
  } catch {
    return String(raw);
  }
}
