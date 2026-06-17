/**
 * MCP host configuration (develop.md Phase 11).
 *
 * Parses Model Context Protocol server definitions from a workspace file
 * (`.zoc/mcp.json`) and a user-level file, and merges them with workspace
 * precedence (workspace overrides user, same as VS Code / Kiro). Three
 * transports are recognized: stdio (a spawned command), SSE, and streamable
 * HTTP. This module is pure and dependency-free — the actual client connection
 * lifecycle (spawning, handshakes, tool discovery) is a runtime concern handled
 * elsewhere and is intentionally out of scope here.
 */

import { stripJsonComments } from "./tasks";

export type McpTransport = "stdio" | "sse" | "http";
export type McpScope = "user" | "workspace";

export interface McpServer {
  /** Server id (the key in `mcpServers`). */
  id: string;
  transport: McpTransport;
  /** stdio: the executable + args + env. */
  command?: string;
  args: string[];
  env: Record<string, string>;
  /** sse/http: the endpoint URL. */
  url?: string;
  /** Tool names auto-approved without an approval card. */
  autoApprove: string[];
  disabled: boolean;
  /** Which file this definition came from (workspace wins on conflict). */
  scope: McpScope;
}

interface RawServer {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  url?: unknown;
  type?: unknown;
  transport?: unknown;
  disabled?: unknown;
  autoApprove?: unknown;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function asStringRecord(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "string") out[k] = val;
    }
  }
  return out;
}

/** Decide the transport from the raw fields. Explicit `type`/`transport` wins;
 *  otherwise a `command` implies stdio and a `url` implies SSE. */
export function detectTransport(raw: RawServer): McpTransport {
  const explicit = (typeof raw.transport === "string" ? raw.transport : raw.type) as
    | string
    | undefined;
  if (explicit) {
    const t = explicit.toLowerCase();
    if (t === "stdio") return "stdio";
    if (t === "http" || t === "streamable-http" || t === "streamablehttp") return "http";
    if (t === "sse") return "sse";
  }
  if (typeof raw.command === "string") return "stdio";
  if (typeof raw.url === "string") return "sse";
  return "stdio";
}

function normalizeServer(id: string, raw: RawServer, scope: McpScope): McpServer | null {
  const transport = detectTransport(raw);
  const server: McpServer = {
    id,
    transport,
    args: asStringArray(raw.args),
    env: asStringRecord(raw.env),
    autoApprove: asStringArray(raw.autoApprove),
    disabled: raw.disabled === true,
    scope,
  };
  if (transport === "stdio") {
    if (typeof raw.command !== "string" || raw.command.length === 0) return null;
    server.command = raw.command;
  } else {
    if (typeof raw.url !== "string" || raw.url.length === 0) return null;
    server.url = raw.url;
  }
  return server;
}

/** Parse a single MCP config document (JSON, comments allowed) into servers. */
export function parseMcpConfig(text: string, scope: McpScope): McpServer[] {
  let doc: unknown;
  try {
    doc = JSON.parse(stripJsonComments(text));
  } catch {
    return [];
  }
  const servers = (doc as { mcpServers?: unknown })?.mcpServers;
  if (!servers || typeof servers !== "object") return [];
  const out: McpServer[] = [];
  for (const [id, raw] of Object.entries(servers as Record<string, RawServer>)) {
    if (!raw || typeof raw !== "object") continue;
    const server = normalizeServer(id, raw, scope);
    if (server) out.push(server);
  }
  return out;
}

/**
 * Merge user + workspace servers. Workspace definitions override user ones with
 * the same id (matching the precedence documented for mcp.json). The result is
 * sorted by id for a stable UI.
 */
export function mergeMcpServers(user: McpServer[], workspace: McpServer[]): McpServer[] {
  const byId = new Map<string, McpServer>();
  for (const s of user) byId.set(s.id, s);
  for (const s of workspace) byId.set(s.id, s); // workspace wins
  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

/** Build the merged, enabled-first server list from both config texts. */
export function loadMcpServers(
  userText: string | null,
  workspaceText: string | null,
): McpServer[] {
  const user = userText ? parseMcpConfig(userText, "user") : [];
  const workspace = workspaceText ? parseMcpConfig(workspaceText, "workspace") : [];
  return mergeMcpServers(user, workspace);
}

/** True when a tool from `server` should run without an approval card. */
export function isToolAutoApproved(server: McpServer, toolName: string): boolean {
  return server.autoApprove.includes(toolName);
}
