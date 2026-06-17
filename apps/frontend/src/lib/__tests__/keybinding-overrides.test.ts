import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "@/lib/commands";
import {
  detectConflicts,
  effectiveKeybinding,
  exportKeybindings,
  isValidChord,
  loadOverrides,
  parseKeybindingsJson,
  resetOverride,
  sanitizeOverrides,
  setOverride,
  wouldConflict,
} from "@/lib/keybinding-overrides";

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

function cmd(id: string, keybinding?: string): Command {
  return { id, title: id, category: "Editor", keybinding, run: () => undefined };
}

describe("keybinding-overrides", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeStorage());
  });
  afterAll(() => {
    vi.stubGlobal("localStorage", realLocalStorage);
  });

  it("validates chords", () => {
    expect(isValidChord("mod+shift+p")).toBe(true);
    expect(isValidChord("mod+g")).toBe(true);
    expect(isValidChord("g")).toBe(true); // single key, no modifier required by grammar
    expect(isValidChord("mod+shift")).toBe(false); // no real key
    expect(isValidChord("")).toBe(false);
    expect(isValidChord("ctrl+x")).toBe(false); // "ctrl" is not a known token (use "mod")
  });

  it("sanitizeOverrides keeps valid chords and explicit unbinds only", () => {
    expect(
      sanitizeOverrides({ a: "mod+k", b: null, c: "bad+", d: 42 }),
    ).toEqual({ a: "mod+k", b: null });
  });

  it("effectiveKeybinding prefers an override and honors explicit unbind", () => {
    const c = cmd("x", "mod+p");
    expect(effectiveKeybinding(c, {})).toBe("mod+p");
    expect(effectiveKeybinding(c, { x: "mod+shift+p" })).toBe("mod+shift+p");
    expect(effectiveKeybinding(c, { x: null })).toBeUndefined();
  });

  it("set/reset overrides persist", () => {
    setOverride("x", "mod+k");
    expect(loadOverrides()).toEqual({ x: "mod+k" });
    setOverride("y", null);
    expect(loadOverrides()).toEqual({ x: "mod+k", y: null });
    resetOverride("x");
    expect(loadOverrides()).toEqual({ y: null });
  });

  it("rejects invalid chord assignments", () => {
    setOverride("x", "mod+shift"); // invalid → ignored
    expect(loadOverrides()).toEqual({});
  });

  it("detectConflicts finds chords bound to multiple commands", () => {
    const commands = [cmd("a", "mod+p"), cmd("b", "mod+p"), cmd("c", "mod+g")];
    const conflicts = detectConflicts(commands, {});
    expect(conflicts).toEqual([{ chord: "mod+p", commandIds: ["a", "b"] }]);
  });

  it("detectConflicts respects overrides (resolving and creating conflicts)", () => {
    const commands = [cmd("a", "mod+p"), cmd("b", "mod+p")];
    // Re-bind b away → no conflict.
    expect(detectConflicts(commands, { b: "mod+g" })).toEqual([]);
    // Unbind a → no conflict.
    expect(detectConflicts(commands, { a: null })).toEqual([]);
  });

  it("wouldConflict lists colliding commands for a proposed chord", () => {
    const commands = [cmd("a", "mod+p"), cmd("b", "mod+g")];
    expect(wouldConflict(commands, "b", "mod+p")).toEqual(["a"]);
    expect(wouldConflict(commands, "b", "mod+j")).toEqual([]);
  });

  it("exports and parses JSON round-trip", () => {
    setOverride("x", "mod+k");
    const json = exportKeybindings();
    expect(parseKeybindingsJson(json)).toEqual({ x: "mod+k" });
    expect(() => parseKeybindingsJson("{ not json")).toThrow();
  });
});
