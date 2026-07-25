import { test, expect } from "vitest";
import fc from "fast-check";
import { upsertWorkspaceServer, parseMcpConfig, type McpServer } from "../mcp-config";

// Feature: mcp-host-and-servers, Property 26: Settings write preservation and override
// Validates: Requirements 13.8, 13.9
test("workspace upsert replaces only the target and preserves other entries", () => {
  fc.assert(
    fc.property(
      fc.dictionary(
        fc.constantFrom("a", "b", "c", "d"),
        fc.record({ command: fc.constantFrom("python", "node", "deno", "run.sh", "srv-a") }),
      ),
      fc.constantFrom("a", "b", "c", "x"),
      (wsMap, targetId) => {
        const workspaceText = JSON.stringify({ mcpServers: wsMap });
        // Editing a *user*-scoped definition still writes a workspace override.
        const server: McpServer = {
          id: targetId,
          transport: "stdio",
          command: "newcmd",
          args: [],
          env: {},
          autoApprove: ["t"],
          disabled: false,
          scope: "user",
        };
        const result = upsertWorkspaceServer(workspaceText, server);
        const parsed = parseMcpConfig(result, "workspace");
        const byId = new Map(parsed.map((s) => [s.id, s]));

        // The target entry is written as a workspace override with the new command.
        expect(byId.get(targetId)?.command).toBe("newcmd");
        expect(byId.get(targetId)?.scope).toBe("workspace");
        // Every other original (valid) entry is preserved unchanged.
        for (const id of Object.keys(wsMap)) {
          if (id !== targetId) {
            expect(byId.has(id)).toBe(true);
            expect(byId.get(id)?.command).toBe((wsMap[id] as { command: string }).command);
          }
        }
      },
    ),
    { numRuns: 200 },
  );
});
