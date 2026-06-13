import { describe, it, expect } from "vitest";
import { parseUnifiedDiff } from "@/lib/diff-utils";

const SAMPLE = `--- a/x.ts
+++ b/x.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 export { a };
`;

describe("parseUnifiedDiff", () => {
  it("counts adds and deletions", () => {
    const { adds, dels, hunks } = parseUnifiedDiff(SAMPLE);
    expect(adds).toBe(2);
    expect(dels).toBe(1);
    expect(hunks).toHaveLength(1);
  });

  it("skips file headers", () => {
    const { hunks } = parseUnifiedDiff(SAMPLE);
    const text = hunks[0].lines.map((l) => l.text).join("\n");
    expect(text).not.toMatch(/^---/m);
    expect(text).not.toMatch(/^\+\+\+/m);
  });

  it("tracks line numbers", () => {
    const { hunks } = parseUnifiedDiff(SAMPLE);
    const ctx = hunks[0].lines.find((l) => l.kind === "ctx" && l.text === "const a = 1;");
    expect(ctx?.oldNum).toBe(1);
    expect(ctx?.newNum).toBe(1);
  });
});
