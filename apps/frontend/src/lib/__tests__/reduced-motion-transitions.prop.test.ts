// Feature: zoc-ai-agent-chat-overhaul, Property 35: Motion uses only defined tokens, neutralized under reduced motion
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  REDUCED_MOTION_MAX_MS,
  REDUCED_MOTION_TRANSITION_CLASS,
  TRANSITIONS,
  type TransitionToken,
  isTransitionClass,
  transitionClass,
} from "../reduced-motion";

const TOKENS: TransitionToken[] = ["row-enter", "row-expand", "state-change"];

describe("transition tokens (Property 35)", () => {
  it("resolves every token to a class in the declared registry", () => {
    fc.assert(
      fc.property(fc.constantFrom(...TOKENS), fc.boolean(), (token, reduced) => {
        const cls = transitionClass(token, reduced);
        expect(isTransitionClass(cls)).toBe(true);
        expect(cls.length).toBeGreaterThan(0);
        // Stable resolution.
        expect(transitionClass(token, reduced)).toBe(cls);
      }),
      { numRuns: 150 },
    );
  });

  it("neutralizes to a single opacity-only class under reduced motion, within the cap", () => {
    fc.assert(
      fc.property(fc.constantFrom(...TOKENS), (token) => {
        expect(transitionClass(token, true)).toBe(REDUCED_MOTION_TRANSITION_CLASS);
      }),
      { numRuns: 100 },
    );
    expect(REDUCED_MOTION_MAX_MS).toBeLessThanOrEqual(100);
    // Every declared movement token has a positive duration.
    for (const token of TOKENS) {
      expect(TRANSITIONS[token].ms).toBeGreaterThan(0);
      expect(TRANSITIONS[token].easing.length).toBeGreaterThan(0);
    }
  });
});
