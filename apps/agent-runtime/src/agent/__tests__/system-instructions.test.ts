/**
 * System-instruction assembler tests — zoc-agent-chat-rebuild R30.1, R30.3, R30.4.
 * Part of task 9.10's unit suite: precedence order across the four source tiers,
 * root before nested, and a malformed source skipped with the rest still applied.
 *
 * The contract block at the bottom is the one that matters most over time: it pins
 * this runtime copy of the classifier to the renderer's, because the whole reason
 * the copy exists is that the Rules display and the prompt must not be able to
 * disagree. A copy with no drift guard is just two implementations.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  BASE_INSTRUCTIONS,
  MAX_RULES_CHARS,
  MAX_SOURCE_CHARS,
  assembleInstructions,
  type RuleDocument,
} from "../system-instructions.ts";
import { classifyRuleSource, classifyRuleSources } from "../rules-sources.ts";
// The renderer's original. Imported here *only* to assert the copy agrees with
// it; nothing in `src/` imports across the app boundary.
import { classifyRuleSources as rendererClassify } from "../../../../frontend/src/lib/rules-sources.ts";

const RUNS = { numRuns: 200 } as const;

const facts = {
  sessionId: "sess_1",
  workspaceRoot: "/home/dev/project",
  permissionMode: "ask",
  conversationMode: "agent",
  testCommand: "pnpm test",
};

function from(documents: readonly RuleDocument[]) {
  return assembleInstructions({ ...facts, discoverRules: async () => documents });
}

const doc = (path: string, content: string | null = `rule for ${path}`): RuleDocument => ({
  path,
  content,
});

describe("assembleInstructions: ordering (R30.3)", () => {
  it("orders zoc → cursor → agents → other, root before nested, then alphabetical", async () => {
    const result = await from([
      doc("docs/CONVENTIONS.md"),
      doc("packages/api/AGENTS.md"),
      doc("AGENTS.md"),
      doc("src/.zoc/rules/nested.md"),
      doc(".zoc/rules/style.md"),
      doc(".cursor/rules/general.mdc"),
      doc(".zoc/rules/architecture.md"),
      doc("pkg/.cursor/rules/x.mdc"),
    ]);

    expect(result.appliedSources).toEqual([
      ".zoc/rules/architecture.md",
      ".zoc/rules/style.md",
      "src/.zoc/rules/nested.md",
      ".cursor/rules/general.mdc",
      "pkg/.cursor/rules/x.mdc",
      "AGENTS.md",
      "packages/api/AGENTS.md",
      "docs/CONVENTIONS.md",
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("merges rule text in exactly the order it reports as applied", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(
          fc.constantFrom(
            ".zoc/rules/a.md",
            ".zoc/rules/b.md",
            "sub/.zoc/rules/c.md",
            ".cursor/rules/d.mdc",
            "AGENTS.md",
            "pkg/AGENTS.md",
            "docs/e.md",
          ),
          { minLength: 1, maxLength: 7 },
        ),
        async (paths) => {
          const result = await from(paths.map((path) => doc(path)));
          expect([...result.appliedSources]).toEqual(
            classifyRuleSources(paths).map((source) => source.path),
          );

          // Position in the prompt must follow the applied order, or precedence is
          // a claim the prompt does not actually make.
          const positions = result.appliedSources.map((path) =>
            result.instructions.indexOf(`rule for ${path}`),
          );
          expect(positions.every((p) => p >= 0)).toBe(true);
          expect(positions).toEqual([...positions].sort((a, b) => a - b));
        },
      ),
      RUNS,
    );
  });

  it("collapses a duplicate path rather than applying its text twice", async () => {
    const result = await from([doc(".zoc/rules/a.md"), doc(".zoc/rules/a.md")]);
    expect(result.appliedSources).toEqual([".zoc/rules/a.md"]);
    expect(
      result.instructions.split("rule for .zoc/rules/a.md").length - 1,
    ).toBe(1);
  });
});

describe("assembleInstructions: a malformed source is skipped, never fatal (R30.3)", () => {
  it("applies every well-formed source and reports each rejection with a reason", async () => {
    const result = await from([
      doc(".zoc/rules/good.md"),
      { path: ".zoc/rules/unreadable.md", content: null, error: "Permission denied." },
      doc(".zoc/rules/empty.md", "   \n\t "),
      doc(".zoc/rules/binary.md", "text\u0000more"),
      { path: "  ", content: "orphan" },
      doc("AGENTS.md"),
    ]);

    expect(result.appliedSources).toEqual([".zoc/rules/good.md", "AGENTS.md"]);
    expect(
      Object.fromEntries(result.skipped.map((s) => [s.path, s.reason])),
    ).toEqual({
      ".zoc/rules/unreadable.md": "Permission denied.",
      ".zoc/rules/empty.md": "The source is empty.",
      ".zoc/rules/binary.md": "The source is not UTF-8 text.",
      "  ": "The source has no path.",
    });
    // The Run still has usable instructions — that is the "never fatal" part.
    expect(result.instructions).toContain(BASE_INSTRUCTIONS);
    expect(result.instructions).toContain("rule for .zoc/rules/good.md");
  });

  it("never throws and always returns usable instructions, for any document set", async () => {
    const anyDocument: fc.Arbitrary<RuleDocument> = fc.record({
      path: fc.oneof(
        fc.constantFrom(".zoc/rules/a.md", "AGENTS.md", ".cursor/rules/b.mdc", "x.md"),
        fc.string(),
      ),
      content: fc.oneof(fc.string(), fc.constant(null)),
      error: fc.oneof(fc.constant(null), fc.string({ maxLength: 12 })),
    });

    await fc.assert(
      fc.asyncProperty(fc.array(anyDocument, { maxLength: 20 }), async (documents) => {
        const result = await from(documents);
        expect(result.instructions).toContain(BASE_INSTRUCTIONS);
        expect(result.instructions).toContain(facts.workspaceRoot);
        // Applied and skipped partition the discovered set: a source that is
        // neither reported nor applied has silently vanished, which is the bug
        // that makes R30.4's display lie.
        const accounted = new Set([
          ...result.appliedSources,
          ...result.skipped.map((s) => s.path),
        ]);
        for (const document of documents) {
          const key = typeof document.path === "string" ? document.path : "(unnamed)";
          expect(accounted.has(key)).toBe(true);
        }
        expect(new Set(result.appliedSources).size).toBe(result.appliedSources.length);
      }),
      RUNS,
    );
  });

  it("survives discovery itself failing, recording the reason", async () => {
    const result = await assembleInstructions({
      ...facts,
      discoverRules: () => Promise.reject(new Error("Workspace_Services is restarting.")),
    });
    expect(result.appliedSources).toEqual([]);
    expect(result.skipped).toEqual([
      { path: "(discovery)", reason: "Workspace_Services is restarting." },
    ]);
    // A Run with no rules is a valid Run.
    expect(result.instructions).toContain(BASE_INSTRUCTIONS);
    expect(result.instructions).not.toContain("# Project rules");
  });
});

describe("assembleInstructions: budgets and workspace facts", () => {
  it("truncates an oversized source and says so, rather than dropping it", async () => {
    const result = await from([doc(".zoc/rules/big.md", "x".repeat(MAX_SOURCE_CHARS + 500))]);
    expect(result.appliedSources).toEqual([".zoc/rules/big.md"]);
    expect(result.skipped).toEqual([
      { path: ".zoc/rules/big.md", reason: `Truncated at ${MAX_SOURCE_CHARS} characters.` },
    ]);
    expect(result.instructions).toContain("[truncated]");
  });

  it("stops at the merged budget instead of emitting an unbounded prompt", async () => {
    const big = "y".repeat(MAX_SOURCE_CHARS);
    const paths = Array.from({ length: 6 }, (_, i) => `.zoc/rules/${i}.md`);
    const result = await from(paths.map((path) => doc(path, big)));

    expect(result.appliedSources.length).toBeLessThan(paths.length);
    expect(result.instructions.length).toBeLessThan(MAX_RULES_CHARS + 4_000);
    for (const path of paths.slice(result.appliedSources.length)) {
      expect(result.skipped.some((s) => s.path === path)).toBe(true);
    }
  });

  it("puts the workspace facts last, after any project rules", async () => {
    const result = await from([doc(".zoc/rules/a.md")]);
    expect(result.instructions.indexOf("# Project rules")).toBeLessThan(
      result.instructions.indexOf("# Workspace"),
    );
    expect(result.instructions).toContain(`- Workspace root: ${facts.workspaceRoot}`);
    expect(result.instructions).toContain("- Permission mode: ask");
    expect(result.instructions).toContain("- Project test command: pnpm test");
  });

  it("says no test command was detected rather than implying one", async () => {
    const result = await assembleInstructions({
      ...facts,
      testCommand: null,
      discoverRules: async () => [],
    });
    expect(result.instructions).toContain("none detected");
  });
});

describe("rules-sources: the runtime copy agrees with the renderer (R30.3)", () => {
  it("produces an identical order for any path set", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.constantFrom(
              ".zoc/rules/a.md",
              ".zoc/rules/Z.md",
              "src/.zoc/rules/n.md",
              ".cursor/rules/c.mdc",
              "pkg/.cursor/rules/c.mdc",
              "AGENTS.md",
              "deep/nest/AGENTS.md",
              "docs/x.md",
              "./AGENTS.md",
              "/.zoc/rules/root.md",
              "pkg\\.cursor\\rules\\w.mdc",
            ),
            fc.string({ maxLength: 10 }),
          ),
          { maxLength: 14 },
        ),
        (paths) => {
          // Drift between the two is a prompt that disagrees with the Rules
          // display about precedence — invisible in both, wrong in one.
          expect(classifyRuleSources(paths)).toEqual(rendererClassify([...paths]));
        },
      ),
      RUNS,
    );
  });

  it("classifies each convention, and nesting, the way the renderer does", () => {
    expect(classifyRuleSource(".zoc/rules/style.md")).toMatchObject({
      kind: "zoc",
      nested: false,
      label: ".zoc/rules",
    });
    expect(classifyRuleSource(".cursor/rules/general.mdc")).toMatchObject({
      kind: "cursor",
      nested: false,
    });
    expect(classifyRuleSource("AGENTS.md")).toMatchObject({ kind: "agents", nested: false });
    expect(classifyRuleSource("packages/api/AGENTS.md").nested).toBe(true);
    expect(classifyRuleSource("src/.zoc/rules/x.md").nested).toBe(true);
    expect(classifyRuleSource("docs/CONVENTIONS.md")).toMatchObject({ kind: "other" });
    expect(classifyRuleSource("pkg\\.cursor\\rules\\x.mdc")).toMatchObject({
      kind: "cursor",
      nested: true,
    });
  });
});
