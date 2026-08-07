import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cancelAgentEditBatch,
  commitAgentEditBatch,
  registerAgentEditTarget,
  resetAgentEditBridgeForTests,
  searchReplaceEditsFromUnifiedDiff,
  stageAgentEditBatch,
} from "../agent-edit-bridge";

describe("searchReplaceEditsFromUnifiedDiff", () => {
  it("converts replacement hunks with context into exact SearchReplace steps", () => {
    const edits = searchReplaceEditsFromUnifiedDiff(
      [
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,3 +1,3 @@",
        " keep",
        "-old",
        "+new",
        " tail",
        "",
      ].join("\n"),
    );

    expect(edits).toEqual([
      {
        search: "keep\nold\ntail\n",
        replace: "keep\nnew\ntail\n",
      },
    ]);
  });

  it("anchors pure insertions and preserves no-newline markers", () => {
    expect(searchReplaceEditsFromUnifiedDiff("@@ -2,0 +2,1 @@\n+inserted\n")).toEqual([
      { search: "", replace: "inserted\n", startLineNumber: 2 },
    ]);

    expect(
      searchReplaceEditsFromUnifiedDiff(
        "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file",
      ),
    ).toEqual([{ search: "old", replace: "new" }]);
  });
});

describe("approved agent edit bridge", () => {
  beforeEach(() => resetAgentEditBridgeForTests());
  afterEach(() => resetAgentEditBridgeForTests());

  it("does not touch Monaco before commit and dispatches only selected mounted files", async () => {
    const applyA = vi.fn(async () => undefined);
    const applyB = vi.fn(async () => undefined);
    const offA = registerAgentEditTarget("/workspace/src/a.ts", applyA);
    const offB = registerAgentEditTarget("/workspace/src/b.ts", applyB);
    stageAgentEditBatch("run-1", [
      {
        path: "src/a.ts",
        diff: "@@ -1 +1 @@\n-old\n+new\n",
        adds: 1,
        dels: 1,
      },
    ]);

    expect(applyA).not.toHaveBeenCalled();
    expect(commitAgentEditBatch("run-1")).toBe(1);
    await Promise.resolve();

    expect(applyA).toHaveBeenCalledWith({
      runId: "run-1",
      path: "src/a.ts",
      diff: "@@ -1 +1 @@\n-old\n+new\n",
      adds: 1,
      dels: 1,
      edits: [{ search: "old\n", replace: "new\n" }],
    });
    expect(applyB).not.toHaveBeenCalled();
    expect(commitAgentEditBatch("run-1")).toBe(0);
    offA();
    offB();
  });

  it("drops rejected batches and unregisters unmounted editors", () => {
    const apply = vi.fn();
    const off = registerAgentEditTarget("C:\\work\\src\\a.ts", apply);
    stageAgentEditBatch("run-cancel", [
      {
        path: "src/a.ts",
        diff: "@@ -1 +1 @@\n-a\n+A\n",
        adds: 1,
        dels: 1,
      },
    ]);
    cancelAgentEditBatch("run-cancel");
    expect(commitAgentEditBatch("run-cancel")).toBe(0);

    stageAgentEditBatch("run-unmounted", [
      {
        path: "src/a.ts",
        diff: "@@ -1 +1 @@\n-a\n+A\n",
        adds: 1,
        dels: 1,
      },
    ]);
    off();
    expect(commitAgentEditBatch("run-unmounted")).toBe(0);
    expect(apply).not.toHaveBeenCalled();
  });
});
