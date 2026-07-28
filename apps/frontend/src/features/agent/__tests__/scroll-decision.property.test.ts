// Feature: zoc-ai-agent-chat-overhaul, Property 36: Autoscroll follows the newest row only when the user is at it
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { AUTOSCROLL_THRESHOLD_PX, scrollDecision } from "../scroll-decision";

describe("scrollDecision (Property 36)", () => {
  it("auto-scrolls iff at the newest row and a row arrived; offers jump-to-latest iff not at bottom", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5000 }),
        fc.boolean(),
        fc.integer({ min: 1, max: 500 }),
        (distanceFromBottomPx, newRowArrived, thresholdPx) => {
          const decision = scrollDecision({ distanceFromBottomPx, newRowArrived, thresholdPx });
          const atBottom = distanceFromBottomPx <= thresholdPx;
          expect(decision.autoScroll).toBe(atBottom && newRowArrived);
          expect(decision.showJumpToLatest).toBe(!atBottom);
          // Autoscroll and jump-to-latest are never both true.
          expect(decision.autoScroll && decision.showJumpToLatest).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("uses a 48px default threshold", () => {
    expect(AUTOSCROLL_THRESHOLD_PX).toBe(48);
    expect(scrollDecision({ distanceFromBottomPx: 48, newRowArrived: true }).autoScroll).toBe(true);
    expect(scrollDecision({ distanceFromBottomPx: 49, newRowArrived: true }).autoScroll).toBe(false);
  });
});
