// Feature: zoc-agent-ecosystem-merge, Property 1: Feed is append-only and seq-ordered
//
// For any sequence of contract events (including duplicates and out-of-order
// arrivals), folding them through `mergeEventBySeq` / `mergeEvents` yields a
// feed whose entries are strictly ascending by `seq`, contain each `seq` at
// most once, and in which merging a new event never mutates or replaces any
// previously present entry.
//
// Validates: Requirements 3.4
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import type { AgentEvent } from "@zoc-studio/shared-types";

import { mergeEventBySeq, mergeEvents } from "./useAgentStream";

/**
 * Arbitrary producing a valid `AgentEvent` for a given `seq`. A monotonic
 * `nonce` is folded into the type-specific payload so two events that share a
 * `seq` are nonetheless distinct objects — this lets the test detect any
 * mutation or replacement of an already-present entry.
 */
function arbEvent(seq: number, nonce: number): fc.Arbitrary<AgentEvent> {
  const runId = `run-${nonce % 3}`;
  const ts = new Date(1_700_000_000_000 + nonce).toISOString();
  const base = { seq, runId, ts } as const;

  return fc.oneof(
    fc.record({ text: fc.string() }).map(
      (r): AgentEvent => ({
        ...base,
        type: "intent",
        text: `${r.text}#${nonce}`,
        modelTier: "local-slm",
        contextWindowTokens: nonce,
      }),
    ),
    fc.record({ text: fc.string() }).map(
      (r): AgentEvent => ({ ...base, type: "thinking", text: `${r.text}#${nonce}`, collapsible: true }),
    ),
    fc.record({ path: fc.string() }).map(
      (r): AgentEvent => ({ ...base, type: "read-files", files: [{ path: `${r.path}#${nonce}` }] }),
    ),
    fc.record({ path: fc.string(), diff: fc.string() }).map(
      (r): AgentEvent => ({ ...base, type: "edit-file", path: `${r.path}#${nonce}`, diff: r.diff }),
    ),
    fc.record({ command: fc.string() }).map(
      (r): AgentEvent => ({ ...base, type: "command", command: `${r.command}#${nonce}` }),
    ),
    fc.record({ text: fc.string() }).map(
      (r): AgentEvent => ({ ...base, type: "summary", text: `${r.text}#${nonce}` }),
    ),
    fc.record({ prompt: fc.string() }).map(
      (r): AgentEvent => ({ ...base, type: "approval", prompt: `${r.prompt}#${nonce}` }),
    ),
    fc.boolean().map((ok): AgentEvent => ({ ...base, type: "done", ok, reason: `r#${nonce}` })),
  );
}

/** A sequence of events with small `seq` values so duplicates are common, in
 *  arbitrary (shuffled / out-of-order) arrival order. */
const arbEventSequence: fc.Arbitrary<AgentEvent[]> = fc
  .array(
    fc.record({ seq: fc.integer({ min: 0, max: 8 }), nonce: fc.integer({ min: 0, max: 1_000_000 }) }),
    { maxLength: 40 },
  )
  .chain((specs) =>
    fc.tuple(...specs.map((s, i) => arbEvent(s.seq, s.nonce * 41 + i))),
  )
  .map((events) => [...events]);

describe("Property 1: Feed is append-only and seq-ordered", () => {
  it("yields a strictly seq-ascending, deduplicated, append-only feed for any arrival order", () => {
    fc.assert(
      fc.property(arbEventSequence, (incoming) => {
        let feed: AgentEvent[] = [];

        for (const ev of incoming) {
          // Snapshot the entries present before this merge, keyed by seq.
          const before = new Map(feed.map((e) => [e.seq, e]));

          feed = mergeEventBySeq(feed, ev);

          // (a) strictly ascending by seq
          for (let i = 1; i < feed.length; i++) {
            expect(feed[i].seq).toBeGreaterThan(feed[i - 1].seq);
          }

          // (b) each seq at most once
          const seqs = feed.map((e) => e.seq);
          expect(new Set(seqs).size).toBe(seqs.length);

          // (c) never mutates/replaces a previously present entry: every seq
          //     that already existed maps to the exact same object reference.
          for (const [seq, prevEntry] of before) {
            const current = feed.find((e) => e.seq === seq);
            expect(current).toBe(prevEntry);
          }
        }

        // mergeEvents (batch fold) agrees with the incremental fold.
        const batched = mergeEvents([], incoming);
        expect(batched.map((e) => e.seq)).toEqual(feed.map((e) => e.seq));
      }),
      { numRuns: 200 },
    );
  });
});
