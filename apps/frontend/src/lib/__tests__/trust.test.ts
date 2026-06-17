import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetTrustForTests,
  addToAllowlist,
  checkAction,
  clearAuditLog,
  getAuditLog,
  getTrustConfig,
  removeFromAllowlist,
  setProtection,
  setRunMode,
  setTrust,
} from "@/lib/trust";

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

describe("trust config + audit", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeStorage());
    __resetTrustForTests();
  });
  afterAll(() => {
    vi.stubGlobal("localStorage", realLocalStorage);
    __resetTrustForTests();
  });

  it("defaults to a restricted, ask-every-time workspace", () => {
    const c = getTrustConfig();
    expect(c.trust).toBe("restricted");
    expect(c.runMode).toBe("ask");
    expect(c.protectDeletions).toBe(true);
  });

  it("persists config changes", () => {
    setTrust("trusted");
    setRunMode("allowlist");
    setProtection("protectDotfiles", false);
    __resetTrustForTests(); // simulate reload (localStorage retained)
    const c = getTrustConfig();
    expect(c.trust).toBe("trusted");
    expect(c.runMode).toBe("allowlist");
    expect(c.protectDotfiles).toBe(false);
  });

  it("adds/removes allowlist entries without duplicates", () => {
    addToAllowlist("commandAllowlist", "npm test");
    addToAllowlist("commandAllowlist", "npm test"); // dup ignored
    addToAllowlist("commandAllowlist", "  "); // blank ignored
    expect(getTrustConfig().commandAllowlist).toEqual(["npm test"]);
    removeFromAllowlist("commandAllowlist", "npm test");
    expect(getTrustConfig().commandAllowlist).toEqual([]);
  });

  it("checkAction records every decision in the audit log", () => {
    setTrust("restricted");
    const denied = checkAction({ kind: "terminal", name: "ls" });
    expect(denied.effect).toBe("deny");

    setTrust("trusted");
    setRunMode("all");
    const allowed = checkAction({ kind: "terminal", name: "ls" });
    expect(allowed.effect).toBe("allow");

    const log = getAuditLog();
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ kind: "terminal", name: "ls", effect: "deny" });
    expect(log[1]).toMatchObject({ effect: "allow" });
  });

  it("clearAuditLog empties the log", () => {
    checkAction({ kind: "task", name: "x" });
    expect(getAuditLog().length).toBeGreaterThan(0);
    clearAuditLog();
    expect(getAuditLog()).toEqual([]);
  });
});
