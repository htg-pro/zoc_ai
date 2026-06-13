// Feature: studio-ui-redesign, Property 8: Plan progress math is correct and bounded
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { completedCount, planProgress } from "../plan-progress";
import { arbPlan } from "../../__tests__/arbitraries";

describe("plan-progress (Property 8)", () => {
  it("reports done = count(done), total = steps, ratio = done/total clamped to [0,1]", () => {
    fc.assert(
      fc.property(arbPlan, (plan) => {
        const { done, total, ratio } = planProgress(plan);
        const expectedDone = plan.steps.filter((s) => s.status === "done").length;

        expect(done).toBe(expectedDone);
        expect(total).toBe(plan.steps.length);
        expect(ratio).toBeGreaterThanOrEqual(0);
        expect(ratio).toBeLessThanOrEqual(1);

        if (total > 0) {
          expect(ratio).toBeCloseTo(done / total, 10);
        } else {
          expect(ratio).toBe(0);
          expect(done).toBe(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("ratio = 1 and done = total when every step is done", () => {
    fc.assert(
      fc.property(arbPlan, (plan) => {
        const allDone = {
          ...plan,
          steps: plan.steps.map((s) => ({ ...s, status: "done" as const })),
        };
        const { done, total, ratio } = planProgress(allDone);
        if (total > 0) {
          expect(done).toBe(total);
          expect(ratio).toBe(1);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("null / empty plan → 0% and 0 completed (R9.6)", () => {
    expect(planProgress(null)).toEqual({ done: 0, total: 0, ratio: 0 });
    expect(completedCount([])).toBe(0);
  });
});
