import { describe, expect, it } from "vitest";
import {
  classifyRuleSource,
  classifyRuleSources,
  summarizeRuleSources,
} from "@/lib/rules-sources";

describe("classifyRuleSource", () => {
  it("recognizes .zoc/rules", () => {
    expect(classifyRuleSource(".zoc/rules/style.md")).toMatchObject({
      kind: "zoc",
      nested: false,
      label: ".zoc/rules",
    });
  });

  it("recognizes .cursor/rules (compatibility)", () => {
    expect(classifyRuleSource(".cursor/rules/general.mdc")).toMatchObject({
      kind: "cursor",
      label: ".cursor/rules",
    });
  });

  it("recognizes AGENTS.md", () => {
    expect(classifyRuleSource("AGENTS.md")).toMatchObject({
      kind: "agents",
      nested: false,
      label: "AGENTS.md",
    });
  });

  it("flags nested rules in subdirectories", () => {
    expect(classifyRuleSource("packages/api/AGENTS.md").nested).toBe(true);
    expect(classifyRuleSource("packages/api/.cursor/rules/x.mdc").nested).toBe(true);
    expect(classifyRuleSource("src/.zoc/rules/x.md").nested).toBe(true);
  });

  it("falls back to other for unknown sources", () => {
    expect(classifyRuleSource("docs/CONVENTIONS.md")).toMatchObject({
      kind: "other",
      label: "CONVENTIONS.md",
    });
  });

  it("handles Windows separators", () => {
    expect(classifyRuleSource("pkg\\.cursor\\rules\\x.mdc")).toMatchObject({
      kind: "cursor",
      nested: true,
    });
  });
});

describe("classifyRuleSources ordering", () => {
  it("orders zoc → cursor → agents → other, root before nested", () => {
    const sorted = classifyRuleSources([
      "docs/other.md",
      "pkg/AGENTS.md",
      "AGENTS.md",
      ".cursor/rules/a.mdc",
      ".zoc/rules/a.md",
    ]);
    expect(sorted.map((s) => s.kind)).toEqual(["zoc", "cursor", "agents", "agents", "other"]);
    // AGENTS.md (root) before pkg/AGENTS.md (nested)
    const agents = sorted.filter((s) => s.kind === "agents");
    expect(agents[0].nested).toBe(false);
    expect(agents[1].nested).toBe(true);
  });
});

describe("summarizeRuleSources", () => {
  it("summarizes counts and nested", () => {
    expect(summarizeRuleSources([])).toBe("No project rules");
    const one = classifyRuleSources([".zoc/rules/a.md"]);
    expect(summarizeRuleSources(one)).toBe("1 rule source");
    const withNested = classifyRuleSources([".zoc/rules/a.md", "pkg/AGENTS.md"]);
    expect(summarizeRuleSources(withNested)).toBe("2 rule sources (1 nested)");
  });
});
