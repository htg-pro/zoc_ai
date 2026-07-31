/**
 * Property 23: A partial failure names exactly what was applied. R16.7, R10.5, R10.7, R10.15.
 *
 * *For any* apply outcome — any subset of the plan's files written, with or without a failure, with or
 * without a checkpoint — the receipt names exactly the paths that were written, in the order they were
 * written, and offers rollback exactly when a checkpoint exists to roll back to.
 *
 * ## Why "exactly" is the whole property
 *
 * The failure this rules out is the one a user cannot recover from: a Run that dies half way through an
 * apply and reports either the *plan* (so the user believes files were written that were not) or nothing
 * (so the user has no idea what state the workspace is in). Both are plausible implementations — the
 * first falls out of rendering the accepted set, which is what the card already has in hand — and both
 * leave the user guessing. So the receipt is built from the outcome's own path list and never from the
 * selection, and the property fixes that by construction.
 *
 * ## Why the rollback phrasing is asserted rather than left to the card
 *
 * R10.15 exists because rolling back a `create` *removes* a file. A control that says "restore 4 files"
 * over a checkpoint containing a create is telling the user something false about what the button does,
 * so the per-action phrase is part of the claim: a create says remove, a delete says restore, a rename
 * names both ends.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  applyReceiptOf,
  rollbackPhraseOf,
  rollbackReport,
  type ApplyOutcome,
} from "@/features/chat/review/apply-receipt";
import type { HunkAction, PlanPart } from "@zoc-studio/shared-types";

const RUNS = { numRuns: 200 } as const;

const action: fc.Arbitrary<HunkAction> = fc.constantFrom("create", "modify", "delete", "rename");

/** A plan over 1–8 files with distinct paths, each carrying one of the four actions. */
const plan: fc.Arbitrary<PlanPart> = fc
  .uniqueArray(fc.tuple(fc.hexaString({ minLength: 3, maxLength: 8 }), action), {
    selector: ([name]) => name,
    minLength: 1,
    maxLength: 8,
  })
  .map((entries) => ({
    type: "plan",
    seq: 1,
    runId: "run_1",
    messageId: "msg_1",
    ts: "2026-07-31T10:00:00.000Z",
    agentName: null,
    planId: "plan_1",
    title: "A plan",
    files: entries.map(([name, fileAction]) => ({
      path: `src/${name}.ts`,
      action: fileAction,
      sourcePath: fileAction === "rename" ? `src/old-${name}.ts` : null,
      rationale: "why this file is touched",
      addedLines: 3,
      removedLines: 1,
      hunkCount: 1,
    })),
    verificationCommand: null,
  }));

/** An outcome over a prefix of the plan's files: apply writes in order and stops where it stops. */
const outcomeFor = (subject: PlanPart): fc.Arbitrary<ApplyOutcome> =>
  fc.tuple(
    fc.integer({ min: 0, max: subject.files.length }),
    fc.option(fc.constant({ code: "tool_failed", message: "The apply failed part-way." }), {
      nil: null,
    }),
    fc.option(fc.hexaString({ minLength: 6, maxLength: 10 }), { nil: null }),
  ).map(([written, error, checkpoint]) => ({
    checkpointId: checkpoint === null ? null : `ckpt_${checkpoint}`,
    appliedPaths: subject.files.slice(0, written).map((file) => file.path),
    error,
  }));

describe("Feature: zoc-agent-chat-rebuild, Property 23: a partial failure names exactly what was applied", () => {
  it("names exactly the written paths, in apply order (R16.7)", () => {
    fc.assert(
      fc.property(
        plan.chain((subject) => fc.tuple(fc.constant(subject), outcomeFor(subject))),
        ([subject, outcome]) => {
          const receipt = applyReceiptOf(subject, outcome);
          expect(receipt.files.map((file) => file.path)).toEqual([...outcome.appliedPaths]);
        },
      ),
      RUNS,
    );
  });

  it("marks a partial apply exactly when a failure followed some writes", () => {
    fc.assert(
      fc.property(
        plan.chain((subject) => fc.tuple(fc.constant(subject), outcomeFor(subject))),
        ([subject, outcome]) => {
          const receipt = applyReceiptOf(subject, outcome);
          const failed = outcome.error !== null && outcome.error !== undefined;
          expect(receipt.partial).toBe(failed && outcome.appliedPaths.length > 0);
          // A failure always has a sentence, and a clean apply never invents one.
          expect(receipt.failure === null).toBe(!failed);
        },
      ),
      RUNS,
    );
  });

  it("offers rollback exactly when a checkpoint covers at least one written file (R10.5)", () => {
    fc.assert(
      fc.property(
        plan.chain((subject) => fc.tuple(fc.constant(subject), outcomeFor(subject))),
        ([subject, outcome]) => {
          const receipt = applyReceiptOf(subject, outcome);
          expect(receipt.rollbackable).toBe(
            outcome.checkpointId !== null && outcome.appliedPaths.length > 0,
          );
          expect(receipt.checkpointId).toBe(outcome.checkpointId);
        },
      ),
      RUNS,
    );
  });

  it("gives every named file its own rollback phrase, per action (R10.15)", () => {
    fc.assert(
      fc.property(
        plan.chain((subject) => fc.tuple(fc.constant(subject), outcomeFor(subject))),
        ([subject, outcome]) => {
          const receipt = applyReceiptOf(subject, outcome);
          expect(receipt.rollbackActions.length).toBe(receipt.files.length);

          for (const [index, file] of receipt.files.entries()) {
            const phrase = receipt.rollbackActions[index] ?? "";
            expect(phrase).toContain(file.path);
            switch (file.action) {
              case "create":
                expect(phrase).toContain("remove");
                break;
              case "delete":
                expect(phrase).toContain("restore");
                break;
              case "rename":
                // Both ends, so a reviewer knows where the file goes back to (R10.14).
                expect(phrase).toContain(file.sourcePath ?? "original path");
                break;
              case "modify":
                expect(phrase).toContain("revert");
                break;
              default:
                expect(phrase).toContain("revert");
            }
          }
        },
      ),
      RUNS,
    );
  });

  it("names a path the plan never declared rather than dropping it", () => {
    fc.assert(
      fc.property(plan, (subject) => {
        // An upstream bug — Workspace_Services reporting a write the plan did not ask for. The receipt
        // still names it, because R16.7 asks what was *written*, and a file the user cannot see is the
        // one thing worse than a file they did not expect.
        const receipt = applyReceiptOf(subject, {
          checkpointId: "ckpt_x",
          appliedPaths: ["src/unexpected.ts"],
          error: null,
        });
        expect(receipt.files).toEqual([{ path: "src/unexpected.ts" }]);
        expect(receipt.rollbackActions[0]).toContain("src/unexpected.ts");
      }),
      { numRuns: 50 },
    );
  });

  it("reports the restored count and the checkpoint id on the way back out (R10.7)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 40 }),
        fc.hexaString({ minLength: 4, maxLength: 8 }),
        (restoredCount, id) => {
          const sentence = rollbackReport({ checkpointId: `ckpt_${id}`, restoredCount });
          expect(sentence).toContain(`ckpt_${id}`);
          expect(sentence).toContain(String(restoredCount));
        },
      ),
      RUNS,
    );
  });

  it("phrases a file with no declared action without claiming one", () => {
    expect(rollbackPhraseOf({ path: "src/a.ts" })).toBe("revert src/a.ts");
  });
});
