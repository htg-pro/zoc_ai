// Feature: studio-ui-redesign, Property 18: Reduced-motion selects the static variant for every motion token
// Feature: studio-ui-redesign, Property 19: Static state indicators are pairwise distinct
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  type MotionToken,
  type RunCueState,
  isAnimatedClass,
  motionClass,
  staticStateCue,
} from "../reduced-motion";

const TOKENS: MotionToken[] = [
  "pulse-dot",
  "orb-glow",
  "shimmer",
  "caret-blink",
  "typing-dot",
  "fade-row",
  "spinner",
  "progress-bar",
];

const STATES: RunCueState[] = ["active", "complete", "error"];

describe("reduced-motion", () => {
  it("Property 18: reduced-motion yields the static (non-looping) variant; otherwise animated", () => {
    fc.assert(
      fc.property(fc.constantFrom(...TOKENS), fc.boolean(), (token, reduced) => {
        const cls = motionClass(token, reduced);
        if (reduced) {
          expect(isAnimatedClass(cls)).toBe(false);
        } else {
          expect(isAnimatedClass(cls)).toBe(true);
        }
        // Resolution is total and stable.
        expect(cls).toBe(motionClass(token, reduced));
        expect(cls.length).toBeGreaterThan(0);
      }),
      { numRuns: 200 },
    );
  });

  it("Property 19: any two distinct states produce distinct static cues (icon + color)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...STATES),
        fc.constantFrom(...STATES),
        (a, b) => {
          const ca = staticStateCue(a);
          const cb = staticStateCue(b);
          if (a === b) {
            expect(ca).toEqual(cb);
          } else {
            // Distinguishable without motion: icon and color cue both differ.
            expect(ca.icon).not.toBe(cb.icon);
            expect(ca.colorVar).not.toBe(cb.colorVar);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
