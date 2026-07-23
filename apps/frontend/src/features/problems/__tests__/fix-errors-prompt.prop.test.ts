// Feature: editor-diagnostics-completions, Property 6: "Run agent to fix N errors" enumerates only errors
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { Diagnostic, Severity } from "@/lib/problem-matchers";
import { buildFixErrorsPrompt, errorCount } from "../fix-errors-prompt";

const severityArb = fc.constantFrom<Severity>("error", "warning", "info", "hint");

const diagArb: fc.Arbitrary<Diagnostic> = fc.record({
  source: fc.string(),
  file: fc.constant("/src/file.ts"),
  line: fc.integer({ min: 1, max: 99999 }),
  column: fc.integer({ min: 1, max: 99999 }),
  severity: severityArb,
  message: fc.string(),
});

describe("fix-errors-prompt (Property 6)", () => {
  it("Property 6: the action is offered iff there is an error, N = error count, prompt enumerates only errors", () => {
    fc.assert(
      fc.property(fc.constant("/src/file.ts"), fc.array(diagArb, { maxLength: 20 }), (file, diags) => {
        const errors = diags.filter((d) => d.severity === "error");
        const nonErrors = diags.filter((d) => d.severity !== "error");

        // R6.1: N and offered-iff-error.
        expect(errorCount(diags)).toBe(errors.length);
        const offered = errorCount(diags) >= 1;
        expect(offered).toBe(errors.length > 0);

        const prompt = buildFixErrorsPrompt(file, diags);
        // R6.2: identifies the file by its path.
        expect(prompt.includes(file)).toBe(true);
        // R6.2: contains line, column, and message of every error diagnostic.
        for (const e of errors) {
          expect(prompt.includes(`Line ${e.line}, column ${e.column}`)).toBe(true);
          if (e.message.trim().length > 0) expect(prompt.includes(e.message)).toBe(true);
        }
        // R6.3: contains no non-error diagnostic's coordinates (unless an
        // error happens to share the identical line+column label).
        for (const ne of nonErrors) {
          const label = `Line ${ne.line}, column ${ne.column}:`;
          const sharedWithError = errors.some(
            (e) => e.line === ne.line && e.column === ne.column,
          );
          if (!sharedWithError) expect(prompt.includes(label)).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });
});
