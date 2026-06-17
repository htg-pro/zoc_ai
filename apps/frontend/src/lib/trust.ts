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
  kind: ActionRequest["kind"];
  name: string;
  target?: string;
  effect: Decision["effect"];
  reason: string;
}

export type AllowlistKey = "commandAllowlist" | "mcpAllowlist" | "networkAllowlist";
export type ProtectionKey = "protectDeletions" | "protectDotfiles" | "protectExternal";

const CONFIG_KEY = "zoc.trust.config";
const MAX_AUDIT = 500;

let config: PermissionConfig | null = null;
let audit: AuditEntry[] = [];

function storage(): Storage | null {
  if (typeof localStorage === "undefined") return null;
  if (typeof localStorage.getItem !== "function" || typeof localStorage.setItem !== "function") {
    return null;
  }
  return localStorage;
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

export function getTrustConfig(): PermissionConfig {
  if (config) return config;
  const s = storage();
  if (s) {
    try {
      const raw = s.getItem(CONFIG_KEY);
      config = sanitizeConfig(raw ? JSON.parse(raw) : null);
    } catch {
      config = { ...DEFAULT_PERMISSION_CONFIG };
    }
  } else {
    config = { ...DEFAULT_PERMISSION_CONFIG };
  }
  return config;
}

function saveConfig(next: PermissionConfig): void {
  config = next;
  const s = storage();
  if (s) {
    try {
      s.setItem(CONFIG_KEY, JSON.stringify(next));
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
export function recordDecision(req: ActionRequest, decision: Decision): void {
  audit.push({
    ts: Date.now(),
    kind: req.kind,
    name: req.name,
    target: req.target,
    effect: decision.effect,
    reason: decision.reason,
  });
  if (audit.length > MAX_AUDIT) audit = audit.slice(-MAX_AUDIT);
  emit();
}

export function getAuditLog(): AuditEntry[] {
  return audit;
}

export function clearAuditLog(): void {
  audit = [];
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
  config = null;
  audit = [];
}
