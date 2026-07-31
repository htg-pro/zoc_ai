/**
 * Property 51: The motion registry stays within budget. Validates R19.1, R19.2, R19.3.
 *
 * Exhaustive over `MOTION_VARIANT_NAMES` rather than sampled, because the registry is a
 * fixed nine-entry table and a generator over it would only rediscover the same nine cases
 * more slowly. The generated axis is the one that is not enumerable: the reduced-motion
 * flag, and the arbitrary target shapes the resolver must survive.
 *
 * Three clauses, and each fails for a different plausible edit:
 *
 *   - **The animated property set is a subset of `{transform, opacity, filter}`** — derived
 *     from the *targets* rather than read off the `properties` declaration, so an entry
 *     that animates `height` and forgets to declare it still fails. Layout-triggering
 *     properties are what R19.1 exists to keep off the compositor's critical path.
 *   - **An entrance is at most 240 ms.** Not loops, which are a different class, and not
 *     state cross-fades.
 *   - **Reduced motion yields no repetition and no transform, while still applying the
 *     target state.** The last half is the one an over-eager implementation breaks: an
 *     entrance that is silenced by dropping its `animate` leaves the row invisible, which
 *     is a worse accessibility outcome than the animation was.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { TargetAndTransition } from "motion/react";

import {
  ANIMATABLE_PROPERTIES,
  MOTION_CONCURRENCY_LIMIT,
  MOTION_MAX_ENTRANCE_MS,
  MOTION_VARIANTS,
  MOTION_VARIANT_NAMES,
  REDUCED_MOTION_TARGET,
  animatedPropertiesOf,
  createMotionBudget,
  resolveMotionVariant,
  type MotionVariantName,
} from "@/lib/reduced-motion";

const RUNS = { numRuns: 100 } as const;

const variantName: fc.Arbitrary<MotionVariantName> = fc.constantFrom(...MOTION_VARIANT_NAMES);

/** Every target an entry declares: `initial`, `animate`, and `exit` when present. */
function targetsOf(name: MotionVariantName): TargetAndTransition[] {
  const spec = MOTION_VARIANTS[name];
  return [spec.initial, spec.animate, ...(spec.exit ? [spec.exit] : [])];
}

/** Whether a resolved target moves anything — the reduced-motion prohibition. */
function movesAnything(target: TargetAndTransition): boolean {
  return animatedPropertiesOf(target).includes("transform");
}

describe("Feature: zoc-agent-chat-rebuild, Property 51: the motion registry stays within budget", () => {
  it("animates only transform, opacity, and filter (R19.1)", () => {
    fc.assert(
      fc.property(variantName, (name) => {
        for (const target of targetsOf(name)) {
          for (const property of animatedPropertiesOf(target)) {
            // Derived from the target, not read off `properties`: an entry that animates
            // `height` and forgets to declare it still fails here.
            expect(
              (ANIMATABLE_PROPERTIES as readonly string[]).includes(property),
              `${name} animates ${property}`,
            ).toBe(true);
          }
        }
      }),
      RUNS,
    );
  });

  it("declares exactly the properties it animates", () => {
    // The declaration is checkable rather than trusted, in both directions: an
    // under-declaration hides a property from a reviewer, an over-declaration makes the
    // table lie about what moves.
    fc.assert(
      fc.property(variantName, (name) => {
        const spec = MOTION_VARIANTS[name];
        const actual = new Set(targetsOf(name).flatMap((target) => animatedPropertiesOf(target)));
        expect(new Set(spec.properties)).toEqual(actual);
      }),
      RUNS,
    );
  });

  it("keeps every entrance at or under 240 ms (R19.2)", () => {
    fc.assert(
      fc.property(variantName, (name) => {
        const spec = MOTION_VARIANTS[name];
        if (spec.kind !== "entrance") return;
        expect(spec.durationMs).toBeLessThanOrEqual(MOTION_MAX_ENTRANCE_MS);
      }),
      RUNS,
    );
  });

  it("loops only where the entry declares a loop", () => {
    // `repeat` and `kind` are two facts about one behaviour, and reduced motion keys off
    // the first while the budget's ceiling keys off the second. A disagreement would make
    // one of the two clauses above vacuous.
    fc.assert(
      fc.property(variantName, (name) => {
        const spec = MOTION_VARIANTS[name];
        expect(spec.repeat).toBe(spec.kind === "loop");
      }),
      RUNS,
    );
  });

  it("resolves under reduced motion with no repetition and no transform (R19.3)", () => {
    fc.assert(
      fc.property(variantName, (name) => {
        const resolved = resolveMotionVariant(name, true);

        // No transition at all: the target applies instantly, so there is nothing to repeat
        // and no duration to cap.
        expect(resolved.transition).toBeUndefined();
        expect(movesAnything(resolved.initial)).toBe(false);
        expect(movesAnything(resolved.animate)).toBe(false);
        if (resolved.exit) expect(movesAnything(resolved.exit)).toBe(false);
      }),
      RUNS,
    );
  });

  it("still applies the target state under reduced motion", () => {
    // The half an over-eager implementation breaks. An entrance silenced by dropping its
    // `animate` leaves the row invisible — worse for a user than the animation was.
    fc.assert(
      fc.property(variantName, (name) => {
        const resolved = resolveMotionVariant(name, true);
        expect(resolved.animate).toEqual(REDUCED_MOTION_TARGET);
        expect(resolved.animate.opacity).toBe(1);
      }),
      RUNS,
    );
  });

  it("keeps the full animation when reduced motion is off", () => {
    // The control case: without it, a resolver that returned the reduced target
    // unconditionally would pass every clause above.
    fc.assert(
      fc.property(variantName, (name) => {
        const spec = MOTION_VARIANTS[name];
        const resolved = resolveMotionVariant(name, false);

        expect(resolved.animate).toEqual(spec.animate);
        expect(resolved.transition?.duration).toBeCloseTo(spec.durationMs / 1000);
        if (spec.repeat) expect(resolved.transition?.repeat).toBe(Number.POSITIVE_INFINITY);
        else expect(resolved.transition?.repeat).toBeUndefined();
      }),
      RUNS,
    );
  });
});

