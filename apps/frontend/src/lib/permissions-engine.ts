/**
 * Unified permission engine (develop.md Phase 13).
 *
 * One pure decision function for every privileged action in the app — agent
 * tools, terminal commands, tasks, Git, MCP tools, plugin actions, and
 * filesystem operations. Given the current workspace trust state, run mode,
 * allowlists, and protections, it returns allow / deny / prompt with a reason.
 * Kept pure and dependency-free so the whole policy is unit-testable; the store
 * owns the persisted config and the audit log (see `trust.ts`).
 */

export type TrustState = "trusted" | "restricted";

/** How privileged actions are gated when the workspace is trusted. */
export type RunMode = "ask" | "allowlist" | "sandboxed" | "all";

export type ActionKind =
  | "agent_tool"
  | "terminal"
  | "task"
  | "git"
  | "mcp"
  | "plugin"
  | "fs";

export type Effect = "allow" | "deny" | "prompt";

export interface PermissionConfig {
  trust: TrustState;
  runMode: RunMode;
  /** Allowlisted terminal/task command names (exact or prefix match). */
  commandAllowlist: string[];
  /** Allowlisted MCP tool names. */
  mcpAllowlist: string[];
  /** Allowlisted network hosts. */
  networkAllowlist: string[];
  protectDeletions: boolean;
  protectDotfiles: boolean;
  protectExternal: boolean;
}

export interface ActionRequest {
  kind: ActionKind;
  /** Tool/command/task/server name (for allowlist matching + audit). */
  name: string;
  /** Filesystem target / command argument path, when relevant. */
  target?: string;
  /** True for destructive actions (delete, overwrite, force, reset --hard…). */
  destructive?: boolean;
  /** True when the action touches the network. */
  network?: boolean;
  /** Network host, when `network` is set. */
  host?: string;
  /** True when the action only reads (never gated by trust). */
  readOnly?: boolean;
  /** True when the action can run in an isolated sandbox. */
  sandboxable?: boolean;
}

export interface Decision {
  effect: Effect;
  reason: string;
}

export const DEFAULT_PERMISSION_CONFIG: PermissionConfig = {
  trust: "restricted",
  runMode: "ask",
  commandAllowlist: [],
  mcpAllowlist: [],
  networkAllowlist: [],
  protectDeletions: true,
  protectDotfiles: true,
  protectExternal: true,
};

/** Execution kinds that a restricted workspace blocks until trusted. */
const EXECUTION_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  "terminal",
  "task",
  "plugin",
  "agent_tool",
  "mcp",
  "git",
]);

export function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** A dotfile is any path whose final segment starts with a dot (".env"). */
export function isDotfile(target: string | undefined): boolean {
  if (!target) return false;
  return basename(target).startsWith(".");
}

/** A path is "external" when it resolves outside the workspace root. */
export function isExternalPath(target: string | undefined, workspaceRoot: string | null): boolean {
  if (!target) return false;
  const isAbsolute = target.startsWith("/") || /^[A-Za-z]:[/\\]/.test(target);
  if (!workspaceRoot) return isAbsolute; // no root known → treat absolute paths as external
  const norm = (p: string) => p.replace(/[/\\]+$/, "");
  if (!isAbsolute) return target.includes("..") && target.split(/[/\\]/).includes("..");
  return !norm(target).startsWith(norm(workspaceRoot));
}

/** Does an allowlist contain `name` (exact, or as a whitespace-delimited prefix)? */
export function matchesAllowlist(allowlist: string[], name: string): boolean {
  const n = name.trim();
  return allowlist.some((entry) => {
    const e = entry.trim();
    if (!e) return false;
    return n === e || n.startsWith(`${e} `);
  });
}

function isAllowlisted(config: PermissionConfig, req: ActionRequest): boolean {
  if (req.kind === "mcp") return matchesAllowlist(config.mcpAllowlist, req.name);
  if (req.kind === "terminal" || req.kind === "task") {
    return matchesAllowlist(config.commandAllowlist, req.name);
  }
  return false;
}

const allow = (reason: string): Decision => ({ effect: "allow", reason });
const deny = (reason: string): Decision => ({ effect: "deny", reason });
const prompt = (reason: string): Decision => ({ effect: "prompt", reason });

/**
 * Evaluate a single action against the current policy.
 *
 * Precedence:
 *  1. Read-only actions are always allowed.
 *  2. A restricted workspace blocks all execution kinds (until trusted).
 *  3. Filesystem protections (deletion / dotfile / external) gate writes.
 *  4. Destructive actions require confirmation or an allowlist entry — even in
 *     "Run everything" mode.
 *  5. Network actions require an allowlisted host.
 *  6. The run mode decides the rest (ask / allowlist / sandboxed / all).
 */
export function evaluatePermission(
  config: PermissionConfig,
  req: ActionRequest,
  workspaceRoot: string | null = null,
): Decision {
  // 1. Reads never need gating.
  if (req.readOnly) return allow("Read-only action.");

  // 2. Workspace trust gate.
  if (config.trust === "restricted" && EXECUTION_KINDS.has(req.kind)) {
    return deny(`Workspace is restricted — trust it to run ${req.kind} actions.`);
  }

  const allowlisted = isAllowlisted(config, req);

  // 3. Filesystem protections.
  if (req.kind === "fs") {
    if (req.destructive && config.protectDeletions) {
      return prompt("File deletion is protected — confirm to proceed.");
    }
    if (config.protectDotfiles && isDotfile(req.target)) {
      return prompt("Editing a protected dotfile — confirm to proceed.");
    }
    if (config.protectExternal && isExternalPath(req.target, workspaceRoot)) {
      return prompt("Target is outside the workspace — confirm to proceed.");
    }
  }

  // 4. Destructive actions: confirm or allowlist, regardless of run mode.
  if (req.destructive && !allowlisted) {
    return prompt("Destructive action requires explicit confirmation.");
  }

  // 5. Network allowlist.
  if (req.network) {
    if (!req.host || !matchesAllowlist(config.networkAllowlist, req.host)) {
      return prompt(`Network host ${req.host ?? "(unknown)"} is not allowlisted.`);
    }
  }

  // 6. Run mode.
  switch (config.runMode) {
    case "all":
      return allow("Run-everything mode.");
    case "allowlist":
      return allowlisted
        ? allow("Command is allowlisted.")
        : prompt("Not on the allowlist — confirm to proceed.");
    case "sandboxed":
      return req.sandboxable
        ? allow("Runs in an isolated sandbox.")
        : prompt("Can't be sandboxed — confirm to proceed.");
    case "ask":
    default:
      return allowlisted ? allow("Command is allowlisted.") : prompt("Ask-every-time mode.");
  }
}
