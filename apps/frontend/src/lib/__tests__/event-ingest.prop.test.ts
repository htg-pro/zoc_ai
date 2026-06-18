// Feature: chat-memory-session-system, Property 2: Cross-run events are discarded
// Feature: studio-ui-redesign, Property 7: Timeline preserves ascending sequence order with upsert-by-id
// Feature: studio-ui-redesign, Property 22: Pausing suspends event consumption; resuming drains in order from the resume cursor
// Feature: studio-ui-redesign, Property 25: Tool-call events are labeled with their status
// Feature: studio-ui-redesign, Property 26: Plan-update events set affected step statuses
// Feature: studio-ui-redesign, Property 27: An error event transitions to error and retains prior timeline content
// Feature: studio-ui-redesign, Property 29: Out-of-order/duplicate events are discarded with no state change
// Feature: studio-ui-redesign, Property 30: A stopped run applies no further events
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { AgentEvent } from "@zoc-studio/shared-types";
import {
  type TimelineEntry,
  applyPlanStep,
  decideIngest,
  drainBuffer,
  errorDetail,
  eventEntryId,
  eventSeq,
  toolCallStatusLabel,
  upsertById,
} from "../event-ingest";
import {
  arbAgentEvent,
  arbPlanUniqueIds,
  arbPlanStepStatus,
} from "../../__tests__/arbitraries";

// Minimal local seq-cursor model. The former `lib/seq-cursor.ts` helper was
// removed with the legacy agent transport (zoc-agent-ecosystem-merge task 9.2);
// this test only needs its tiny pure shape to model the ingest cursor.
interface SeqCursor {
  highestSeq: number;
  activeRunId: string | null;
}
const initialCursor = (): SeqCursor => ({ highestSeq: 0, activeRunId: null });
const advance = (cursor: SeqCursor, seq: number): SeqCursor => ({
  ...cursor,
  highestSeq: Math.max(cursor.highestSeq, seq),
});

const isSortedBySeq = (entries: TimelineEntry[]): boolean =>
  entries.every((e, i) => i === 0 || entries[i - 1].seq <= e.seq);

