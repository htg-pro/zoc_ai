/** Property 70: rules selection determines the next Run's instructions (R30.2/R30.3/R30.5). */
/** Feature: zoc-agent-chat-rebuild, Property 70 (R30.2, R30.3, R30.5). */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { assembleInstructions } from "../system-instructions.ts";
import { classifyRuleSources } from "../rules-sources.ts";

describe("Property 70: rules selection determines the next Run's instructions", () => {
  it("includes exactly enabled, well-formed sources and locates every parse error", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(
          fc.record({
            id: fc.stringMatching(/^[a-z][a-z0-9]{0,12}$/u),
            enabled: fc.boolean(),
            malformed: fc.boolean(),
          }),
          { selector: (row) => row.id, maxLength: 30 },
        ),
        async (rows) => {
          const documents = rows.map((row) => ({
            path: `.zoc/rules/${row.id}.md`,
            content: row.malformed
              ? `---\nbroken frontmatter\n---\nRULE(${row.id})`
              : `RULE(${row.id})`,
            error: null,
          }));
          const enabledSources = Object.fromEntries(
            rows.map((row) => [`.zoc/rules/${row.id}.md`, row.enabled]),
          );
          const assembled = await assembleInstructions({
            sessionId: "session-1",
            discoverRules: async () => documents,
            workspaceRoot: "/workspace",
            permissionMode: "ask",
            conversationMode: "agent",
            enabledSources,
          });

          const expected = classifyRuleSources(
            rows
              .filter((row) => row.enabled && !row.malformed)
              .map((row) => `.zoc/rules/${row.id}.md`),
          ).map((source) => source.path);
          expect(assembled.appliedSources).toEqual(expected);

          for (const row of rows) {
            const marker = `RULE(${row.id})`;
            expect(assembled.instructions.includes(marker)).toBe(row.enabled && !row.malformed);
            if (row.enabled && row.malformed) {
              expect(assembled.skipped).toContainEqual({
                path: `.zoc/rules/${row.id}.md`,
                reason: expect.stringContaining("Line 2, column 1"),
              });
            }
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});
