// Feature: studio-ui-redesign, Property 13: Review summary aggregates counts as non-negative integers
// Feature: studio-ui-redesign, Property 14: Change-position navigation clamps within bounds
// Feature: studio-ui-redesign, Property 15: Apply isolates to a single file
// Feature: studio-ui-redesign, Property 16: Undo isolates to a single file
// Feature: studio-ui-redesign, Property 17: Applied-state persistence round-trips
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  changePosition,
  clampIndex,
  deserializeAppliedIds,
  markApplied,
  nextIndex,
  prevIndex,
  removePatch,
  reviewSummary,
  serializeAppliedIds,
} from "../diff-utils";
import { arbPatchesUniqueIds } from "../../__tests__/arbitraries";

describe("diff-utils review extension", () => {
  it("Property 13: review summary aggregates per-file counts as non-negative integers", () => {
    fc.assert(
      fc.property(arbPatchesUniqueIds, (patches) => {
        const expectedAdds = patches.reduce((a, p) => a + p._adds, 0);
        const expectedDels = patches.reduce((a, p) => a + p._dels, 0);
        const s = reviewSummary(patches);

        expect(s.files).toBe(patches.length);
        expect(s.adds).toBe(expectedAdds);
        expect(s.dels).toBe(expectedDels);
        for (const v of [s.files, s.adds, s.dels]) {
          expect(Number.isInteger(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("Property 13b: empty patch set yields all zeros", () => {
    expect(reviewSummary([])).toEqual({ files: 0, adds: 0, dels: 0 });
  });

  it("Property 14: navigation keeps 1 <= N <= M and clamps at the ends", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.array(fc.constantFrom("next", "prev"), { maxLength: 40 }),
        (m, actions) => {
          let index = 0;
          for (const a of actions) {
            index = a === "next" ? nextIndex(index, m) : prevIndex(index, m);
            const { n, m: total } = changePosition(index, m);
            expect(total).toBe(m);
            expect(n).toBeGreaterThanOrEqual(1);
            expect(n).toBeLessThanOrEqual(m);
          }
          // next at last stays at last; prev at first stays at first.
          expect(nextIndex(m - 1, m)).toBe(m - 1);
          expect(prevIndex(0, m)).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("Property 14b: clampIndex on an empty set is -1", () => {
    expect(clampIndex(0, 0)).toBe(-1);
    expect(changePosition(3, 0)).toEqual({ n: 0, m: 0 });
  });

  it("Property 15/16: apply/undo removes exactly the target, leaving others unchanged", () => {
    fc.assert(
      fc.property(arbPatchesUniqueIds, fc.nat(), (patches, pick) => {
        const target = patches[pick % patches.length];
        const remaining = removePatch(patches, target.id);

        // Target removed.
        expect(remaining.some((p) => p.id === target.id)).toBe(false);
        // Exactly one fewer.
        expect(remaining.length).toBe(patches.length - 1);
        // Every other patch retained, in order, unchanged.
        const expected = patches.filter((p) => p.id !== target.id);
        expect(remaining).toEqual(expected);
      }),
      { numRuns: 200 },
    );
  });

  it("Property 17: applied-id persistence round-trips", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.hexaString({ minLength: 1, maxLength: 6 }), {
          maxLength: 8,
        }),
        fc.hexaString({ minLength: 1, maxLength: 6 }),
        (appliedIds, neverId) => {
          let set = new Set<string>();
          for (const id of appliedIds) set = markApplied(set, id);

          const reloaded = deserializeAppliedIds(serializeAppliedIds(set));
          for (const id of appliedIds) {
            expect(reloaded.has(id)).toBe(true);
          }
          if (!appliedIds.includes(neverId)) {
            expect(reloaded.has(neverId)).toBe(false);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
