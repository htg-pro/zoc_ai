/**
 * Structured plan output guards — zoc-agent-chat-rebuild R5.3, R10.1, R10.11, R10.14.
 *
 * Feature: zoc-agent-chat-rebuild, R5.3, R10.1, R10.11, R10.14.
 *
 * The assertion with the most teeth is the retry count: "one retry" is easy to
 * write and easy to drift into zero or three, and neither drift shows up as a
 * failing feature — a zero-retry path just fails more often, and a three-retry
 * path just feels slow.
 */

import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import {
  MAX_PLAN_FILES,
  PlanInvalidError,
  generatePlanWithOneRetry,
  mergePartial,
  planSchema,
  renderableFileCount,
  validatePlan,
  type PartialPlan,
  type PlanDraft,
} from "../plan-output.ts";

const RUNS = { numRuns: 200 } as const;

function validFile(overrides: Record<string, unknown> = {}) {
  return {
    path: "src/index.ts",
    action: "modify" as const,
    sourcePath: null,
    rationale: "Needed by the change.",
    addedLines: 3,
    removedLines: 1,
    hunkCount: 1,
    ...overrides,
  };
}

function validPlan(overrides: Record<string, unknown> = {}): unknown {
  return {
    title: "Apply the change",
    files: [validFile()],
    verificationCommand: "pnpm test",
    ...overrides,
  };
}

describe("plan schema (R10.1)", () => {
  it("accepts a well-formed plan", () => {
    expect(() => validatePlan(validPlan())).not.toThrow();
  });

  it("refuses a plan with no files", () => {
    expect(() => validatePlan(validPlan({ files: [] }))).toThrow(PlanInvalidError);
  });

  it("refuses a plan larger than the reviewable ceiling", () => {
    const files = Array.from({ length: MAX_PLAN_FILES + 1 }, (_unused, index) =>
      validFile({ path: `src/f${index}.ts` }),
    );
    expect(() => validatePlan(validPlan({ files }))).toThrow(PlanInvalidError);
  });

  it("refuses duplicate paths and names the offender", () => {
    const files = [validFile({ path: "src/a.ts" }), validFile({ path: "src/a.ts" })];
    try {
      validatePlan(validPlan({ files }));
      expect.unreachable();
    } catch (cause) {
      expect(cause).toBeInstanceOf(PlanInvalidError);
      const error = cause as PlanInvalidError;
      expect(error.code).toBe("plan_invalid");
      expect(error.detail).toContain("src/a.ts");
    }
  });

  it("requires sourcePath for a rename and forbids it otherwise (R10.14)", () => {
    // A rename without an origin is a delete plus a create with a lost origin.
    expect(() =>
      validatePlan(validPlan({ files: [validFile({ action: "rename", sourcePath: null })] })),
    ).toThrow(PlanInvalidError);

    expect(() =>
      validatePlan(
        validPlan({ files: [validFile({ action: "rename", sourcePath: "src/old.ts" })] }),
      ),
    ).not.toThrow();

    for (const action of ["create", "modify", "delete"] as const) {
      expect(() =>
        validatePlan(validPlan({ files: [validFile({ action, sourcePath: "src/old.ts" })] })),
      ).toThrow(PlanInvalidError);
    }
  });

  it("carries a HunkAction per file, which is what the action slot renders (R10.11)", () => {
    for (const action of ["create", "modify", "delete", "rename"] as const) {
      const file = validFile({
        action,
        sourcePath: action === "rename" ? "src/old.ts" : null,
      });
      const plan = validatePlan(validPlan({ files: [file] })) as PlanDraft;
      expect(plan.files[0]?.action).toBe(action);
    }
  });

  it("refuses a non-object candidate without throwing something untyped", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.string(),
          fc.integer(),
          fc.array(fc.anything()),
        ),
        (candidate) => {
          expect(() => validatePlan(candidate)).toThrow(PlanInvalidError);
        },
      ),
      RUNS,
    );
  });

  it("defaults verificationCommand to null rather than leaving it absent", () => {
    const plan = planSchema.parse({ title: "t", files: [validFile()] });
    expect(plan.verificationCommand).toBeNull();
  });

  it("never puts a value into the validation detail, only a path and expectation", () => {
    const secretish = "sk-proj-CANARY-shouldnotappear01234";
    try {
      validatePlan({ title: secretish.repeat(20), files: [] });
      expect.unreachable();
    } catch (cause) {
      const error = cause as PlanInvalidError;
      expect(error.detail).not.toContain(secretish);
    }
  });
});

describe("exactly one retry, then fail (R5.3)", () => {
  it("does not retry when the first attempt validates", async () => {
    const generate = vi.fn(async () => validPlan());
    await expect(generatePlanWithOneRetry({ generate })).resolves.toMatchObject({
      title: "Apply the change",
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("retries exactly once, with the validation message appended", async () => {
    const seen: Array<string | null> = [];
    const generate = vi.fn(async (extra: string | null) => {
      seen.push(extra);
      return seen.length === 1 ? { title: "broken" } : validPlan();
    });

    await expect(generatePlanWithOneRetry({ generate })).resolves.toBeTruthy();

    expect(generate).toHaveBeenCalledTimes(2);
    expect(seen[0]).toBeNull();
    expect(seen[1]).toContain("did not validate");
    // The specific validation detail is passed through, not a generic nag.
    expect(seen[1]).toContain("files");
  });

  it("fails with plan_invalid after the retry rather than retrying again", async () => {
    const generate = vi.fn(async () => ({ title: "still broken" }));
    await expect(generatePlanWithOneRetry({ generate })).rejects.toBeInstanceOf(PlanInvalidError);
    // Two calls: the attempt and the one retry. Not three.
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("does not swallow a non-validation failure", async () => {
    const generate = vi.fn(async () => {
      throw new Error("provider timed out");
    });
    await expect(generatePlanWithOneRetry({ generate })).rejects.toThrow(/provider timed out/);
    // A transport failure is not a schema failure, so it is not retried here.
    expect(generate).toHaveBeenCalledTimes(1);
  });
});

describe("partial stream merging (R10.1)", () => {
  it("never shrinks the file list as snapshots arrive", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 6 }), { minLength: 1, maxLength: 10 }),
        (counts) => {
          let accumulated: PartialPlan = {};
          let highWater = 0;
          for (const count of counts) {
            accumulated = mergePartial(accumulated, {
              files: Array.from({ length: count }, (_unused, index) => ({
                path: `src/f${index}.ts`,
              })),
            });
            highWater = Math.max(highWater, count);
            // A later snapshot can be shorter in a field it has not reached; the
            // card must not flicker files away.
            expect(accumulated.files?.length ?? 0).toBe(highWater);
          }
        },
      ),
      RUNS,
    );
  });

  it("keeps a title once seen", () => {
    const first = mergePartial({}, { title: "Apply the change" });
    const second = mergePartial(first, { files: [{ path: "a.ts" }] });
    expect(second.title).toBe("Apply the change");
  });

  it("lets an explicit null clear verificationCommand", () => {
    const withCommand = mergePartial({}, { verificationCommand: "pnpm test" });
    expect(mergePartial(withCommand, { verificationCommand: null }).verificationCommand).toBeNull();
  });

  it("counts only files with a resolved path as renderable", () => {
    expect(
      renderableFileCount({ files: [{ path: "a.ts" }, {}, { path: "" }, { path: "b.ts" }] }),
    ).toBe(2);
    expect(renderableFileCount({})).toBe(0);
  });
});
