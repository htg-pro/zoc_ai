import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUILTIN_PROFILES,
  activeProfileId,
  applyProfile,
  exportProfile,
  importProfile,
  parseProfileExport,
  profileFor,
} from "@/lib/profiles";
import { getSetting, loadScope } from "@/lib/settings";
import { loadOverrides } from "@/lib/keybinding-overrides";

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

describe("profiles", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeStorage());
  });
  afterAll(() => {
    vi.stubGlobal("localStorage", realLocalStorage);
  });

  it("ships the four required profiles", () => {
    expect(BUILTIN_PROFILES.map((p) => p.id).sort()).toEqual([
      "cloud-agent",
      "default",
      "local-first",
      "strict-approval",
    ]);
  });

  it("applies a profile into the user scope and records it active", () => {
    applyProfile("strict-approval");
    expect(getSetting("agent.defaultMode")).toBe("ask");
    expect(getSetting("agent.autonomy")).toBe("Low");
    expect(activeProfileId()).toBe("strict-approval");

    applyProfile("cloud-agent");
    expect(getSetting("editor.minimap")).toBe(true);
    expect(getSetting("agent.autonomy")).toBe("High");
    expect(activeProfileId()).toBe("cloud-agent");
  });

  it("defaults to the default profile when none is recorded", () => {
    expect(activeProfileId()).toBe("default");
    expect(profileFor("default")).toBeDefined();
    expect(profileFor("nope")).toBeUndefined();
  });

  it("exports and imports settings + keybindings round-trip", () => {
    applyProfile("local-first");
    const json = exportProfile();
    const parsed = parseProfileExport(json);
    expect(parsed.version).toBe(1);
    expect(parsed.settings["agent.autonomy"]).toBe("Medium");

    // Fresh storage, then import.
    vi.stubGlobal("localStorage", fakeStorage());
    importProfile(json);
    expect(getSetting("agent.autonomy")).toBe("Medium");
    expect(loadScope("user")["editor.stickyScroll"]).toBe(true);
  });

  it("import sanitizes unknown/invalid keys", () => {
    importProfile(
      JSON.stringify({
        version: 1,
        settings: { "agent.autonomy": "Low", "bad.key": 1, "editor.fontSize": 999 },
        keybindings: { "x.cmd": "mod+k", "y.cmd": "garbage+" },
      }),
    );
    expect(getSetting("agent.autonomy")).toBe("Low");
    expect(loadScope("user")["bad.key" as never]).toBeUndefined();
    expect(getSetting("editor.fontSize")).toBe(13); // 999 rejected → default
    expect(loadOverrides()).toEqual({ "x.cmd": "mod+k" });
  });

  it("throws on malformed JSON", () => {
    expect(() => parseProfileExport("{ nope")).toThrow();
  });
});
