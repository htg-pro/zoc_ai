import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  pushRecent,
  recentFiles,
  recordRecentFile,
  recentCommands,
  recordRecentCommand,
} from "@/lib/recents";

describe("pushRecent (pure)", () => {
  it("moves an existing value to the front without duplicating", () => {
    expect(pushRecent(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
    expect(pushRecent(["a", "b"], "a")).toEqual(["a", "b"]);
  });

  it("prepends a new value", () => {
    expect(pushRecent(["a"], "b")).toEqual(["b", "a"]);
  });

  it("ignores empty/whitespace values", () => {
    expect(pushRecent(["a"], "   ")).toEqual(["a"]);
  });

  it("caps the list length", () => {
    expect(pushRecent(["a", "b", "c"], "d", 3)).toEqual(["d", "a", "b"]);
  });
});

const realLocalStorage = globalThis.localStorage;
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
  } as Storage;
}

describe("recents persistence", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeStorage());
  });
  afterAll(() => {
    vi.stubGlobal("localStorage", realLocalStorage);
  });

  it("round-trips recent files newest-first", () => {
    expect(recentFiles()).toEqual([]);
    recordRecentFile("/a.ts");
    recordRecentFile("/b.ts");
    recordRecentFile("/a.ts");
    expect(recentFiles()).toEqual(["/a.ts", "/b.ts"]);
  });

  it("tracks recent command ids separately from files", () => {
    recordRecentFile("/a.ts");
    recordRecentCommand("workbench.action.files.save");
    expect(recentCommands()).toEqual(["workbench.action.files.save"]);
    expect(recentFiles()).toEqual(["/a.ts"]);
  });
});
