import { describe, expect, it } from "vitest";
import {
  SLASH_COMMANDS,
  matchSlash,
  resolveSlashCommand,
} from "../slash-commands";

function command(name: (typeof SLASH_COMMANDS)[number]["name"]) {
  return SLASH_COMMANDS.find((item) => item.name === name)!;
}

describe("composer slash commands", () => {
  it("shows only the five Composer prompt commands", () => {
    expect(SLASH_COMMANDS.map((item) => item.name)).toEqual([
      "explain",
      "test",
      "fix",
      "document",
      "refactor",
    ]);
    expect(matchSlash("/doc").map((item) => item.name)).toEqual(["document"]);
  });

  it("resolves selection commands with the correct modes and selected code", () => {
    expect(
      resolveSlashCommand(command("explain"), {
        activeFile: "/src/App.tsx",
        selectedCode: "const answer = 42;",
      }),
    ).toEqual({
      mode: "ask",
      prompt: "Explain how the selected code works:\n\nconst answer = 42;",
      contextFile: null,
    });
    expect(
      resolveSlashCommand(command("refactor"), {
        activeFile: "/src/App.tsx",
        selectedCode: "function run() {}",
      }),
    ).toEqual({
      mode: "agent",
      prompt: "Refactor the selected code for readability:\n\nfunction run() {}",
      contextFile: null,
    });
  });

  it.each([
    ["test", "Write tests for @App.tsx"],
    ["fix", "Fix all lint errors in @App.tsx"],
    ["document", "Add JSDoc/docstrings to @App.tsx"],
  ] as const)("resolves /%s against the current file", (name, prompt) => {
    expect(
      resolveSlashCommand(command(name), {
        activeFile: "/src/App.tsx",
        selectedCode: null,
      }),
    ).toEqual({
      mode: "agent",
      prompt,
      contextFile: { token: "App.tsx", path: "/src/App.tsx" },
    });
  });

  it("uses readable fallbacks when editor context is unavailable", () => {
    expect(
      resolveSlashCommand(command("explain"), {
        activeFile: null,
        selectedCode: null,
      }).prompt,
    ).toBe("Explain how the selected code works");
    expect(
      resolveSlashCommand(command("test"), {
        activeFile: null,
        selectedCode: null,
      }),
    ).toEqual({
      mode: "agent",
      prompt: "Write tests for the current file",
      contextFile: null,
    });
  });

  it("bounds very large editor selections", () => {
    const result = resolveSlashCommand(command("explain"), {
      activeFile: "/src/App.tsx",
      selectedCode: "x".repeat(9_000),
    });
    expect(result.prompt).toContain("x".repeat(8_000));
    expect(result.prompt).toContain("selection truncated");
    expect(result.prompt).not.toContain("x".repeat(8_001));
  });
});
