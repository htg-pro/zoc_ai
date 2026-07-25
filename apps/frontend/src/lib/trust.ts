/**
 * Workspace trust config + permission audit log (develop.md Phase 13).
 *
 * Persists the unified `PermissionConfig` (trust state, run mode, allowlists,
 * protections) to localStorage and records every permission decision in an
 * audit log. `checkAction` ties it together: evaluate a request against the
 * current config (via the pure engine) and record the outcome. Pure-ish and
 * unit-testable with a fake `localStorage`.
 */
import {
  DEFAULT_PERMISSION_CONFIG,
  evaluatePermission,
  type ActionRequest,
  type Decision,
  type PermissionConfig,
  type RunMode,
  type TrustState,
} from "./permissions-engine";

export interface AuditEntry {
  ts: number;
  runId?: string;
  kind: ActionRequest["kind"];
  name: string;
  target?: string;
  effect: Decision["effect"];
  reason: string;
}

export type AllowlistKey = "commandAllowlist" | "mcpAllowlist" | "networkAllowlist";
export type ProtectionKey = "protectDeletions" | "protectDotfiles" | "protectExternal";

const CONFIG_KEY = "zoc.trust.config";
const AUDIT_KEY = "zoc.trust.audit.v1";
const MAX_AUDIT = 500;

let activeWorkspaceRoot: string | null = null;
let configs = new Map<string, PermissionConfig>();
let audit: AuditEntry[] = [];
let auditLoaded = false;

function storage(): Storage | null {
  if (typeof localStorage === "undefined") return null;
  if (typeof localStorage.getItem !== "function" || typeof localStorage.setItem !== "function") {
    return null;
  }
  return localStorage;
}

function workspaceKey(root: string | null | undefined): string {
  if (!root) return "__default__";
  const normalized = root.replace(/\\/g, "/").replace(/\/+$/, "");
  return (/^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized) || "__default__";
}

function configStorageKey(root: string | null | undefined): string {
  const key = workspaceKey(root);
  return key === "__default__" ? CONFIG_KEY : `${CONFIG_KEY}:${encodeURIComponent(key)}`;
}

/** Switch the settings/audit UI to a workspace-scoped trust policy. */
export function setTrustWorkspace(root: string | null): void {
  if (workspaceKey(activeWorkspaceRoot) === workspaceKey(root)) return;
  activeWorkspaceRoot = root;
  emit();
}

function sanitizeConfig(raw: unknown): PermissionConfig {
  const base = { ...DEFAULT_PERMISSION_CONFIG };
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  if (r.trust === "trusted" || r.trust === "restricted") base.trust = r.trust;
  if (["ask", "allowlist", "sandboxed", "all"].includes(r.runMode as string)) {
    base.runMode = r.runMode as RunMode;
  }
  const arr = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  base.commandAllowlist = arr(r.commandAllowlist);
  base.mcpAllowlist = arr(r.mcpAllowlist);
  base.networkAllowlist = arr(r.networkAllowlist);
  if (typeof r.protectDeletions === "boolean") base.protectDeletions = r.protectDeletions;
  if (typeof r.protectDotfiles === "boolean") base.protectDotfiles = r.protectDotfiles;
  if (typeof r.protectExternal === "boolean") base.protectExternal = r.protectExternal;
  return base;
}

const AUDIT_KINDS = new Set<ActionRequest["kind"]>([
  "agent_tool",
  "terminal",
  "task",
  "git",
  "mcp",
  "plugin",
  "fs",
]);
const AUDIT_EFFECTS = new Set<Decision["effect"]>(["allow", "deny", "prompt"]);

function sanitizeAudit(raw: unknown): AuditEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: AuditEntry[] = [];
  for (const value of raw.slice(-MAX_AUDIT)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.ts !== "number" ||
      !Number.isFinite(entry.ts) ||
      typeof entry.kind !== "string" ||
      !AUDIT_KINDS.has(entry.kind as ActionRequest["kind"]) ||
      typeof entry.name !== "string" ||
      typeof entry.effect !== "string" ||
      !AUDIT_EFFECTS.has(entry.effect as Decision["effect"]) ||
      typeof entry.reason !== "string"
    ) {
      continue;
    }
    entries.push({
      ts: entry.ts,
      runId: typeof entry.runId === "string" ? entry.runId : undefined,
      kind: entry.kind as ActionRequest["kind"],
      name: entry.name,
      target: typeof entry.target === "string" ? entry.target : undefined,
      effect: entry.effect as Decision["effect"],
      reason: entry.reason,
    });
  }
  return entries;
}

