// Feature: inline-edit (Cmd-K) — pure splice/context/diff helpers
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  buildInlineEditPatch,
  spliceText,
  stripCodeFence,
  surroundingContext,
} from "../inline-edit";

describe("inline-edit helpers", () => {
  it("spliceText replaces exactly [start,end) and round-trips identity", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (full, repl) => {
        // Splicing the whole range yields the replacement.
        expect(spliceText(full, 0, full.length, repl)).toBe(repl);
        // Replacing a slice with itself is a no-op.
        const a = Math.floor(full.length / 3);
        const b = Math.floor((2 * full.length) / 3);
        expect(spliceText(full, a, b, full.slice(a, b))).toBe(full);
      }),
      { numRuns: 200 },
    );
  });

  it("spliceText clamps out-of-range offsets safely", () => {
    expect(spliceText("abc", -5, 99, "X")).toBe("X");
    expect(spliceText("abc", 2, 1, "X")).toBe("abXc"); // end clamped up to start
  });

  it("surroundingContext stays within the window and never overlaps the selection", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 200 }),
        fc.nat(200),
        fc.nat(200),
        fc.integer({ min: 0, max: 50 }),
        (full, s, e, win) => {
          const start = Math.min(s, e);
          const end = Math.max(s, e);
          const { prefix, suffix } = surroundingContext(full, start, end, win);
          expect(prefix.length).toBeLessThanOrEqual(win);
          expect(suffix.length).toBeLessThanOrEqual(win);
          // prefix is the text just before the (clamped) selection.
          const lo = Math.max(0, Math.min(start, full.length));
          expect(full.slice(Math.max(0, lo - win), lo)).toBe(prefix);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("stripCodeFence unwraps a single fence and is idempotent on plain text", () => {
    expect(stripCodeFence("```ts\nconst x = 1;\n```")).toBe("const x = 1;");
    expect(stripCodeFence("```\nplain\n```")).toBe("plain");
    fc.assert(
      fc.property(fc.string(), (s) => {
        // Plain text without a leading fence is returned verbatim.
        if (!s.trim().startsWith("```")) expect(stripCodeFence(s)).toBe(s);
      }),
      { numRuns: 100 },
    );
  });

  it("buildInlineEditPatch returns null when unchanged and a patch when changed", () => {
    expect(buildInlineEditPatch("a.ts", "same", "same")).toBeNull();
    const patch = buildInlineEditPatch("a.ts", "before\n", "after\n");
    expect(patch).not.toBeNull();
    expect(patch!.file_path).toBe("a.ts");
    expect(patch!.unified_diff).toContain("after");
  });
});
