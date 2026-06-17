import { describe, it, expect } from "vitest";
import {
  activeAfterDelete,
  basename,
  dirname,
  isWithin,
  joinPath,
  openFilesAfterDelete,
  remapActive,
  remapOpenFiles,
  remapPath,
  renamedPath,
  sepOf,
} from "@/lib/paths";
import type { OpenFile } from "@/lib/store";

const f = (path: string): OpenFile => ({
  path,
  name: basename(path),
  language: "typescript",
  content: "",
  dirty: false,
});

describe("path helpers (POSIX)", () => {
  it("detects the separator", () => {
    expect(sepOf("/a/b")).toBe("/");
    expect(sepOf("C:\\a\\b")).toBe("\\");
    expect(sepOf("/a\\weird")).toBe("/"); // mixed → prefers "/"
  });

  it("dirname / basename / joinPath", () => {
    expect(dirname("/a/b/c.ts")).toBe("/a/b");
    expect(basename("/a/b/c.ts")).toBe("c.ts");
    expect(joinPath("/a/b", "c.ts")).toBe("/a/b/c.ts");
    expect(joinPath("/a/b/", "c.ts")).toBe("/a/b/c.ts");
  });

  it("renamedPath keeps the parent", () => {
    expect(renamedPath("/a/b/old.ts", "new.ts")).toBe("/a/b/new.ts");
  });

  it("isWithin matches self and descendants only", () => {
    expect(isWithin("/a/b", "/a/b")).toBe(true);
    expect(isWithin("/a/b", "/a/b/c.ts")).toBe(true);
    expect(isWithin("/a/b", "/a/bc.ts")).toBe(false);
    expect(isWithin("/a/b", "/a")).toBe(false);
  });

  it("remapPath rewrites the exact path and descendants", () => {
    expect(remapPath("/a/old.ts", "/a/old.ts", "/a/new.ts")).toBe("/a/new.ts");
    expect(remapPath("/a/dir/x.ts", "/a/dir", "/a/renamed")).toBe("/a/renamed/x.ts");
    expect(remapPath("/a/other.ts", "/a/dir", "/a/renamed")).toBe("/a/other.ts");
  });
});

describe("Windows separators", () => {
  it("works with backslashes", () => {
    expect(dirname("C:\\a\\b.ts")).toBe("C:\\a");
    expect(joinPath("C:\\a", "b.ts")).toBe("C:\\a\\b.ts");
    expect(remapPath("C:\\a\\dir\\x.ts", "C:\\a\\dir", "C:\\a\\new")).toBe("C:\\a\\new\\x.ts");
  });
});

describe("open-file remapping", () => {
  it("rewrites the renamed file's path and display name", () => {
    const files = [f("/a/old.ts"), f("/a/keep.ts")];
    const out = remapOpenFiles(files, "/a/old.ts", "/a/new.ts");
    expect(out[0]).toMatchObject({ path: "/a/new.ts", name: "new.ts" });
    expect(out[1]).toBe(files[1]); // untouched reference
  });

  it("rewrites descendants when a directory is renamed/moved", () => {
    const files = [f("/a/dir/x.ts"), f("/a/dir/sub/y.ts")];
    const out = remapOpenFiles(files, "/a/dir", "/a/moved");
    expect(out.map((x) => x.path)).toEqual(["/a/moved/x.ts", "/a/moved/sub/y.ts"]);
  });

  it("remaps the active file", () => {
    expect(remapActive("/a/dir/x.ts", "/a/dir", "/a/new")).toBe("/a/new/x.ts");
    expect(remapActive(null, "/a", "/b")).toBeNull();
  });
});

describe("delete remapping", () => {
  it("drops the deleted file and descendants", () => {
    const files = [f("/a/dir/x.ts"), f("/a/dir/y.ts"), f("/a/keep.ts")];
    expect(openFilesAfterDelete(files, "/a/dir").map((x) => x.path)).toEqual(["/a/keep.ts"]);
    expect(openFilesAfterDelete(files, "/a/dir/x.ts").map((x) => x.path)).toEqual([
      "/a/dir/y.ts",
      "/a/keep.ts",
    ]);
  });

  it("moves the active selection to a survivor when it was deleted", () => {
    const files = [f("/a/dir/x.ts"), f("/a/keep.ts")];
    expect(activeAfterDelete(files, "/a/dir/x.ts", "/a/dir")).toBe("/a/keep.ts");
    // Unaffected active file stays.
    expect(activeAfterDelete(files, "/a/keep.ts", "/a/dir")).toBe("/a/keep.ts");
  });
});
