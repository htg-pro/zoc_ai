// Feature: zoc-agent-ecosystem-merge, Property 4: Composer rejects empty input and otherwise sends the selected mode
//
// For any input string and any toggle in {ask, agent}, `prepareAgentRun(input, mode)`
// returns null when the trimmed input is empty / whitespace-only (no run request is
// produced), and otherwise returns exactly one run request carrying the trimmed input
// and a `mode` equal to the toggle.
//
// Validates: Requirements 4.1, 4.2, 4.5
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { prepareAgentRun, type AgentMode } from "./prepare-agent-run";

/** The two toggle values the Ask/Agent pill can select. */
const arbMode: fc.Arbitrary<AgentMode> = fc.constantFrom("ask", "agent");

/**
 * Whitespace-only inputs (including the empty string): these must always be
 * rejected. Built from runs of common whitespace characters so the trimmed
 * length is guaranteed to be zero.
 */
const arbWhitespaceOnly: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(" ", "\t", "\n", "\r", "\f", "\v", "\u00a0"), { maxLength: 12 })
  .map((chars) => chars.join(""));

/**
 * Arbitrary input strings: a broad mix of arbitrary strings plus some with
 * deliberate surrounding whitespace so the trimming behavior is exercised on
 * the non-empty branch.
 */
const arbAnyInput: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: fc.string() },
  { weight: 2, arbitrary: arbWhitespaceOnly },
  {
    weight: 3,
    // Surround a possibly-empty core with whitespace to probe trim handling.
    arbitrary: fc.tuple(arbWhitespaceOnly, fc.string(), arbWhitespaceOnly).map(
      ([lead, core, trail]) => `${lead}${core}${trail}`,
    ),
  },
);

describe("Property 4: Composer rejects empty input and otherwise sends the selected mode", () => {
  it("rejects empty/whitespace-only input and otherwise sends exactly the trimmed input with the toggle's mode", () => {
    fc.assert(
      fc.property(arbAnyInput, arbMode, (input, mode) => {
        const result = prepareAgentRun(input, mode);
        const trimmed = input.trim();

        if (trimmed.length === 0) {
          // Empty / whitespace-only trimmed input → no run request produced (R4.5).
          expect(result).toBeNull();
          return;
        }

        // Non-empty trimmed input → exactly one run request carrying the
        // trimmed input and a mode equal to the selected toggle (R4.1, R4.2).
        expect(result).not.toBeNull();
        expect(result).toEqual({ input: trimmed, mode });
      }),
      { numRuns: 200 },
    );
  });

  it("always rejects whitespace-only input regardless of mode", () => {
    fc.assert(
      fc.property(arbWhitespaceOnly, arbMode, (input, mode) => {
        expect(prepareAgentRun(input, mode)).toBeNull();
      }),
      { numRuns: 200 },
    );
  });
});
