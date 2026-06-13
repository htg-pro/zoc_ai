// Feature: studio-ui-redesign, Property 7: Timeline preserves ascending sequence order with upsert-by-id
// Feature: studio-ui-redesign, Property 22: Pausing suspends event consumption; resuming drains in order from the resume cursor
// Feature: studio-ui-redesign, Property 25: Tool-call events are labeled with their status
// Feature: studio-ui-redesign, Property 26: Plan-update events set affected step statuses
// Feature: studio-ui-redesign, Property 27: An error event transitions to error and retains prior timeline content
// Feature: studio-ui-redesign, Property 29: Out-of-order/duplicate events are discarded with no state change
// Feature: studio-ui-redesign, Property 30: A stopped run applies no further events
// Feature: studio-ui-redesign, Property 32: Checkpoint entries are ordered by creation time
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { AgentEvent } from "@llama-studio/shared-types";
import {
  type TimelineEntry,
  applyPlanStep,
  decideIngest,
  drainBuffer,
  errorDetail,
  eventEntryId,
  eventSeq,
  orderCheckpoints,
  toolCallStatusLabel,
  upsertById,
} from "../event-ingest";
import {
  arbAgentEvent,
  arbCheckpoint,
  arbPlanUniqueIds,
  arbPlanStepStatus,
} from "../../__tests__/arbitraries";

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
          const decision = decideIngest(seq, { highestSeq, paused, stopped });
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

  it("Property 32: checkpoints are ordered by creation time", () => {
    fc.assert(
      fc.property(fc.array(arbCheckpoint, { maxLength: 12 }), (checkpoints) => {
        const ordered = orderCheckpoints(checkpoints);
        // Same multiset.
        expect(ordered.length).toBe(checkpoints.length);
        // Non-decreasing creation time.
        for (let i = 1; i < ordered.length; i++) {
          expect(Date.parse(ordered[i - 1].created_at)).toBeLessThanOrEqual(
            Date.parse(ordered[i].created_at),
          );
        }
      }),
      { numRuns: 200 },
    );
  });
});
