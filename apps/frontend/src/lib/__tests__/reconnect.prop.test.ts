// Feature: studio-ui-redesign, Property 28: Subscription and reconnection always request events after the highest processed sequence
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  MAX_RECONNECTS,
  nextReconnect,
  subscribeCursor,
} from "../reconnect";

describe("reconnect (Property 28)", () => {
  it("a (re)subscription requests since_seq = highest processed seq", () => {
    fc.assert(
      fc.property(fc.nat({ max: 100_000 }), (highestSeq) => {
        expect(subscribeCursor(highestSeq)).toBe(highestSeq);
        const d = nextReconnect(highestSeq, 0);
        expect(d.kind).toBe("resubscribe");
        if (d.kind === "resubscribe") {
          expect(d.sinceSeq).toBe(highestSeq);
          expect(d.attempt).toBe(1);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("reconnection is bounded to five attempts, then gives up", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 100_000 }),
        fc.integer({ min: 0, max: 20 }),
        (highestSeq, attempts) => {
          const d = nextReconnect(highestSeq, attempts);
          if (attempts >= MAX_RECONNECTS) {
            expect(d.kind).toBe("give-up");
          } else {
            expect(d.kind).toBe("resubscribe");
            if (d.kind === "resubscribe") {
              expect(d.sinceSeq).toBe(highestSeq);
              expect(d.attempt).toBe(attempts + 1);
              expect(d.attempt).toBeLessThanOrEqual(MAX_RECONNECTS);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("simulated loop: at most 5 resubscribes before give-up", () => {
    let attempts = 0;
    let resubscribes = 0;
    for (let i = 0; i < 50; i++) {
      const d = nextReconnect(10, attempts);
      if (d.kind === "give-up") break;
      resubscribes += 1;
      attempts = d.attempt;
    }
    expect(resubscribes).toBe(MAX_RECONNECTS);
  });
});
