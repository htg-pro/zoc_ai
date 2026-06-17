import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  coerce,
  effectiveSource,
  getSetting,
  loadScope,
  mergeSettings,
  resetSetting,
  sanitizeScope,
  searchSettings,
  setSetting,
  specFor,
  SETTINGS_REGISTRY,
} from "@/lib/settings";

const realLocalStorage = globalThis.localStorage;

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

describe("settings", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeStorage());
  });
  afterAll(() => {
    vi.stubGlobal("localStorage", realLocalStorage);
  });

  it("coerces values per spec type and rejects invalid ones", () => {
    const bool = specFor("editor.minimap")!;
    expect(coerce(bool, true)).toBe(true);
    expect(coerce(bool, "yes")).toBeUndefined();

    const num = specFor("editor.fontSize")!;
    expect(coerce(num, 14)).toBe(14);
    expect(coerce(num, 4)).toBeUndefined(); // below min
    expect(coerce(num, 99)).toBeUndefined(); // above max

    const en = specFor("agent.autonomy")!;
    expect(coerce(en, "Low")).toBe("Low");
    expect(coerce(en, "Nope")).toBeUndefined();
  });

  it("sanitizeScope keeps only known, valid keys", () => {
    const clean = sanitizeScope({
      "editor.minimap": true,
      "editor.fontSize": 999, // out of range → dropped
      "unknown.key": "x", // unknown → dropped
    });
    expect(clean).toEqual({ "editor.minimap": true });
  });

  it("merges default < user < workspace", () => {
    const merged = mergeSettings(
      { "editor.minimap": true, "agent.autonomy": "Low" },
      { "agent.autonomy": "Medium" },
    );
    expect(merged["editor.minimap"]).toBe(true); // from user
    expect(merged["agent.autonomy"]).toBe("Medium"); // workspace wins
    expect(merged["editor.breadcrumbs"]).toBe(true); // default
  });

  it("set/get and effectiveSource reflect the winning scope", () => {
    setSetting("user", "editor.minimap", true);
    expect(getSetting("editor.minimap")).toBe(true);
    expect(effectiveSource("editor.minimap")).toBe("user");

    setSetting("workspace", "editor.minimap", false);
    expect(getSetting("editor.minimap")).toBe(false);
    expect(effectiveSource("editor.minimap")).toBe("workspace");

    resetSetting("workspace", "editor.minimap");
    expect(getSetting("editor.minimap")).toBe(true);
    expect(effectiveSource("editor.minimap")).toBe("user");
  });

  it("ignores invalid set values", () => {
    setSetting("user", "agent.autonomy", "Bogus");
    expect(loadScope("user")["agent.autonomy"]).toBeUndefined();
    expect(getSetting("agent.autonomy")).toBe("High"); // default
  });

  it("searchSettings matches label/key/description and returns all when empty", () => {
    expect(searchSettings("")).toHaveLength(SETTINGS_REGISTRY.length);
    expect(searchSettings("minimap").map((s) => s.key)).toContain("editor.minimap");
    expect(searchSettings("autonomy").map((s) => s.key)).toContain("agent.autonomy");
    expect(searchSettings("zzzz")).toEqual([]);
  });
});
