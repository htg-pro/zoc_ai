/** MCP configuration parsing and precedence — zoc-agent-chat-rebuild R26.2, R26.3, R26.5. */
/** Feature: zoc-agent-chat-rebuild, task 30.1 (R26.2, R26.3, R26.5). */

export type McpTransport = "stdio" | "sse" | "http";
export type McpScope = "user" | "workspace";

export interface McpServer {
  readonly id: string;
  readonly transport: McpTransport;
  readonly command?: string;
  readonly args: string[];
  readonly env: Record<string, string>;
  readonly url?: string;
  readonly autoApprove: string[];
  readonly disabled: boolean;
  readonly scope: McpScope;
}

export interface McpToolSetting {
  readonly enabled: boolean;
  /** User-owned narrowing. MCP tools default to execute (R26.3/R26.5). */
  readonly capability: "read" | "execute";
}

export type McpToolEnableMap = Readonly<Record<string, McpToolSetting>>;

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

function stripJsonComments(text: string): string {
  let output = "";
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const next = text[index + 1];
    if (quoted) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length - 1 && !(text[index] === "*" && text[index + 1] === "/")) {
        if (text[index] === "\n") output += "\n";
        index += 1;
      }
      index += 1;
      continue;
    }
    output += char;
  }
  return output;
}

/** Remove JSONC trailing commas without touching comma-like text inside strings. */
function stripTrailingCommas(text: string): string {
  let output = "";
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      output += char;
      continue;
    }
    if (char === ",") {
      let next = index + 1;
      while (/\s/u.test(text[next] ?? "")) next += 1;
      if (text[next] === "}" || text[next] === "]") continue;
    }
    output += char;
  }
  return output;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export function detectTransport(raw: RawServer): McpTransport {
  const explicit = typeof raw.transport === "string" ? raw.transport : raw.type;
  if (typeof explicit === "string") {
    const normalized = explicit.toLowerCase();
    if (
      normalized === "http" ||
      normalized === "streamable-http" ||
      normalized === "streamablehttp"
    )
      return "http";
    if (normalized === "sse") return "sse";
    if (normalized === "stdio") return "stdio";
  }
  return typeof raw.url === "string" ? "sse" : "stdio";
}

function normalizeServer(id: string, raw: RawServer, scope: McpScope): McpServer | null {
  const transport = detectTransport(raw);
  const common = {
    id,
    transport,
    args: strings(raw.args),
    env: stringRecord(raw.env),
    autoApprove: strings(raw.autoApprove),
    disabled: raw.disabled === true,
    scope,
  };
  if (transport === "stdio") {
    return typeof raw.command === "string" && raw.command.length > 0
      ? { ...common, command: raw.command }
      : null;
  }
  return typeof raw.url === "string" && raw.url.length > 0 ? { ...common, url: raw.url } : null;
}

export function parseMcpConfig(text: string, scope: McpScope): McpServer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripTrailingCommas(stripJsonComments(text)));
  } catch {
    return [];
  }
  const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
  if (typeof servers !== "object" || servers === null) return [];
  const output: McpServer[] = [];
  for (const [id, raw] of Object.entries(servers)) {
    if (typeof raw !== "object" || raw === null) continue;
    const server = normalizeServer(id, raw as RawServer, scope);
    if (server !== null) output.push(server);
  }
  return output;
}

export function mergeMcpServers(user: McpServer[], workspace: McpServer[]): McpServer[] {
  const merged = new Map<string, McpServer>();
  for (const server of user) merged.set(server.id, server);
  for (const server of workspace) merged.set(server.id, server);
  return [...merged.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function loadMcpServers(userText: string | null, workspaceText: string | null): McpServer[] {
  return mergeMcpServers(
    userText === null ? [] : parseMcpConfig(userText, "user"),
    workspaceText === null ? [] : parseMcpConfig(workspaceText, "workspace"),
  );
}

export function isToolAutoApproved(server: McpServer, toolName: string): boolean {
  return server.autoApprove.includes(toolName);
}

export function serializeMcpServer(server: McpServer): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  if (server.transport === "stdio") {
    raw.command = server.command ?? "";
    if (server.args.length > 0) raw.args = server.args;
  } else {
    raw.url = server.url ?? "";
    raw.type = server.transport;
  }
  if (Object.keys(server.env).length > 0) raw.env = server.env;
  if (server.autoApprove.length > 0) raw.autoApprove = server.autoApprove;
  if (server.disabled) raw.disabled = true;
  return raw;
}

export function upsertWorkspaceServer(workspaceText: string | null, server: McpServer): string {
  let document: Record<string, unknown> = {};
  if (workspaceText !== null) {
    try {
      const parsed = JSON.parse(stripTrailingCommas(stripJsonComments(workspaceText))) as unknown;
      if (typeof parsed === "object" && parsed !== null)
        document = parsed as Record<string, unknown>;
    } catch {
      document = {};
    }
  }
  const current =
    typeof document.mcpServers === "object" && document.mcpServers !== null
      ? (document.mcpServers as Record<string, unknown>)
      : {};
  document.mcpServers = { ...current, [server.id]: serializeMcpServer(server) };
  return JSON.stringify(document, null, 2);
}
