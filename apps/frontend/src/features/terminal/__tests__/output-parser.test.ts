import { test, expect } from "vitest";
import fc from "fast-check";
import {
  collapseCarriageReturns,
  parseTerminalLine,
  parseTestSummary,
  type PathAnnotation,
  type UrlAnnotation,
} from "../output-parser";

const tokenArb = fc.constantFrom(
  "http://example.com/a",
  "https://x.io/p?q=1",
  "src/a.ts:42:10",
  "./b.py:7",
  "lib/c.js",
  "hello",
  "world",
  "done",
);

// Feature: advanced-terminal, Property 5: Annotations are non-overlapping and offset-faithful
test("annotations are sorted, non-overlapping, and slice back to their raw text", () => {
  fc.assert(
    fc.property(fc.array(tokenArb, { maxLength: 6 }), (tokens) => {
      const line = tokens.join(" ");
      const anns = parseTerminalLine(line);
      for (let i = 1; i < anns.length; i += 1) {
        expect(anns[i].start).toBeGreaterThanOrEqual(anns[i - 1].end); // sorted + non-overlapping
      }
      for (const a of anns) {
        expect(a.start).toBeGreaterThanOrEqual(0);
        expect(a.end).toBeLessThanOrEqual(line.length);
        expect(line.slice(a.start, a.end)).toBe(a.raw);
      }
    }),
    { numRuns: 200 },
  );
});

// Feature: advanced-terminal, Property 6: Path/URL/summary extraction
test("a path token yields path/line/column", () => {
  const anns = parseTerminalLine("see src/a.ts:42:10 now");
  const path = anns.find((a): a is PathAnnotation => a.type === "path");
  expect(path).toBeDefined();
  expect(path).toMatchObject({ path: "src/a.ts", line: 42, column: 10 });
});

test("a Windows path preserves its drive and location", () => {
  const anns = parseTerminalLine(String.raw`error C:\repo\src\main.rs:12:4`);
  const path = anns.find((annotation): annotation is PathAnnotation => annotation.type === "path");
  expect(path).toMatchObject({ path: String.raw`C:\repo\src\main.rs`, line: 12, column: 4 });
});

test("a url token yields a url annotation without trailing punctuation", () => {
  const anns = parseTerminalLine("open http://localhost:3000. please");
  const url = anns.find((a): a is UrlAnnotation => a.type === "url");
  expect(url?.url).toBe("http://localhost:3000");
});

test("test summaries parse passed/failed/skipped across pytest/jest/cargo", () => {
  expect(parseTestSummary("5 passed, 2 failed, 1 skipped")).toEqual({ passed: 5, failed: 2, skipped: 1 });
  expect(parseTestSummary("Tests: 1 failed, 5 passed, 6 total")).toEqual({ passed: 5, failed: 1, skipped: 0 });
  expect(parseTestSummary("test result: ok. 3 passed; 0 failed; 1 ignored")).toEqual({ passed: 3, failed: 0, skipped: 1 });
  expect(parseTestSummary("just some text")).toBeNull();

  const anns = parseTerminalLine("5 passed, 2 failed");
  expect(anns).toHaveLength(1);
  expect(anns[0]).toMatchObject({ type: "test-summary", passed: 5, failed: 2 });
});

test("stacktrace lines are single whole-line annotations", () => {
  for (const line of ["  at fn (file.js:1:2)", 'File "x.py", line 3', "Traceback (most recent call last):"]) {
    const anns = parseTerminalLine(line);
    expect(anns).toHaveLength(1);
    expect(anns[0]).toMatchObject({ type: "stack", start: 0, end: line.length });
  }
});

// Feature: advanced-terminal, Property 7: Carriage-return collapse
test("collapseCarriageReturns keeps the final overwritten segment", () => {
  expect(collapseCarriageReturns("a\rb\rc")).toBe("c");
  expect(collapseCarriageReturns("no cr here")).toBe("no cr here");
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom("ab", "cd", "x1", "", "done", "12%"), { minLength: 1, maxLength: 5 }),
      (parts) => {
        const joined = parts.join("\r");
        const expected = parts.length === 1 ? parts[0] : parts[parts.length - 1];
        expect(collapseCarriageReturns(joined)).toBe(expected);
      },
    ),
    { numRuns: 200 },
  );
});
