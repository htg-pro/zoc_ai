/**
 * MCP control client (Part 4, §4.1). Thin wrapper over the admitted
 * `/v1/mcp/*` gateway routes, resolving the loopback port like the other
 * frontend clients. On a loopback bind these requests are admitted without a
 * token, so no credential header is sent.
 */
import { resolveAgentPort } from "./agent-port";

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
}

export type McpTestOutcome =
  | { outcome: "success"; toolCount: number; bareNames: string[] }
  | { outcome: "validation-failure"; reason: string }
  | { outcome: "unsupported"; transport: string }
  | { outcome: "failure"; reason: string };

async function mcpBaseUrl(): Promise<string> {
  const port = await resolveAgentPort();
  return `http://127.0.0.1:${port}/v1/mcp`;
}

/** GET /v1/mcp/servers — live runtime state for every configured server. */
export async function fetchMcpServers(): Promise<McpServerStatus[]> {
  const res = await fetch(`${await mcpBaseUrl()}/servers`);
  if (!res.ok) throw new Error(`mcp servers request failed: ${res.status}`);
  const body = (await res.json()) as { servers?: McpServerStatus[] };
  return body.servers ?? [];
}

/** POST /v1/mcp/reload — recompute config and apply lifecycle diffs. */
export async function reloadMcp(): Promise<McpServerStatus[]> {
  const res = await fetch(`${await mcpBaseUrl()}/reload`, { method: "POST" });
  if (!res.ok) throw new Error(`mcp reload failed: ${res.status}`);
  const body = (await res.json()) as { servers?: McpServerStatus[] };
  return body.servers ?? [];
}

/** POST /v1/mcp/test — test one candidate definition in isolation. */
export async function testMcpServer(candidate: Record<string, unknown>): Promise<McpTestOutcome> {
  const res = await fetch(`${await mcpBaseUrl()}/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(candidate),
  });
  if (!res.ok) throw new Error(`mcp test failed: ${res.status}`);
  return (await res.json()) as McpTestOutcome;
}
