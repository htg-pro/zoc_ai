// Feature: zoc-ai-agent-chat-overhaul, Property 41: Follow-up chips are bounded, derived, and scoped to the latest run
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { MAX_FOLLOW_UPS, deriveFollowUps } from "../follow-ups";
import type { RunPhase } from "../run-lifecycle";
import { REPORTED_STAGES, type ReportedStage } from "../stage-report";

const PHASES: RunPhase[] = [
  "starting",
  "running",
  "paused",
  "stalled",
  "reconnecting",
  "interrupted",
  "stopping",
  "cancelled",
  "done",
  "failed",
];

describe("deriveFollowUps (Property 41)", () => {
  it("derives between zero and three chips, each with non-empty prompt text, deterministically", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PHASES),
        fc.nat({ max: 20 }),
        fc.option(fc.constantFrom<ReportedStage>(...REPORTED_STAGES), { nil: null }),
        fc.boolean(),
        (outcome, filesChanged, failedStage, checksFailed) => {
          const summary = { outcome, filesChanged, failedStage, checksFailed };
          const chips = deriveFollowUps(summary);
          expect(chips.length).toBeLessThanOrEqual(MAX_FOLLOW_UPS);
          expect(chips.length).toBeGreaterThanOrEqual(0);
          for (const chip of chips) {
            expect(chip.prompt.trim().length).toBeGreaterThan(0);
            expect(chip.label.trim().length).toBeGreaterThan(0);
          }
          // Deterministic and unique ids.
          const again = deriveFollowUps(summary);
          expect(again.map((c) => c.id)).toEqual(chips.map((c) => c.id));
          expect(new Set(chips.map((c) => c.id)).size).toBe(chips.length);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("produces no chips for a non-terminal outcome", () => {
    for (const outcome of ["starting", "running", "paused", "stalled", "reconnecting", "stopping"] as RunPhase[]) {
      expect(
        deriveFollowUps({ outcome, filesChanged: 3, failedStage: null, checksFailed: false }),
      ).toEqual([]);
    }
  });
});
