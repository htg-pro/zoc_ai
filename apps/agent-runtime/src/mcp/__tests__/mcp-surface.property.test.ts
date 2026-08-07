/**
 * Properties 63–65: MCP naming, enable-set registration, and server isolation.
 * Feature: zoc-agent-chat-rebuild, Properties 63-65 (R26.2, R26.3, R26.6).
 * Validates R26.2, R26.3, and R26.6.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { McpControl, mcpToolName, type McpToolView } from "../control.ts";
import { buildToolDescriptors } from "../../tools/registry.ts";
import type {
  McpDiscoveredTool,
  McpServerRuntime,
  WorkspaceClient,
} from "../../tools/workspace-client.ts";

const RUNS = { numRuns: 200 } as const;
const segment = fc.string({ maxLength: 24 });

const workspaceStub = {
  callMcp: async () => ({ ok: true as const, value: {} }),
} as unknown as WorkspaceClient;

describe("Property 63: MCP tool names are unique and server-qualified (R26.2)", () => {
  it("is injective over arbitrary server/tool names", () => {
    fc.assert(
      fc.property(segment, segment, segment, segment, (serverA, toolA, serverB, toolB) => {
        fc.pre(serverA !== serverB || toolA !== toolB);
        const left = mcpToolName(serverA, toolA);
        const right = mcpToolName(serverB, toolB);
        expect(left).toMatch(/^mcp__/u);
        expect(right).toMatch(/^mcp__/u);
        expect(left).not.toBe(right);
      }),
      RUNS,
    );
  });

  it("changes the registered name when only the server changes", () => {
    fc.assert(
      fc.property(segment, segment, segment, (serverA, serverB, toolName) => {
        fc.pre(serverA !== serverB);
        expect(mcpToolName(serverA, toolName)).not.toBe(mcpToolName(serverB, toolName));
      }),
      RUNS,
    );
  });
});

describe("Property 64: the registry contains exactly the enabled MCP tools (R26.3)", () => {
  it("matches every generated enable map and preserves the user's capability declaration", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            bareName: segment,
            enabled: fc.boolean(),
            capability: fc.constantFrom<"read" | "execute">("read", "execute"),
          }),
          { maxLength: 24 },
        ),
        (entries) => {
          const tools: McpToolView[] = entries.map((entry, index) => {
            const serverId = `server-${String(index)}`;
            return {
              name: mcpToolName(serverId, entry.bareName),
              sourceName: `${serverId}::${entry.bareName}`,
              serverId,
              bareName: entry.bareName,
              description: null,
              inputSchema: {},
              enabled: entry.enabled,
              capability: entry.capability,
            };
          });

          const descriptors = buildToolDescriptors({
            workspace: workspaceStub,
            sessionId: "session",
            mode: "agent",
            gated: (_name, _kind, execute) => execute,
            mcpTools: tools,
          });
          const actual = descriptors.filter((entry) => entry.name.startsWith("mcp__"));
          const expected = tools.filter((entry) => entry.enabled);

          expect(actual.map((entry) => entry.name).sort()).toEqual(
            expected.map((entry) => entry.name).sort(),
          );
          for (const descriptor of actual) {
            const source = expected.find((entry) => entry.name === descriptor.name);
            expect(descriptor.capability).toBe(source?.capability);
          }
        },
      ),
      RUNS,
    );
  });
});

describe("Property 65: a failing MCP server is isolated (R26.6)", () => {
  it("keeps every healthy peer and only omits the failed server's tools", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 0, max: 11 }),
        async (count, failedSeed) => {
          const failedIndex = failedSeed % count;
          const servers: McpServerRuntime[] = Array.from({ length: count }, (_, index) => ({
            id: `server-${String(index)}`,
            transport: "stdio",
            scope: "workspace",
            command: "server",
            args: [],
            env: {},
            url: null,
            disabled: false,
            autoApprove: [],
            status: index === failedIndex ? "error" : "running",
            errorReason: index === failedIndex ? `server-${String(index)} failed` : null,
          }));
          const tools: McpDiscoveredTool[] = servers
            .filter((_server, index) => index !== failedIndex)
            .map((server) => ({
              serverId: server.id,
              bareName: "lookup",
              namespacedName: `${server.id}::lookup`,
              inputSchema: {},
              description: null,
            }));
          const workspace = {
            mcpServers: async () => ({ ok: true as const, value: servers }),
            mcpTools: async () => ({ ok: true as const, value: tools }),
          } as unknown as WorkspaceClient;

          const snapshot = await new McpControl(workspace).refresh();
          expect(snapshot.servers).toHaveLength(count);
          expect(snapshot.servers[failedIndex]?.status).toBe("error");
          expect(snapshot.servers[failedIndex]?.errorReason).toContain("failed");
          expect(snapshot.servers[failedIndex]?.tools).toEqual([]);
          expect(snapshot.tools.map((tool) => tool.serverId).sort()).toEqual(
            servers
              .filter((_server, index) => index !== failedIndex)
              .map((server) => server.id)
              .sort(),
          );
        },
      ),
      RUNS,
    );
  });
});
