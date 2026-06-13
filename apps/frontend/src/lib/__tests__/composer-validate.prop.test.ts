// Feature: studio-ui-redesign, Property 9: Message validation accepts exactly 1-10,000 non-whitespace-trimmed characters
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  MAX_MESSAGE_LENGTH,
  isValidMessage,
  validateMessage,
} from "../composer-validate";

describe("composer-validate (Property 9)", () => {
  it("accepts iff trimmed length is in [1, 10000]", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (s) => {
        const trimmed = s.trim().length;
        const expected = trimmed >= 1 && trimmed <= MAX_MESSAGE_LENGTH;
        expect(isValidMessage(s)).toBe(expected);
      }),
      { numRuns: 300 },
    );
  });

  it("rejects whitespace-only strings", () => {
    fc.assert(
      fc.property(
        fc.stringOf(fc.constantFrom(" ", "\t", "\n", "\r"), { maxLength: 50 }),
        (ws) => {
          const r = validateMessage(ws);
          expect(r.valid).toBe(false);
          expect(r.reason).toBe("empty");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("rejects input whose trimmed length exceeds the max", () => {
    const tooLong = "a".repeat(MAX_MESSAGE_LENGTH + 1);
    const r = validateMessage(tooLong);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("too_long");
    // Boundary: exactly max is accepted.
    expect(isValidMessage("a".repeat(MAX_MESSAGE_LENGTH))).toBe(true);
  });
});
