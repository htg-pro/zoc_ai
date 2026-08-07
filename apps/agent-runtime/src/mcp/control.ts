/** MCP registry/control plane — zoc-agent-chat-rebuild R26.1–R26.6. */
/** Feature: zoc-agent-chat-rebuild, tasks 30.1-30.2 (R26.1, R26.2, R26.3, R26.4, R26.5, R26.6). */
import type {
  McpDiscoveredTool,
  McpServerRuntime,
  McpTestOutcome,
  WorkspaceClient,
  WorkspaceOutcome,
} from "../tools/workspace-client.ts";

export type McpDeclaredCapability = "read" | "execute";

export interface McpToolView {
  readonly name: string;
  readonly sourceName: string;
  readonly serverId: string;
  readonly bareName: string;
  readonly description: string | null;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly enabled: boolean;
  readonly capability: McpDeclaredCapability;
}

export interface McpServerView extends McpServerRuntime {
  readonly tools: readonly McpToolView[];
}

export interface McpSnapshot {
  readonly servers: readonly McpServerView[];
  readonly tools: readonly McpToolView[];
}

function encodeSegment(segment: string): string {
  let encoded = "";
  for (const char of segment) {
    if (/^[A-Za-z0-9-]$/u.test(char)) encoded += char;
    else {
      const bytes = new TextEncoder().encode(char);
      for (const byte of bytes) encoded += `_${byte.toString(16).padStart(2, "0")}`;
    }
  }
  return encoded.length > 0 ? encoded : "_00";
}

/** Readable for ordinary names and injective for arbitrary server/tool ids (R26.2). */
export function mcpToolName(serverId: string, bareName: string): string {
  return `mcp__${encodeSegment(serverId)}__${encodeSegment(bareName)}`;
}

function projectTool(
  tool: McpDiscoveredTool,
  setting: { enabled: boolean; capability: McpDeclaredCapability } | undefined,
): McpToolView {
  return {
    name: mcpToolName(tool.serverId, tool.bareName),
    sourceName: tool.namespacedName,
    serverId: tool.serverId,
    bareName: tool.bareName,
    description: tool.description,
    inputSchema: tool.inputSchema,
    enabled: setting?.enabled ?? true,
    capability: setting?.capability ?? "execute",
  };
}

export class McpControl {
  private readonly workspace: WorkspaceClient;
  private readonly settings = new Map<
    string,
    { enabled: boolean; capability: McpDeclaredCapability }
  >();
  private lastSnapshot: McpSnapshot = { servers: [], tools: [] };

  constructor(workspace: WorkspaceClient) {
    this.workspace = workspace;
  }

  get current(): McpSnapshot {
    return this.lastSnapshot;
  }

  async refresh(): Promise<McpSnapshot> {
    const [serversOutcome, toolsOutcome] = await Promise.all([
      this.workspace.mcpServers(),
      this.workspace.mcpTools(),
    ]);
    const servers = serversOutcome.ok ? serversOutcome.value : [];
    const discovered = toolsOutcome.ok ? toolsOutcome.value : [];
    const tools = discovered.map((tool) => {
      const name = mcpToolName(tool.serverId, tool.bareName);
      return projectTool(tool, this.settings.get(name));
    });
    const byServer = new Map<string, McpToolView[]>();
    for (const tool of tools) {
      const group = byServer.get(tool.serverId);
      if (group === undefined) byServer.set(tool.serverId, [tool]);
      else group.push(tool);
    }
    this.lastSnapshot = {
      tools,
      servers: servers.map((server) => ({
        ...server,
        tools: byServer.get(server.id) ?? [],
      })),
    };
    return this.lastSnapshot;
  }

  updateTool(
    name: string,
    patch: { readonly enabled?: boolean; readonly capability?: McpDeclaredCapability },
  ): McpToolView | null {
    const tool = this.lastSnapshot.tools.find((candidate) => candidate.name === name);
    if (tool === undefined) return null;
    const setting = {
      enabled: patch.enabled ?? tool.enabled,
      capability: patch.capability ?? tool.capability,
    };
    this.settings.set(name, setting);
    const next = { ...tool, ...setting };
    this.lastSnapshot = {
      tools: this.lastSnapshot.tools.map((candidate) =>
        candidate.name === name ? next : candidate,
      ),
      servers: this.lastSnapshot.servers.map((server) => ({
        ...server,
        tools: server.tools.map((candidate) => (candidate.name === name ? next : candidate)),
      })),
    };
    return next;
  }

  async reload(): Promise<WorkspaceOutcome<McpSnapshot>> {
    const outcome = await this.workspace.reloadMcp();
    if (!outcome.ok) return outcome;
    return { ok: true, value: await this.refresh() };
  }

  test(candidate: Record<string, unknown>): Promise<WorkspaceOutcome<McpTestOutcome>> {
    return this.workspace.testMcp(candidate);
  }

  call(
    sourceName: string,
    args: Record<string, unknown>,
  ): Promise<WorkspaceOutcome<Record<string, unknown>>> {
    return this.workspace.callMcp(sourceName, args);
  }
}