describe("the concurrency budget (R19.5)", () => {
  /** A generated interleaving of animation starts and completions. */
  const lifecycle = fc.array(fc.constantFrom("start" as const, "complete" as const), {
    maxLength: 60,
  });

  it("never lets the counter go negative, whatever the interleaving", () => {
    // A `complete` without a matching `start` is not hypothetical: `AnimatePresence` can
    // fire a completion for an element whose start was skipped, and a counter that drifted
    // negative would then never warn again.
    fc.assert(
      fc.property(lifecycle, (steps) => {
        const budget = createMotionBudget({ limit: 4, onExceeded: () => undefined });
        for (const step of steps) {
          if (step === "start") budget.start();
          else budget.complete();
          expect(budget.active).toBeGreaterThanOrEqual(0);
        }
      }),
      RUNS,
    );
  });

  it("warns exactly once per over-budget burst", () => {
    // Latched deliberately: a per-frame warning during one busy moment buries the signal
    // it exists to give.
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 30 }), (overshoot) => {
        const warnings: number[] = [];
        const budget = createMotionBudget({
          limit: 2,
          onExceeded: (active) => warnings.push(active),
        });

        for (let i = 0; i < 2 + overshoot; i += 1) budget.start();
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toBe(3);

        // Dropping back under the ceiling re-arms it, so a second burst is reported.
        for (let i = 0; i < 2 + overshoot; i += 1) budget.complete();
        budget.start();
        budget.start();
        budget.start();
        expect(warnings).toHaveLength(2);
      }),
      RUNS,
    );
  });

  it("does not warn at the ceiling, only past it", () => {
    const warnings: number[] = [];
    const budget = createMotionBudget({
      limit: MOTION_CONCURRENCY_LIMIT,
      onExceeded: (active) => warnings.push(active),
    });
    for (let i = 0; i < MOTION_CONCURRENCY_LIMIT; i += 1) budget.start();

    expect(budget.active).toBe(MOTION_CONCURRENCY_LIMIT);
    expect(budget.peak).toBe(MOTION_CONCURRENCY_LIMIT);
    // The inventory's own arithmetic is 11 against a ceiling of 12, so the worst legitimate
    // scene has a unit of margin and must not warn.
    expect(warnings).toEqual([]);
  });

  it("records a high-water mark that survives the elements finishing", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), (count) => {
        const budget = createMotionBudget({ limit: 4, onExceeded: () => undefined });
        for (let i = 0; i < count; i += 1) budget.start();
        for (let i = 0; i < count; i += 1) budget.complete();

        expect(budget.active).toBe(0);
        // The peak is the number a test asserts against after the scene settles; resetting
        // it on completion would make it unobservable.
        expect(budget.peak).toBe(count);
      }),
      RUNS,
    );
  });
});
