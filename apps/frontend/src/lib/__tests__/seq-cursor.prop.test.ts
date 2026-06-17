// Feature: chat-memory-session-system — seq-cursor property tests
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { advance, initialCursor, type SeqCursor } from "../seq-cursor";

// Task 2.3 — Property 4 (seq monotonicity portion): `advance` is monotonic non-decreasing.
// **Validates: Requirements 1.4**
describe("seq-cursor advance monotonicity (Property 4 — seq monotonicity)", () => {
  // A finite integer seq generator (seqs are positive integers per the model,
  // but advance must be safe for any integer input including zero/negatives).
  const seqArb = fc.integer({ min: -1000, max: 1_000_000 });
  const cursorArb = fc.record({
    highestSeq: fc.integer({ min: 0, max: 1_000_000 }),
    activeRunId: fc.option(fc.hexaString({ minLength: 1, maxLength: 16 }), {
      nil: null,
    }),
  });

  it("advance(c, seq).highestSeq === Math.max(c.highestSeq, seq)", () => {
    fc.assert(
      fc.property(cursorArb, seqArb, (cursor, seq) => {
        const next = advance(cursor, seq);
        expect(next.highestSeq).toBe(Math.max(cursor.highestSeq, seq));
      }),
      { numRuns: 500 },
    );
  });

  it("advance never lowers highestSeq and leaves activeRunId unchanged", () => {
    fc.assert(
      fc.property(cursorArb, seqArb, (cursor, seq) => {
        const next = advance(cursor, seq);
        expect(next.highestSeq).toBeGreaterThanOrEqual(cursor.highestSeq);
        expect(next.activeRunId).toBe(cursor.activeRunId);
      }),
      { numRuns: 500 },
    );
  });

  it("folding any permutation of a seq multiset yields the same final highestSeq", () => {
    fc.assert(
      fc.property(
        cursorArb,
        fc.array(seqArb, { minLength: 0, maxLength: 50 }),
        (cursor, seqs) => {
          const fold = (order: number[]): SeqCursor =>
            order.reduce((c, s) => advance(c, s), cursor);

          const inOrder = fold(seqs);
          const reversed = fold([...seqs].reverse());
          const sorted = fold([...seqs].sort((a, b) => a - b));

          // The final highestSeq is order-independent: it is the max of the
          // starting floor and every applied seq.
          const expected =
            seqs.length === 0
              ? cursor.highestSeq
              : Math.max(cursor.highestSeq, ...seqs);

          expect(inOrder.highestSeq).toBe(expected);
          expect(reversed.highestSeq).toBe(expected);
          expect(sorted.highestSeq).toBe(expected);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("a shuffled permutation produces the same final highestSeq (explicit generator)", () => {
    fc.assert(
      fc.property(
        fc.array(seqArb, { minLength: 1, maxLength: 50 }).chain((seqs) =>
          fc.tuple(fc.constant(seqs), fc.shuffledSubarray(seqs, {
            minLength: seqs.length,
            maxLength: seqs.length,
          })),
        ),
        ([seqs, permuted]) => {
          const base = initialCursor();
          const a = seqs.reduce((c, s) => advance(c, s), base);
          const b = permuted.reduce((c, s) => advance(c, s), base);
          expect(a.highestSeq).toBe(b.highestSeq);
        },
      ),
      { numRuns: 300 },
    );
  });
});
