// Feature: studio-ui-redesign, Property 8: Plan progress math is correct and bounded
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { completedCount, planProgress, todoProgress } from "../plan-progress";
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

  it("todoProgress counts only `completed` and clamps ratio to [0,1] (R9.1/R9.6)", () => {
    const arbTodo = fc.record({
      id: fc.string({ maxLength: 6 }),
      content: fc.string({ maxLength: 12 }),
      status: fc.constantFrom("pending", "in_progress", "completed"),
    });
    fc.assert(
      fc.property(fc.array(arbTodo, { maxLength: 30 }), (todos) => {
        const { done, total, ratio } = todoProgress(todos as never);
        const expectedDone = todos.filter((t) => t.status === "completed").length;
        expect(done).toBe(expectedDone);
        expect(total).toBe(todos.length);
        expect(ratio).toBeGreaterThanOrEqual(0);
        expect(ratio).toBeLessThanOrEqual(1);
        if (total > 0) expect(ratio).toBeCloseTo(done / total, 10);
        else expect(ratio).toBe(0);
      }),
      { numRuns: 200 },
    );
  });

  it("todoProgress null / empty → 0% and 0 completed", () => {
    expect(todoProgress(null)).toEqual({ done: 0, total: 0, ratio: 0 });
    expect(todoProgress([])).toEqual({ done: 0, total: 0, ratio: 0 });
  });
});
