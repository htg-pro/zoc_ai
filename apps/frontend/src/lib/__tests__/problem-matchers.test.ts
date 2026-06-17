import { describe, it, expect } from "vitest";
import {
  countBySeverity,
  parseByKind,
  parseCargo,
  parseEslint,
  parseRuff,
  parseTsc,
  sourceForKind,
} from "@/lib/problem-matchers";

describe("parseTsc", () => {
  it("parses tsc --noEmit errors and warnings", () => {
    const out = [
      "src/app.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/util.ts(3,1): warning TS6133: 'x' is declared but its value is never read.",
      "Found 2 errors.",
    ].join("\n");
    const d = parseTsc(out);
    expect(d).toHaveLength(2);
    expect(d[0]).toMatchObject({
      source: "typescript",
      file: "src/app.ts",
      line: 12,
      column: 5,
      severity: "error",
      code: "TS2322",
    });
    expect(d[1].severity).toBe("warning");
  });
});

describe("parseEslint", () => {
  it("parses the stylish formatter grouped by file", () => {
    const out = [
      "/ws/src/a.ts",
      "  12:5   error    'x' is assigned a value but never used   no-unused-vars",
      "  14:1   warning  Missing semicolon                        semi",
      "",
      "/ws/src/b.ts",
      "  1:1  error  Parsing error: boom",
      "",
      "✖ 3 problems (2 errors, 1 warning)",
    ].join("\n");
    const d = parseEslint(out);
    expect(d).toHaveLength(3);
    expect(d[0]).toMatchObject({
      source: "eslint",
      file: "/ws/src/a.ts",
      line: 12,
      column: 5,
      severity: "error",
      code: "no-unused-vars",
    });
    expect(d[2].file).toBe("/ws/src/b.ts");
    expect(d[2].message).toContain("Parsing error");
  });
});

describe("parseRuff", () => {
  it("parses ruff text output and flags E9 as errors", () => {
    const out = [
      "src/a.py:3:1: F401 [*] `os` imported but unused",
      "src/b.py:10:5: E999 SyntaxError: invalid syntax",
    ].join("\n");
    const d = parseRuff(out);
    expect(d).toHaveLength(2);
    expect(d[0]).toMatchObject({ source: "ruff", code: "F401", severity: "warning", line: 3 });
    expect(d[1].severity).toBe("error");
  });
});

describe("parseCargo", () => {
  it("parses cargo --message-format=short", () => {
    const out = [
      "src/main.rs:10:5: error[E0382]: borrow of moved value: `x`",
      "src/lib.rs:3:9: warning: unused variable: `y`",
    ].join("\n");
    const d = parseCargo(out);
    expect(d).toHaveLength(2);
    expect(d[0]).toMatchObject({ source: "cargo", code: "E0382", severity: "error", file: "src/main.rs" });
    expect(d[1]).toMatchObject({ severity: "warning", code: undefined });
  });
});

describe("helpers", () => {
  it("parseByKind dispatches to the right parser", () => {
    expect(parseByKind("tsc", "x.ts(1,1): error TS1: bad").length).toBe(1);
    expect(parseByKind("ruff", "a.py:1:1: F401 unused").length).toBe(1);
  });

  it("sourceForKind maps kinds to sources", () => {
    expect(sourceForKind("tsc")).toBe("typescript");
    expect(sourceForKind("cargo")).toBe("cargo");
  });

  it("countBySeverity tallies errors and warnings", () => {
    const items = parseTsc(
      [
        "a.ts(1,1): error TS1: a",
        "a.ts(2,1): warning TS2: b",
        "a.ts(3,1): error TS3: c",
      ].join("\n"),
    );
    expect(countBySeverity(items)).toEqual({ errors: 2, warnings: 1 });
  });
});