function ensureAuditLoaded(): void {
  if (auditLoaded) return;
  auditLoaded = true;
  const s = storage();
  if (!s) return;
  try {
    const raw = s.getItem(AUDIT_KEY);
    audit = sanitizeAudit(raw ? JSON.parse(raw) : null);
  } catch {
    audit = [];
  }
}

function persistAudit(): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(AUDIT_KEY, JSON.stringify(audit));
  } catch {
    /* quota/private mode — retain the in-memory audit */
  }
}

export function getTrustConfig(
  workspaceRoot: string | null = activeWorkspaceRoot,
): PermissionConfig {
  const key = workspaceKey(workspaceRoot);
  const cached = configs.get(key);
  if (cached) return cached;

  let next = { ...DEFAULT_PERMISSION_CONFIG };
  const s = storage();
  if (s) {
    try {
      const raw = s.getItem(configStorageKey(workspaceRoot));
      next = sanitizeConfig(raw ? JSON.parse(raw) : null);
    } catch {
      next = { ...DEFAULT_PERMISSION_CONFIG };
    }
  }
  configs.set(key, next);
  return next;
}

function saveConfig(
  next: PermissionConfig,
  workspaceRoot: string | null = activeWorkspaceRoot,
): void {
  configs.set(workspaceKey(workspaceRoot), next);
  const s = storage();
  if (s) {
    try {
      s.setItem(configStorageKey(workspaceRoot), JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }
  emit();
}

export function setTrust(trust: TrustState): void {
  saveConfig({ ...getTrustConfig(), trust });
}

export function setRunMode(runMode: RunMode): void {
  saveConfig({ ...getTrustConfig(), runMode });
}

export function setProtection(key: ProtectionKey, value: boolean): void {
  saveConfig({ ...getTrustConfig(), [key]: value });
}

export function addToAllowlist(key: AllowlistKey, entry: string): void {
  const value = entry.trim();
  if (!value) return;
  const current = getTrustConfig();
  if (current[key].includes(value)) return;
  saveConfig({ ...current, [key]: [...current[key], value] });
}

export function removeFromAllowlist(key: AllowlistKey, entry: string): void {
  const current = getTrustConfig();
  saveConfig({ ...current, [key]: current[key].filter((e) => e !== entry) });
}

// ── audit log ──────────────────────────────────────────────────────────
export function recordDecision(
  req: ActionRequest,
  decision: Decision,
  runId?: string,
): void {
  ensureAuditLoaded();
  audit.push({
    ts: Date.now(),
    runId,
    kind: req.kind,
    name: req.name,
    target: req.target,
    effect: decision.effect,
    reason: decision.reason,
  });
  if (audit.length > MAX_AUDIT) audit = audit.slice(-MAX_AUDIT);
  persistAudit();
  emit();
}

export function getAuditLog(): AuditEntry[] {
  ensureAuditLoaded();
  return [...audit];
}

export function clearAuditLog(): void {
  ensureAuditLoaded();
  audit = [];
  persistAudit();
  emit();
}

/** Evaluate a request against the live config and record the decision. */
export function checkAction(req: ActionRequest, workspaceRoot: string | null = null): Decision {
  const decision = evaluatePermission(getTrustConfig(), req, workspaceRoot);
  recordDecision(req, decision);
  return decision;
}

// ── pub/sub ───────────────────────────────────────────────────────────────
const listeners = new Set<() => void>();
function emit(): void {
  for (const fn of listeners) fn();
}
export function subscribeTrust(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Test-only reset of the in-memory config + audit. */
export function __resetTrustForTests(): void {
  activeWorkspaceRoot = null;
  configs = new Map<string, PermissionConfig>();
  audit = [];
  auditLoaded = false;
}
