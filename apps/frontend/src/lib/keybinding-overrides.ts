/**
 * User keybinding customization (develop.md Phase 10).
 *
 * The command registry (`lib/commands.ts`) ships default keybindings; this
 * module layers a persisted map of per-command overrides on top, detects
 * conflicts (two enabled commands resolving to the same chord), and supports a
 * raw JSON import/export so power users can edit bindings directly.
 *
 * An override value is the normalized chord string (same grammar as the
 * registry, e.g. "mod+shift+p") or `null` to explicitly *unbind* a command's
 * default. A command with no entry uses its registry default.
 */
import type { Command } from "./commands";

export type KeybindingOverrides = Record<string, string | null>;

const STORAGE_KEY = "zoc.keybindings.overrides";

function storage(): Storage | null {
  if (typeof localStorage === "undefined") return null;
  if (typeof localStorage.getItem !== "function" || typeof localStorage.setItem !== "function") {
    return null;
  }
  return localStorage;
}

/** A chord is valid when it has a non-modifier key and only known modifiers. */
export function isValidChord(chord: string): boolean {
  if (!chord) return false;
  const parts = chord.split("+");
  const mods = new Set(["mod", "shift", "alt"]);
  const keys = parts.filter((p) => !mods.has(p));
  if (keys.length !== 1 || keys[0].length === 0) return false;
  // Every modifier must be recognized.
  return parts.every((p) => mods.has(p) || p === keys[0]);
}

export function sanitizeOverrides(raw: unknown): KeybindingOverrides {
  const out: KeybindingOverrides = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null) out[id] = null;
    else if (typeof value === "string" && isValidChord(value)) out[id] = value;
  }
  return out;
}

export function loadOverrides(): KeybindingOverrides {
  const s = storage();
  if (!s) return {};
  try {
    const raw = s.getItem(STORAGE_KEY);
    return raw ? sanitizeOverrides(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

export function saveOverrides(overrides: KeybindingOverrides): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(STORAGE_KEY, JSON.stringify(sanitizeOverrides(overrides)));
  } catch {
    /* ignore */
  }
  emit();
}

/** The effective chord for a command: override (incl. explicit unbind) wins. */
export function effectiveKeybinding(
  cmd: Command,
  overrides: KeybindingOverrides = loadOverrides(),
): string | undefined {
  if (cmd.id in overrides) return overrides[cmd.id] ?? undefined;
  return cmd.keybinding;
}

export function setOverride(commandId: string, chord: string | null): void {
  if (chord !== null && !isValidChord(chord)) return;
  saveOverrides({ ...loadOverrides(), [commandId]: chord });
}

export function resetOverride(commandId: string): void {
  const current = loadOverrides();
  if (!(commandId in current)) return;
  const next = { ...current };
  delete next[commandId];
  saveOverrides(next);
}

export function resetAllOverrides(): void {
  saveOverrides({});
}

/**
 * Detect chords bound to more than one command. Only the *primary* effective
 * binding per command is considered (extra/secondary bindings are advisory).
 * Returns a map chord → commandIds, sorted, including only real conflicts.
 */
export function detectConflicts(
  commands: Command[],
  overrides: KeybindingOverrides = loadOverrides(),
): { chord: string; commandIds: string[] }[] {
  const byChord = new Map<string, string[]>();
  for (const cmd of commands) {
    const chord = effectiveKeybinding(cmd, overrides);
    if (!chord) continue;
    const list = byChord.get(chord) ?? [];
    list.push(cmd.id);
    byChord.set(chord, list);
  }
  const conflicts: { chord: string; commandIds: string[] }[] = [];
  for (const [chord, ids] of byChord) {
    if (ids.length > 1) conflicts.push({ chord, commandIds: ids });
  }
  conflicts.sort((a, b) => a.chord.localeCompare(b.chord));
  return conflicts;
}

/** True when assigning `chord` to `commandId` would collide with another command. */
export function wouldConflict(
  commands: Command[],
  commandId: string,
  chord: string,
  overrides: KeybindingOverrides = loadOverrides(),
): string[] {
  const next = { ...overrides, [commandId]: chord };
  return commands
    .filter((c) => c.id !== commandId && effectiveKeybinding(c, next) === chord)
    .map((c) => c.id);
}

export function exportKeybindings(overrides: KeybindingOverrides = loadOverrides()): string {
  return JSON.stringify(overrides, null, 2);
}

/** Parse + sanitize a JSON document of overrides. Throws on malformed JSON. */
export function parseKeybindingsJson(json: string): KeybindingOverrides {
  return sanitizeOverrides(JSON.parse(json));
}

// ── pub/sub ──────────────────────────────────────────────────────────────
const listeners = new Set<() => void>();
function emit(): void {
  for (const fn of listeners) fn();
}
export function subscribeKeybindings(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
