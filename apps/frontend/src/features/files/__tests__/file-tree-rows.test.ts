import { describe, expect, it } from "vitest";
import {
  CHILDREN_PAGE_SIZE,
  flattenTree,
  hiddenCount,
  indentFor,
  revealMore,
  sortNodes,
} from "../file-tree-rows";
import type { FileNode } from "@/lib/tauri-bridge";

const dir = (name: string, path: string): FileNode => ({
  name,
  path,
  kind: "dir",
  children: null,
});
const file = (name: string, path: string): FileNode => ({
  name,
  path,
  kind: "file",
  children: null,
});

describe("sortNodes", () => {
  it("puts directories before files and sorts each group by name", () => {
    const sorted = sortNodes([
      file("zeta.ts", "/w/zeta.ts"),
      dir("beta", "/w/beta"),
      file("alpha.ts", "/w/alpha.ts"),
      dir("Alpha", "/w/Alpha"),
    ]);
    expect(sorted.map((n) => n.name)).toEqual(["Alpha", "beta", "alpha.ts", "zeta.ts"]);
  });

  it("does not mutate its input", () => {
    const input = [file("b", "/b"), file("a", "/a")];
    sortNodes(input);
    expect(input.map((n) => n.name)).toEqual(["b", "a"]);
  });
});

describe("flattenTree", () => {
  it("only emits rows for expanded directories", () => {
    const children = {
      "/w": [dir("src", "/w/src")],
      "/w/src": [file("main.ts", "/w/src/main.ts")],
    };

    const collapsed = flattenTree({ root: "/w", children, expanded: { "/w": true } });
    expect(collapsed.map((r) => r.key)).toEqual(["/w/src"]);

    const open = flattenTree({
      root: "/w",
      children,
      expanded: { "/w": true, "/w/src": true },
    });
    expect(open.map((r) => r.key)).toEqual(["/w/src", "/w/src/main.ts"]);
  });

  it("assigns depth by nesting level", () => {
    const rows = flattenTree({
      root: "/w",
      children: {
        "/w": [dir("a", "/w/a")],
        "/w/a": [dir("b", "/w/a/b")],
        "/w/a/b": [file("c.ts", "/w/a/b/c.ts")],
      },
      expanded: { "/w": true, "/w/a": true, "/w/a/b": true },
    });
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2]);
  });

  it("caps a directory at CHILDREN_PAGE_SIZE and appends one load-more row", () => {
    const many = Array.from({ length: CHILDREN_PAGE_SIZE + 500 }, (_, i) =>
      file(`f${i}.ts`, `/w/f${i}.ts`),
    );
    const rows = flattenTree({
      root: "/w",
      children: { "/w": many },
      expanded: { "/w": true },
    });

    expect(rows).toHaveLength(CHILDREN_PAGE_SIZE + 1);
    const last = rows[rows.length - 1];
    expect(last.kind).toBe("load-more");
    if (last.kind === "load-more") {
      expect(last.shown).toBe(CHILDREN_PAGE_SIZE);
      expect(last.total).toBe(CHILDREN_PAGE_SIZE + 500);
    }
  });

  it("omits the load-more row when everything fits", () => {
    const rows = flattenTree({
      root: "/w",
      children: { "/w": [file("a.ts", "/w/a.ts")] },
      expanded: { "/w": true },
    });
    expect(rows.some((r) => r.kind === "load-more")).toBe(false);
  });

  it("reveals another page once the limit is raised", () => {
    const many = Array.from({ length: 2500 }, (_, i) => file(`f${i}.ts`, `/w/f${i}.ts`));
    const limits = revealMore({}, "/w");
    const rows = flattenTree({
      root: "/w",
      children: { "/w": many },
      expanded: { "/w": true },
      limits,
    });
    // Two pages of nodes plus the remaining load-more row.
    expect(rows.filter((r) => r.kind === "node")).toHaveLength(2000);
    expect(rows.some((r) => r.kind === "load-more")).toBe(true);
  });

  it("renders a rename row in place of the node being renamed", () => {
    const rows = flattenTree({
      root: "/w",
      children: { "/w": [file("a.ts", "/w/a.ts")] },
      expanded: { "/w": true },
      edit: { kind: "rename", path: "/w/a.ts" },
    });
    expect(rows[0].kind).toBe("rename");
  });

  it("renders a create-input row inside the target directory", () => {
    const rows = flattenTree({
      root: "/w",
      children: { "/w": [dir("src", "/w/src")], "/w/src": [] },
      expanded: { "/w": true, "/w/src": true },
      edit: { kind: "newfile", dir: "/w/src" },
    });
    const input = rows.find((r) => r.kind === "input");
    expect(input).toBeDefined();
    if (input?.kind === "input") {
      expect(input.dir).toBe("/w/src");
      expect(input.depth).toBe(1);
    }
  });

  it("terminates on a self-referential directory cycle", () => {
    const rows = flattenTree({
      root: "/w",
      children: { "/w": [dir("loop", "/w")] },
      expanded: { "/w": true },
    });
    expect(rows).toHaveLength(1);
  });

  it("emits no rows for an unloaded root", () => {
    expect(flattenTree({ root: "/w", children: {}, expanded: { "/w": true } })).toEqual([]);
  });
});

describe("hiddenCount / revealMore / indentFor", () => {
  it("reports how many children remain hidden", () => {
    const children = {
      "/w": Array.from({ length: 1200 }, (_, i) => file(`f${i}`, `/w/f${i}`)),
    };
    expect(hiddenCount("/w", children, {})).toBe(200);
    expect(hiddenCount("/w", children, revealMore({}, "/w"))).toBe(0);
    expect(hiddenCount("/missing", children, {})).toBe(0);
  });

  it("grows the limit one page at a time", () => {
    let limits = revealMore({}, "/w");
    expect(limits["/w"]).toBe(CHILDREN_PAGE_SIZE * 2);
    limits = revealMore(limits, "/w");
    expect(limits["/w"]).toBe(CHILDREN_PAGE_SIZE * 3);
  });

  it("indents 12px per level from a 6px base", () => {
    expect(indentFor(0)).toBe(6);
    expect(indentFor(3)).toBe(42);
  });
});
