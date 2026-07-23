// Feature: editor-diagnostics-completions, Property 4: Problems badge is an exact function of store contents
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { Diagnostic, Severity } from "@/lib/problem-matchers";
import { problemsBadge } from "../problems-badge";

const severityArb = fc.constantFrom<Severity>("error", "warning", "info", "hint");

function diag(severity: Severity, file = "/a.ts"): Diagnostic {
  return { source: "s", file, line: 1, column: 1, severity, message: "m" };
}

// Any store: a mix of lsp:* and command-checker keys, each holding a list of
// diagnostics of arbitrary severities.
const storeArb: fc.Arbitrary<Record<string, Diagnostic[]>> = fc
  .array(
    fc.record({
      key: fc.oneof(
        fc.constantFrom("typescript", "eslint", "ruff", "cargo"),
        fc.string({ minLength: 1 }).map((s) => `lsp:file:///${s}`),
      ),
      diags: fc.array(severityArb.map((s) => diag(s)), { maxLength: 8 }),
    }),
    { maxLength: 10 },
  )
  .map((entries) => {
    const store: Record<string, Diagnostic[]> = {};
    for (const e of entries) store[e.key] = e.diags;
    return store;
  });

describe("problems-badge (Property 4)", () => {
  it("Property 4: badge is an exact function of store contents", () => {
    fc.assert(
      fc.property(storeArb, (store) => {
        const all = Object.values(store).flat();
        const errors = all.filter((d) => d.severity === "error").length;
        const warnings = all.filter((d) => d.severity === "warning").length;
        const badge = problemsBadge(store);

        expect(badge.count).toBe(errors + warnings); // excludes info/hint
        expect(badge.visible).toBe(badge.count > 0);
        if (errors > 0) expect(badge.color).toBe("error");
        else if (warnings > 0) expect(badge.color).toBe("warning");
        else expect(badge.color).toBe("none");
      }),
      { numRuns: 200 },
    );
  });
});
