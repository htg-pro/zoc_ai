/**
 * Plugin host (develop.md Phase 12).
 *
 * An internal plugin runtime: installs plugins from a manifest, persists them,
 * enables/disables them, isolates failures (a bad manifest is logged and marked
 * errored without breaking other plugins or the host), and exposes the *active*
 * contributions (commands/views) from the enabled set. Contributed commands are
 * registered into the command palette via `setContributedCommands`.
 *
 * What's intentionally deferred to the desktop runtime: executing plugin code
 * in a real sandbox, reading a folder / extracting a zip from disk, and Open
 * VSX compatibility. This module owns the manifest model, lifecycle, logs, and
 * contribution wiring — all pure/JS-testable.
 */
import { setContributedCommands, type Command } from "./commands";
import {
  parsePluginManifest,
  type ContributedView,
  type PluginManifest,
} from "./plugin-manifest";
import { checkAction } from "./trust";

export type PluginSource = "folder" | "zip" | "builtin";

export interface InstalledPlugin {
  manifest: PluginManifest;
  enabled: boolean;
  source: PluginSource;
  /** Set when the plugin couldn't be activated (kept for visibility). */
  errored: boolean;
  error?: string;
}

export interface PluginLogEntry {
  ts: number;
  level: "info" | "error";
  pluginId: string | null;
  message: string;
}

const STORAGE_KEY = "zoc.plugins";
const MAX_LOGS = 200;

let plugins: InstalledPlugin[] = [];
let logs: PluginLogEntry[] = [];
let loaded = false;

// ── persistence ───────────────────────────────────────────────────────────
function storage(): Storage | null {
  if (typeof localStorage === "undefined") return null;
  if (typeof localStorage.getItem !== "function" || typeof localStorage.setItem !== "function") {
    return null;
  }
  return localStorage;
}

interface StoredPlugin {
  manifest: unknown;
  enabled: boolean;
  source: PluginSource;
}

function persist(): void {
  const s = storage();
  if (!s) return;
  try {
    const data: StoredPlugin[] = plugins.map((p) => ({
      manifest: p.manifest,
      enabled: p.enabled,
      source: p.source,
    }));
    s.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* ignore */
  }
}

function hydrate(): void {
  if (loaded) return;
  loaded = true;
  const s = storage();
  if (!s) return;
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw) as StoredPlugin[];
    if (!Array.isArray(data)) return;
    for (const entry of data) {
      const { manifest, errors } = parsePluginManifest(entry.manifest as object);
      if (manifest) {
        plugins.push({ manifest, enabled: entry.enabled !== false, source: entry.source, errored: false });
      } else {
        log("error", null, `Skipped a stored plugin: ${errors.join(" ")}`);
      }
    }
  } catch {
    /* ignore corrupt store */
  }
  syncContributions();
}

// ── logs ────────────────────────────────────────────────────────────────
function log(level: "info" | "error", pluginId: string | null, message: string): void {
  logs.push({ ts: Date.now(), level, pluginId, message });
  if (logs.length > MAX_LOGS) logs = logs.slice(-MAX_LOGS);
}

export function getPluginLogs(): PluginLogEntry[] {
  hydrate();
  return logs;
}

export function clearPluginLogs(): void {
  logs = [];
  emit();
}

// ── lifecycle ─────────────────────────────────────────────────────────────
export function getPlugins(): InstalledPlugin[] {
  hydrate();
  return plugins;
}

export function getPlugin(id: string): InstalledPlugin | undefined {
  return getPlugins().find((p) => p.manifest.id === id);
}

/**
 * Install (or replace) a plugin from a manifest. Returns the parse errors;
 * an empty array means success. A failed install is logged and isolated — it
 * never throws and never affects already-installed plugins.
 */
export function installPlugin(
  manifestInput: string | object,
  source: PluginSource = "folder",
): string[] {
  hydrate();
  const { manifest, errors } = parsePluginManifest(manifestInput);
  if (!manifest) {
    log("error", null, `Install failed: ${errors.join(" ")}`);
    emit();
    return errors;
  }
  const existingIndex = plugins.findIndex((p) => p.manifest.id === manifest.id);
  const record: InstalledPlugin = { manifest, enabled: true, source, errored: false };
  if (existingIndex >= 0) {
    record.enabled = plugins[existingIndex].enabled;
    plugins[existingIndex] = record;
    log("info", manifest.id, `Updated to v${manifest.version}.`);
  } else {
    plugins.push(record);
    log("info", manifest.id, `Installed v${manifest.version} from ${source}.`);
  }
  persist();
  syncContributions();
  return [];
}

export function uninstallPlugin(id: string): void {
  hydrate();
  const before = plugins.length;
  plugins = plugins.filter((p) => p.manifest.id !== id);
  if (plugins.length !== before) {
    log("info", id, "Uninstalled.");
    persist();
    syncContributions();
  }
}

export function setPluginEnabled(id: string, enabled: boolean): void {
  hydrate();
  const p = plugins.find((x) => x.manifest.id === id);
  if (!p || p.enabled === enabled) return;
  p.enabled = enabled;
  log("info", id, enabled ? "Enabled." : "Disabled.");
  persist();
  syncContributions();
}

/** Mark a plugin as errored (e.g. its activation threw at runtime). */
export function reportPluginError(id: string, message: string): void {
  hydrate();
  const p = plugins.find((x) => x.manifest.id === id);
  if (!p) return;
  p.errored = true;
  p.error = message;
  log("error", id, message);
  syncContributions();
}

// ── contributions ───────────────────────────────────────────────────────
/** Plugins whose contributions are live: enabled and not errored. */
function activePlugins(): InstalledPlugin[] {
  return plugins.filter((p) => p.enabled && !p.errored);
}

export function activeContributedCommands(): Command[] {
  return activePlugins().flatMap((p) =>
    p.manifest.contributes.commands.map<Command>((c) => ({
      id: c.id,
      title: c.title,
      category: "View",
      aliases: [p.manifest.name],
      run: () => {
        // Workspace Trust gate (Phase 13): a restricted workspace blocks
        // plugin actions. The decision is recorded in the audit log.
        const decision = checkAction({ kind: "plugin", name: c.id });
        if (decision.effect === "deny") {
          log("error", p.manifest.id, `Command blocked: ${c.id} — ${decision.reason}`);
          emit();
          return;
        }
        // Plugin code execution is deferred to the runtime sandbox; for now an
        // invocation is recorded in the host log so the contribution is real
        // and observable end-to-end.
        log("info", p.manifest.id, `Command invoked: ${c.id}`);
        emit();
      },
    })),
  );
}

export interface ActiveView extends ContributedView {
  pluginId: string;
  pluginName: string;
}

export function activeContributedViews(): ActiveView[] {
  return activePlugins().flatMap((p) =>
    p.manifest.contributes.views.map<ActiveView>((v) => ({
      ...v,
      pluginId: p.manifest.id,
      pluginName: p.manifest.name,
    })),
  );
}

/** Push the current contributed commands into the command registry + notify. */
function syncContributions(): void {
  setContributedCommands(activeContributedCommands());
  emit();
}

// ── pub/sub ───────────────────────────────────────────────────────────────
const listeners = new Set<() => void>();
function emit(): void {
  for (const fn of listeners) fn();
}
export function subscribePlugins(fn: () => void): () => void {
  hydrate();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Test-only: reset the in-memory host so a suite can start from scratch. */
export function __resetPluginHostForTests(): void {
  plugins = [];
  logs = [];
  loaded = false;
  setContributedCommands([]);
}
