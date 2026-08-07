/**
 * MCP control client (Part 4, §4.1). The Workspace_Services process owns
 * server connections, while Agent_Runtime owns the registry and permission
 * gate. This client therefore resolves the runtime endpoint and sends its
 * bearer token; it does not call the Python service directly.
 */
import { resolveRuntimeEndpoint, runtimeAuthHeaders } from "./runtime-endpoint";

export type McpRuntimeStatus = "running" | "stopped" | "error";

export interface McpServerStatus {
  id: string;
  transport: "stdio" | "sse" | "http";
  scope: "user" | "workspace";
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  disabled: boolean;
  autoApprove: string[];
  status: McpRuntimeStatus;
  errorReason: string | null;
  tools: McpToolStatus[];
}

export interface McpToolStatus {
  name: string;
  sourceName: string;
  serverId: string;
  bareName: string;
  description: string | null;
  inputSchema: Record<string, unknown>;
  enabled: boolean;
  capability: "read" | "execute";
}

export type McpTestOutcome =
  | { outcome: "success"; toolCount: number; bareNames: string[] }
  | { outcome: "validation-failure"; reason: string }
  | { outcome: "unsupported"; transport: string }
  | { outcome: "failure"; reason: string };

async function runtimeRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const runtime = await resolveRuntimeEndpoint();
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(runtimeAuthHeaders(runtime))) headers.set(key, value);
  return fetch(`${runtime.baseUrl}/v1/mcp${path}`, { ...init, headers });
}

/** GET /v1/mcp/servers — live runtime state for every configured server. */
export async function fetchMcpServers(): Promise<McpServerStatus[]> {
  const res = await runtimeRequest("/servers");
  if (!res.ok) throw new Error(`mcp servers request failed: ${res.status}`);
  const body = (await res.json()) as { servers?: McpServerStatus[] };
  return body.servers ?? [];
}

/** POST /v1/mcp/reload — recompute config and apply lifecycle diffs. */
export async function reloadMcp(): Promise<McpServerStatus[]> {
  const res = await runtimeRequest("/reload", { method: "POST" });
  if (!res.ok) throw new Error(`mcp reload failed: ${res.status}`);
  const body = (await res.json()) as { servers?: McpServerStatus[] };
  return body.servers ?? [];
}

/** PATCH one discovered tool without restarting any server. */
export async function updateMcpTool(
  name: string,
  patch: { enabled?: boolean; capability?: "read" | "execute" },
): Promise<McpToolStatus> {
  const res = await runtimeRequest(`/tools/${encodeURIComponent(name)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`mcp tool update failed: ${res.status}`);
  const body = (await res.json()) as { tool: McpToolStatus };
  return body.tool;
}

/** POST /v1/mcp/test — test one candidate definition in isolation. */
export async function testMcpServer(candidate: Record<string, unknown>): Promise<McpTestOutcome> {
  const res = await runtimeRequest("/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(candidate),
  });
  if (!res.ok) throw new Error(`mcp test failed: ${res.status}`);
  return (await res.json()) as McpTestOutcome;
}
