import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERMISSION_CONFIG,
  evaluatePermission,
  isDotfile,
  isExternalPath,
  matchesAllowlist,
  type PermissionConfig,
} from "@/lib/permissions-engine";

function cfg(over: Partial<PermissionConfig> = {}): PermissionConfig {
  return { ...DEFAULT_PERMISSION_CONFIG, trust: "trusted", runMode: "ask", ...over };
}

describe("path helpers", () => {
  it("isDotfile checks the final segment", () => {
    expect(isDotfile("src/.env")).toBe(true);
    expect(isDotfile(".gitignore")).toBe(true);
    expect(isDotfile("src/index.ts")).toBe(false);
    expect(isDotfile(undefined)).toBe(false);
  });

  it("isExternalPath compares against the workspace root", () => {
    expect(isExternalPath("/etc/passwd", "/ws")).toBe(true);
    expect(isExternalPath("/ws/src/a.ts", "/ws")).toBe(false);
    expect(isExternalPath("src/a.ts", "/ws")).toBe(false);
    expect(isExternalPath("../outside/a.ts", "/ws")).toBe(true);
    expect(isExternalPath("/abs", null)).toBe(true); // no root → absolute is external
  });

  it("matchesAllowlist supports exact and prefix matches", () => {
    expect(matchesAllowlist(["npm run build"], "npm run build")).toBe(true);
    expect(matchesAllowlist(["git"], "git status")).toBe(true);
    expect(matchesAllowlist(["git"], "github")).toBe(false);
    expect(matchesAllowlist([], "anything")).toBe(false);
  });
});

describe("evaluatePermission — trust gate", () => {
  it("blocks execution kinds in a restricted workspace", () => {
    const c = cfg({ trust: "restricted" });
    for (const kind of ["terminal", "task", "plugin", "agent_tool", "mcp", "git"] as const) {
      expect(evaluatePermission(c, { kind, name: "x" }).effect).toBe("deny");
    }
  });

  it("still allows read-only actions when restricted", () => {
    const c = cfg({ trust: "restricted" });
    expect(evaluatePermission(c, { kind: "fs", name: "read", readOnly: true }).effect).toBe("allow");
  });
});

describe("evaluatePermission — protections", () => {
  it("prompts on protected deletion", () => {
    const d = evaluatePermission(cfg(), { kind: "fs", name: "rm", target: "a.ts", destructive: true });
    expect(d.effect).toBe("prompt");
  });

  it("prompts on dotfile edits", () => {
    expect(evaluatePermission(cfg(), { kind: "fs", name: "write", target: ".env" }).effect).toBe("prompt");
  });

  it("prompts on external paths", () => {
    const d = evaluatePermission(cfg(), { kind: "fs", name: "write", target: "/etc/hosts" }, "/ws");
    expect(d.effect).toBe("prompt");
  });

  it("allows a normal in-workspace write when protections don't trigger", () => {
    const d = evaluatePermission(
      cfg({ runMode: "all" }),
      { kind: "fs", name: "write", target: "/ws/src/a.ts" },
      "/ws",
    );
    expect(d.effect).toBe("allow");
  });
});

describe("evaluatePermission — destructive needs confirm or allowlist", () => {
  it("prompts for a destructive command even in run-everything mode", () => {
    const d = evaluatePermission(cfg({ runMode: "all" }), {
      kind: "terminal",
      name: "rm -rf build",
      destructive: true,
    });
    expect(d.effect).toBe("prompt");
  });

  it("allows a destructive command that is allowlisted", () => {
    const d = evaluatePermission(
      cfg({ runMode: "all", commandAllowlist: ["rm -rf build"] }),
      { kind: "terminal", name: "rm -rf build", destructive: true },
    );
    expect(d.effect).toBe("allow");
  });
});

describe("evaluatePermission — network", () => {
  it("prompts when host is not allowlisted", () => {
    const d = evaluatePermission(cfg(), { kind: "agent_tool", name: "fetch", network: true, host: "evil.com" });
    expect(d.effect).toBe("prompt");
  });
  it("allows an allowlisted host (and proceeds to run mode)", () => {
    const d = evaluatePermission(
      cfg({ runMode: "all", networkAllowlist: ["api.github.com"] }),
      { kind: "agent_tool", name: "fetch", network: true, host: "api.github.com" },
    );
    expect(d.effect).toBe("allow");
  });
});

describe("evaluatePermission — run modes", () => {
  it("ask prompts unless allowlisted", () => {
    expect(evaluatePermission(cfg({ runMode: "ask" }), { kind: "terminal", name: "ls" }).effect).toBe("prompt");
    expect(
      evaluatePermission(cfg({ runMode: "ask", commandAllowlist: ["ls"] }), { kind: "terminal", name: "ls" }).effect,
    ).toBe("allow");
  });

  it("allowlist mode allows listed, prompts otherwise", () => {
    const c = cfg({ runMode: "allowlist", commandAllowlist: ["npm test"] });
    expect(evaluatePermission(c, { kind: "task", name: "npm test" }).effect).toBe("allow");
    expect(evaluatePermission(c, { kind: "task", name: "npm run deploy" }).effect).toBe("prompt");
  });

  it("sandboxed mode allows sandboxable actions, prompts otherwise", () => {
    const c = cfg({ runMode: "sandboxed" });
    expect(evaluatePermission(c, { kind: "agent_tool", name: "edit", sandboxable: true }).effect).toBe("allow");
    expect(evaluatePermission(c, { kind: "terminal", name: "make" }).effect).toBe("prompt");
  });

  it("all mode allows non-destructive actions", () => {
    expect(evaluatePermission(cfg({ runMode: "all" }), { kind: "terminal", name: "ls" }).effect).toBe("allow");
  });
});
