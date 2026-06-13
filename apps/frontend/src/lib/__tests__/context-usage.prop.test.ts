// Feature: studio-ui-redesign, Property 12: Context-usage warning threshold
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { CONTEXT_WARNING_THRESHOLD, contextUsage } from "../context-usage";

describe("context-usage (Property 12)", () => {
  it("reports ratio consumed/limit and warns iff ratio >= 0.9", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (consumed, limit) => {
          const u = contextUsage(consumed, limit);
          const rawRatio = consumed / limit;

          expect(u.ratio).toBeGreaterThanOrEqual(0);
          expect(u.ratio).toBeLessThanOrEqual(1);
          expect(u.percent).toBeGreaterThanOrEqual(0);
          expect(u.percent).toBeLessThanOrEqual(100);

          expect(u.ratio).toBeCloseTo(Math.min(1, rawRatio), 10);
          expect(u.warning).toBe(rawRatio >= CONTEXT_WARNING_THRESHOLD);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("non-positive limit yields zero ratio and no warning", () => {
    expect(contextUsage(100, 0)).toMatchObject({ ratio: 0, warning: false });
    expect(contextUsage(0, 0)).toMatchObject({ ratio: 0, warning: false });
  });

  it("boundary at exactly 90% warns", () => {
    expect(contextUsage(90, 100).warning).toBe(true);
    expect(contextUsage(89, 100).warning).toBe(false);
  });
});
