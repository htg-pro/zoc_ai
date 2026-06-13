// Feature: studio-ui-redesign, Property 6: Elapsed-time formatting is correct for any duration
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { elapsedParts, formatElapsed } from "../format-elapsed";

describe("format-elapsed (Property 6)", () => {
  it("returns HH:MM:SS whose components correctly decompose any non-negative duration", () => {
    fc.assert(
      fc.property(fc.nat({ max: 400 * 3600 * 1000 }), (ms) => {
        const s = formatElapsed(ms);
        // Shape: HH:MM:SS with >= 2 digits per field and 2 colons.
        expect(s).toMatch(/^\d{2,}:\d{2}:\d{2}$/);

        const { hours, minutes, seconds } = elapsedParts(ms);
        expect(seconds).toBeGreaterThanOrEqual(0);
        expect(seconds).toBeLessThanOrEqual(59);
        expect(minutes).toBeGreaterThanOrEqual(0);
        expect(minutes).toBeLessThanOrEqual(59);
        expect(hours).toBeGreaterThanOrEqual(0);

        // Components recompose to the floored-seconds total.
        const totalSeconds = hours * 3600 + minutes * 60 + seconds;
        expect(totalSeconds).toBe(Math.floor(ms / 1000));

        // The string parses back to the same parts.
        const [hh, mm, ss] = s.split(":").map((p) => Number.parseInt(p, 10));
        expect(hh).toBe(hours);
        expect(mm).toBe(minutes);
        expect(ss).toBe(seconds);
      }),
      { numRuns: 200 },
    );
  });

  it("clamps negative input to zero", () => {
    expect(formatElapsed(-1000)).toBe("00:00:00");
  });
});
