/** Property 70 edit half: an in-place edit writes only the originating file (R30.2). */
/** Feature: zoc-agent-chat-rebuild, Property 70 (R30.2, R30.3, R30.5). */

import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { persistRuleEdit, ruleOriginPath } from "../rules/rules-editor-model";

describe("Property 70: rules edits persist to the originating file", () => {
  it("resolves every safe relative source under its workspace and writes that exact path", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc
            .stringMatching(/^[A-Za-z0-9_.-]+$/u)
            .filter((segment) => segment !== "." && segment !== ".."),
          { minLength: 1, maxLength: 8 },
        ),
        fc.string({ maxLength: 500 }),
        async (segments, content) => {
          const relative = segments.join("/");
          const write = vi.fn(async () => true);
          await expect(
            persistRuleEdit({ workspaceRoot: "/workspace", path: relative, content, write }),
          ).resolves.toBe(true);
          expect(write).toHaveBeenCalledWith(ruleOriginPath("/workspace", relative), content);
        },
      ),
      { numRuns: 120 },
    );
  });

  it("refuses traversal and absolute paths before the writer is reached", async () => {
    for (const path of ["../AGENTS.md", "rules/../../secret", "/etc/passwd", "C:\\secret.txt"]) {
      const write = vi.fn(async () => true);
      expect(ruleOriginPath("/workspace", path)).toBeNull();
      await expect(
        persistRuleEdit({ workspaceRoot: "/workspace", path, content: "x", write }),
      ).resolves.toBe(false);
      expect(write).not.toHaveBeenCalled();
    }
  });
});
