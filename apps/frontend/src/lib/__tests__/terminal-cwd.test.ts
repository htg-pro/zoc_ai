/**
 * Terminal cwd selection, covering the five situations the product hits.
 *
 * The bug these guard against: the spawn call used `...(cwd ? { cwd } : {})`, so
 * a null workspace root silently omitted `cwd` and the sidecar started the shell
 * in its own directory — the application's install/bin path in a packaged build.
 */
import { describe, expect, it } from "vitest";

import { normalizeRoot, resolveTerminalCwd, terminalMatchesWorkspace } from "../terminal-cwd";

describe("resolveTerminalCwd", () => {
  it("uses the workspace root when a workspace is open", () => {
    const decision = resolveTerminalCwd("/home/dev/project");
    expect(decision).toEqual({ ok: true, cwd: "/home/dev/project" });
  });

  it("refuses when no workspace is open instead of defaulting anywhere", () => {
    for (const root of [null, undefined, "", "   "]) {
      const decision = resolveTerminalCwd(root);
      expect(decision.ok).toBe(false);
      if (!decision.ok) {
        expect(decision.reason).toBe("no-workspace");
        expect(decision.message).toContain("Open a project folder");
      }
    }
  });

  it("never resolves to a relative or app-relative directory", () => {
    // A refusal carries no cwd at all, so there is nothing to fall back to.
    const decision = resolveTerminalCwd(null);
    expect("cwd" in decision).toBe(false);
  });
});

describe("terminalMatchesWorkspace", () => {
  it("reuses a terminal already rooted in the active workspace", () => {
    expect(terminalMatchesWorkspace("/ws/a", "/ws/a")).toBe(true);
  });

  it("ignores a trailing separator difference", () => {
    expect(terminalMatchesWorkspace("/ws/a/", "/ws/a")).toBe(true);
    expect(terminalMatchesWorkspace("/ws/a", "/ws/a/")).toBe(true);
  });

  it("refuses to reuse a terminal from the previous workspace", () => {
    // The shell is still sitting in the old project, so every later command
    // would target the wrong tree.
    expect(terminalMatchesWorkspace("/ws/a", "/ws/b")).toBe(false);
  });

  it("refuses to reuse a terminal whose root is unknown", () => {
    expect(terminalMatchesWorkspace(null, "/ws/a")).toBe(false);
  });

  it("refuses any reuse when no workspace is open", () => {
    expect(terminalMatchesWorkspace("/ws/a", null)).toBe(false);
  });

  it("does not confuse a sibling with a prefix-matching name", () => {
    expect(terminalMatchesWorkspace("/ws/app", "/ws/app-2")).toBe(false);
  });
});

describe("normalizeRoot", () => {
  it("keeps the filesystem root intact", () => {
    expect(normalizeRoot("/")).toBe("/");
  });

  it("strips trailing separators", () => {
    expect(normalizeRoot("/ws/a///")).toBe("/ws/a");
    expect(normalizeRoot("C:\\ws\\a\\")).toBe("C:\\ws\\a");
  });
});
