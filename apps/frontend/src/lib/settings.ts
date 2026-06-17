/**
 * Settings system (develop.md Phase 10).
 *
 * A small, typed settings registry with two persisted scopes — **user**
 * (applies across every workspace) and **workspace** (overrides the user value
 * for the current project). The effective value of a setting is computed as
 *
 *     default  <  user  <  workspace
 *
 * Both scopes are stored as plain JSON in localStorage (the desktop shell can
 * later route the same shapes to real `settings.json` files). Everything here
 * is pure and dependency-free so it unit-tests without a DOM; a tiny pub/sub
 * lets React surfaces re-render when a value changes.
 */

export type SettingScope = "user" | "workspace";
export type SettingValue = boolean | string | number;
export type SettingType = "boolean" | "enum" | "number" | "string";

export interface SettingSpec {
  key: string;
  label: string;
  description: string;
  category: string;
  type: SettingType;
  default: SettingValue;
  /** Allowed values for an `enum` setting. */
  options?: { value: string; label: string }[];
  /** Bounds for a `number` setting. */
  min?: number;
  max?: number;
}

/**
 * The registry. Only settings that are actually wired into the running app are
 * listed — `applyEffectiveSettings()` (in the store) pushes these into runtime
 * state, so every entry here does something real.
 */
export const SETTINGS_REGISTRY: SettingSpec[] = [
  {
    key: "editor.minimap",
    label: "Editor: Minimap",
    description: "Show the minimap overview on the right edge of the editor.",
    category: "Editor",
    type: "boolean",
    default: false,
  },
  {
    key: "editor.stickyScroll",
    label: "Editor: Sticky Scroll",
    description: "Pin enclosing scopes (class/function headers) to the top while scrolling.",
    category: "Editor",
    type: "boolean",
    default: false,
  },
  {
    key: "editor.breadcrumbs",
    label: "Editor: Breadcrumbs",
    description: "Show the path + symbol breadcrumbs bar above the editor.",
    category: "Editor",
    type: "boolean",
    default: true,
  },
  {
    key: "editor.fontSize",
    label: "Editor: Font Size",
    description: "Controls the editor font size in pixels.",
    category: "Editor",
    type: "number",
    default: 13,
    min: 8,
    max: 32,
  },
  {
    key: "agent.defaultMode",
    label: "Agent: Default Mode",
    description: "The conversation mode new sessions start in.",
    category: "Agent",
    type: "enum",
    default: "agent",
    options: [
      { value: "ask", label: "Ask (read-only)" },
      { value: "agent", label: "Agent (full autonomy)" },
    ],
  },
  {
    key: "agent.autonomy",
    label: "Agent: Autonomy",
    description: "How much the agent may do before pausing for approval.",
    category: "Agent",
    type: "enum",
    default: "High",
    options: [
      { value: "Low", label: "Low" },
      { value: "Medium", label: "Medium" },
      { value: "High", label: "High" },
    ],
  },
];

const USER_KEY = "zoc.settings.user";
const WORKSPACE_KEY = "zoc.settings.workspace";

export function specFor(key: string): SettingSpec | undefined {
  return SETTINGS_REGISTRY.find((s) => s.key === key);
}

/** Coerce a raw value to a valid one for `spec`, or `undefined` when invalid. */
export function coerce(spec: SettingSpec, value: unknown): SettingValue | undefined {
  switch (spec.type) {
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "number": {
      if (typeof value !== "number" || Number.isNaN(value)) return undefined;
      if (spec.min !== undefined && value < spec.min) return undefined;
      if (spec.max !== undefined && value > spec.max) return undefined;
      return value;
    }
    case "enum":
      return typeof value === "string" && (spec.options ?? []).some((o) => o.value === value)
        ? value
        : undefined;
    case "string":
      return typeof value === "string" ? value : undefined;
    default:
      return undefined;
  }
}

/** Keep only known, valid keys from a raw stored object. */
export function sanitizeScope(raw: unknown): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const spec of SETTINGS_REGISTRY) {
    const v = coerce(spec, (raw as Record<string, unknown>)[spec.key]);
    if (v !== undefined) out[spec.key] = v;
  }
  return out;
}

function storage(): Storage | null {
  if (typeof localStorage === "undefined") return null;
  if (typeof localStorage.getItem !== "function" || typeof localStorage.setItem !== "function") {
    return null;
  }
  return localStorage;
}

function keyFor(scope: SettingScope): string {
  return scope === "user" ? USER_KEY : WORKSPACE_KEY;
}

export function loadScope(scope: SettingScope): Record<string, SettingValue> {
  const s = storage();
  if (!s) return {};
  try {
    const raw = s.getItem(keyFor(scope));
    return raw ? sanitizeScope(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

export function saveScope(scope: SettingScope, values: Record<string, SettingValue>): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(keyFor(scope), JSON.stringify(sanitizeScope(values)));
  } catch {
    /* quota etc — ignore */
  }
  emit();
}

/** Merge default < user < workspace into the effective settings map. */
export function mergeSettings(
  user: Record<string, SettingValue>,
  workspace: Record<string, SettingValue>,
): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {};
  for (const spec of SETTINGS_REGISTRY) {
    out[spec.key] = spec.default;
    if (spec.key in user) out[spec.key] = user[spec.key];
    if (spec.key in workspace) out[spec.key] = workspace[spec.key];
  }
  return out;
}

/** The effective settings using whatever is persisted right now. */
export function effectiveSettings(): Record<string, SettingValue> {
  return mergeSettings(loadScope("user"), loadScope("workspace"));
}

export function getSetting(key: string): SettingValue | undefined {
  return effectiveSettings()[key];
}

/** Which scope a setting's effective value currently comes from. */
export function effectiveSource(key: string): "default" | SettingScope {
  if (key in loadScope("workspace")) return "workspace";
  if (key in loadScope("user")) return "user";
  return "default";
}

export function setSetting(scope: SettingScope, key: string, value: SettingValue): void {
  const spec = specFor(key);
  if (!spec) return;
  const v = coerce(spec, value);
  if (v === undefined) return;
  const current = loadScope(scope);
  saveScope(scope, { ...current, [key]: v });
}

/** Remove an explicit override so the setting falls back to the next scope. */
export function resetSetting(scope: SettingScope, key: string): void {
  const current = loadScope(scope);
  if (!(key in current)) return;
  const next = { ...current };
  delete next[key];
  saveScope(scope, next);
}

/** Substring search over label / key / description / category. */
export function searchSettings(query: string): SettingSpec[] {
  const q = query.trim().toLowerCase();
  if (!q) return SETTINGS_REGISTRY;
  return SETTINGS_REGISTRY.filter((s) =>
    `${s.label} ${s.key} ${s.description} ${s.category}`.toLowerCase().includes(q),
  );
}

// ── pub/sub ──────────────────────────────────────────────────────────────
const listeners = new Set<() => void>();
function emit(): void {
  for (const fn of listeners) fn();
}
export function subscribeSettings(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