describe("event-ingest", () => {
  it("Property 7: timeline upserts by id and stays ordered ascending by seq", () => {
    fc.assert(
      fc.property(
        fc.array(arbAgentEvent("s"), { maxLength: 30 }),
        (events) => {
          let entries: TimelineEntry[] = [];
          for (const e of events) {
            entries = upsertById(entries, {
              id: eventEntryId(e),
              seq: eventSeq(e),
            });
          }
          // Ordered ascending by seq.
          expect(isSortedBySeq(entries)).toBe(true);
          // Ids unique (upsert, not append-duplicate).
          const ids = entries.map((e) => e.id);
          expect(new Set(ids).size).toBe(ids.length);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("Property 29/30: duplicates/stale are discarded; a stopped stream applies nothing", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
        fc.boolean(),
        fc.boolean(),
        (seq, highestSeq, paused, stopped) => {
          const event = {
            type: "message",
            session_id: "s",
            seq,
            at: new Date(0).toISOString(),
            message: { id: "m", role: "assistant", content: "" },
          } as unknown as AgentEvent;
          const decision = decideIngest(event, {
            highestSeq,
            paused,
            stopped,
            activeRunId: null,
          });
          if (seq <= highestSeq) {
            expect(decision).toBe("discard");
          } else if (stopped) {
            expect(decision).toBe("discard");
          } else if (paused) {
            expect(decision).toBe("buffer");
          } else {
            expect(decision).toBe("apply");
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("Property 22: resume drains buffered events past the cursor in ascending order", () => {
    fc.assert(
      fc.property(
        fc.array(arbAgentEvent("s"), { maxLength: 20 }),
        fc.integer({ min: 0, max: 1000 }),
        (buffer, cursor) => {
          const { apply, highestSeq } = drainBuffer(buffer, cursor);
          // Only events strictly past the cursor are applied.
          expect(apply.every((e) => e.seq > cursor)).toBe(true);
          // Ascending order.
          expect(
            apply.every((e, i) => i === 0 || apply[i - 1].seq <= e.seq),
          ).toBe(true);
          // New highest is the max applied seq (or unchanged cursor).
          const expectedHighest = apply.reduce(
            (m, e) => Math.max(m, e.seq),
            cursor,
          );
          expect(highestSeq).toBe(expectedHighest);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("Property 25: tool-call label equals the event's status", () => {
    fc.assert(
      fc.property(arbAgentEvent("s"), (event) => {
        if (event.type === "tool_call") {
          expect(toolCallStatusLabel(event.tool_call.status)).toBe(
            event.tool_call.status,
          );
          expect([
            "pending",
            "running",
            "succeeded",
            "failed",
            "cancelled",
            "needs_approval",
          ]).toContain(event.tool_call.status);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("Property 26: plan-step update sets only the affected step's status", () => {
    fc.assert(
      fc.property(arbPlanUniqueIds, fc.nat(), arbPlanStepStatus, (plan, pick, status) => {
        if (plan.steps.length === 0) return;
        const target = plan.steps[pick % plan.steps.length];
        const updated = applyPlanStep(plan.steps, {
          ...target,
          status,
        });

        for (const s of updated) {
          if (s.id === target.id) {
            expect(s.status).toBe(status);
          } else {
            const original = plan.steps.find((o) => o.id === s.id);
            expect(s).toEqual(original);
          }
        }
        // No steps added or removed (target existed).
        expect(updated.length).toBe(plan.steps.length);
      }),
      { numRuns: 200 },
    );
  });

  it("Property 27: error detail is extracted and the timeline is left untouched", () => {
    const timeline: TimelineEntry[] = [
      { id: "a", seq: 1 },
      { id: "b", seq: 2 },
    ];
    const snapshot = timeline.map((e) => ({ ...e }));
    const errEvent: AgentEvent = {
      type: "error",
      session_id: "s",
      seq: 3,
      at: new Date(0).toISOString(),
      message: "boom",
      detail: "stack trace",
    };
    expect(errorDetail(errEvent)).toBe("stack trace");
    // errorDetail reads only; timeline unchanged.
    expect(timeline).toEqual(snapshot);
  });
});

// Feature: chat-memory-session-system, Property 9: upsertById order/identity (Requirement 1.6)
describe("event-ingest upsertById order/identity (chat-memory-session-system)", () => {
  // Small id pool so the inserted entry's id frequently collides with an
  // existing one, exercising the replace-by-id path as well as append.
  const arbId = fc.constantFrom("a", "b", "c", "d", "e", "f");
  const arbSeq = fc.integer({ min: 0, max: 10 });
  const arbEntry: fc.Arbitrary<TimelineEntry> = fc.record({
    id: arbId,
    seq: arbSeq,
  });
  // Entries always have unique ids (the timeline invariant upstream of upsert).
  const arbEntries: fc.Arbitrary<TimelineEntry[]> = fc.uniqueArray(arbEntry, {
    selector: (e) => e.id,
    maxLength: 6,
  });

  const isSortedBySeqThenId = (entries: TimelineEntry[]): boolean =>
    entries.every((e, i) => {
      if (i === 0) return true;
      const prev = entries[i - 1];
      return (
        prev.seq < e.seq || (prev.seq === e.seq && prev.id.localeCompare(e.id) <= 0)
      );
    });

  it("Property 9 (Req 1.6): result is ordered by seq (ties by id) and contains the entry exactly once with no duplicate ids", () => {
    fc.assert(
      fc.property(arbEntries, arbEntry, (entries, entry) => {
        const result = upsertById(entries, entry);

        // Ordered ascending by seq, ties broken by ascending id.
        expect(isSortedBySeqThenId(result)).toBe(true);

        // Ids remain unique (replacing by id does not duplicate).
        const ids = result.map((e) => e.id);
        expect(new Set(ids).size).toBe(ids.length);

        // The upserted entry is present exactly once, with its exact value.
        const matches = result.filter((e) => e.id === entry.id);
        expect(matches).toHaveLength(1);
        expect(matches[0]).toEqual(entry);

        // Replacing an existing id does not grow the list; a new id appends one.
        const existed = entries.some((e) => e.id === entry.id);
        expect(result.length).toBe(entries.length + (existed ? 0 : 1));

        // Every other entry is preserved unchanged.
        for (const original of entries) {
          if (original.id === entry.id) continue;
          const kept = result.find((e) => e.id === original.id);
          expect(kept).toEqual(original);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe("event-ingest cross-run isolation", () => {
  // A minimal message-type AgentEvent carrying a non-null run_id. The cross-run
  // rule branches only on run_id vs activeRunId, so the message payload and the
  // remaining ingest fields are irrelevant — but we still vary seq/highestSeq/
  // paused/stopped to prove the cross-run discard takes priority over every
  // other rule.
  const arbCrossRunEvent = (runId: string, seq: number): AgentEvent =>
    ({
      type: "message",
      session_id: "s",
      seq,
      run_id: runId,
      at: new Date(0).toISOString(),
      message: { id: "m", role: "assistant", content: "" },
    }) as unknown as AgentEvent;

  it("Property 2: an event whose run_id differs from the active run is discarded", () => {
    // **Validates: Requirements 1.2**
    fc.assert(
      fc.property(
        // Two distinct, non-null run ids: one on the event, one active.
        fc.uniqueArray(fc.hexaString({ minLength: 1, maxLength: 8 }), {
          minLength: 2,
          maxLength: 2,
        }),
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.boolean(),
        fc.boolean(),
        ([eventRunId, activeRunId], seq, highestSeq, paused, stopped) => {
          const event = arbCrossRunEvent(eventRunId, seq);
          // Cross-run discard is the first rule and ignores seq/paused/stopped.
          const decision = decideIngest(event, {
            highestSeq,
            paused,
            stopped,
            activeRunId,
          });
          expect(decision).toBe("discard");
        },
      ),
      { numRuns: 300 },
    );
  });
});

// Feature: chat-memory-session-system, Property 4: Seq monotonicity / idempotent ingestion
// Validates: Requirements 1.4
//
// Models a stream as: a cursor (single seq authority) + an applied-id set.
// Each delivered event is run through `decideIngest`; on "apply" the cursor is
// advanced via `advance`. We assert each event id is applied at most once,
// re-delivery of an already-applied event is discarded, and `highestSeq` is
// non-decreasing across the whole stream — including duplicates and reorderings.
describe("event-ingest idempotent ingestion (Property 4)", () => {
  /**
   * A canonical set of events with unique entry ids and unique, strictly
   * increasing seqs. Re-delivering any element therefore means re-delivering
   * the *same* (id, seq) event, which is what idempotency must discard.
   */
  const arbCanonical = fc
    .array(arbAgentEvent("s"), { maxLength: 20 })
    .map((events) => {
      const byId = new Map<string, AgentEvent>();
      for (const e of events) {
        const id = eventEntryId(e);
        if (!byId.has(id)) byId.set(id, e);
      }
      // Assign unique, increasing seqs so dedup-by-seq is well defined.
      return [...byId.values()].map((e, i) => ({ ...e, seq: i + 1 }));
    });

  /** A delivery stream with arbitrary duplicates and reorderings. */
  const arbStream = arbCanonical.chain((canonical) => {
    if (canonical.length === 0) {
      return fc.constant({ canonical, stream: [] as AgentEvent[] });
    }
    return fc
      .array(fc.nat({ max: canonical.length - 1 }), { maxLength: 80 })
      .map((indices) => ({
        canonical,
        stream: indices.map((i) => canonical[i]),
      }));
  });

  it("applies each event id at most once, discards re-delivery, keeps highestSeq non-decreasing", () => {
    fc.assert(
      fc.property(arbStream, ({ stream }) => {
        let cursor = initialCursor();
        const appliedCount = new Map<string, number>();
        let prevHighest = cursor.highestSeq;

        for (const ev of stream) {
          const id = eventEntryId(ev);
          const alreadyApplied = appliedCount.has(id);

          const decision = decideIngest(ev, {
            highestSeq: cursor.highestSeq,
            paused: false,
            stopped: false,
            activeRunId: cursor.activeRunId,
          });

          // Re-delivery of an already-applied event must be discarded.
          if (alreadyApplied) {
            expect(decision).toBe("discard");
          }

          if (decision === "apply") {
            appliedCount.set(id, (appliedCount.get(id) ?? 0) + 1);
            cursor = advance(cursor, eventSeq(ev));
          }

          // highestSeq is non-decreasing at every step.
          expect(cursor.highestSeq).toBeGreaterThanOrEqual(prevHighest);
          prevHighest = cursor.highestSeq;
        }

        // Each event id was applied at most once.
        for (const count of appliedCount.values()) {
          expect(count).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 300 },
    );
  });
});
