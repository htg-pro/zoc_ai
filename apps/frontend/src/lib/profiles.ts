/**
 * Settings profiles (develop.md Phase 10).
 *
 * A profile is a named bundle of setting values that can be applied in one
 * click. Applying writes the profile's values into the **user** scope (so a
 * profile is a starting point, and a workspace can still override individual
 * keys). Profiles also drive import/export: a profile document carries both
 * settings and keybinding overrides as portable JSON.
 */
import {
  SETTINGS_REGISTRY,
  coerce,
  loadScope,
  saveScope,
  type SettingValue,
} from "./settings";
import {
  loadOverrides,
  saveOverrides,
  sanitizeOverrides,
  type KeybindingOverrides,
} from "./keybinding-overrides";

export type ProfileId = "default" | "local-first" | "cloud-agent" | "strict-approval";

export interface Profile {
  id: ProfileId;
  name: string;
  description: string;
  settings: Record<string, SettingValue>;
}

export const BUILTIN_PROFILES: Profile[] = [
  {
    id: "default",
    name: "Default",
    description: "Balanced defaults — Agent mode at high autonomy.",
    settings: {
      "agent.defaultMode": "agent",
      "agent.autonomy": "High",
      "editor.minimap": false,
      "editor.breadcrumbs": true,
    },
  },
  {
    id: "local-first",
    name: "Local-first",
    description: "Optimized for local models and a minimal editor chrome.",
    settings: {
      "agent.defaultMode": "agent",
      "agent.autonomy": "Medium",
      "editor.minimap": false,
      "editor.stickyScroll": true,
      "editor.breadcrumbs": true,
    },
  },
  {
    id: "cloud-agent",
    name: "Cloud-agent",
    description: "Full autonomy for capable cloud models, richer editor view.",
    settings: {
      "agent.defaultMode": "agent",
      "agent.autonomy": "High",
      "editor.minimap": true,
      "editor.stickyScroll": true,
      "editor.breadcrumbs": true,
    },
  },
  {
    id: "strict-approval",
    name: "Strict-approval",
    description: "Read-first: Ask mode by default and the lowest autonomy.",
    settings: {
      "agent.defaultMode": "ask",
      "agent.autonomy": "Low",
      "editor.breadcrumbs": true,
    },
  },
];

const ACTIVE_KEY = "zoc.profile.active";

export function profileFor(id: string): Profile | undefined {
  return BUILTIN_PROFILES.find((p) => p.id === id);
}

function storage(): Storage | null {
  if (typeof localStorage === "undefined") return null;
  if (typeof localStorage.getItem !== "function" || typeof localStorage.setItem !== "function") {
    return null;
  }
  return localStorage;
}

export function activeProfileId(): ProfileId {
  const s = storage();
  const raw = s?.getItem(ACTIVE_KEY);
  return raw && profileFor(raw) ? (raw as ProfileId) : "default";
}

/** Apply a profile's values into the user scope (validated) and record it. */
export function applyProfile(id: ProfileId): void {
  const profile = profileFor(id);
  if (!profile) return;
  const next = { ...loadScope("user") };
  for (const spec of SETTINGS_REGISTRY) {
    if (spec.key in profile.settings) {
      const v = coerce(spec, profile.settings[spec.key]);
      if (v !== undefined) next[spec.key] = v;
    }
  }
  saveScope("user", next);
  storage()?.setItem(ACTIVE_KEY, id);
}

// ── import / export ────────────────────────────────────────────────────
export interface ProfileExport {
  version: 1;
  settings: Record<string, SettingValue>;
  keybindings: KeybindingOverrides;
}

/** Serialize the current user settings + keybinding overrides to portable JSON. */
export function exportProfile(): string {
  const doc: ProfileExport = {
    version: 1,
    settings: loadScope("user"),
    keybindings: loadOverrides(),
  };
  return JSON.stringify(doc, null, 2);
}

/** Parse + sanitize a profile document. Throws on malformed JSON. */
export function parseProfileExport(json: string): ProfileExport {
  const raw = JSON.parse(json) as Partial<ProfileExport>;
  const settings: Record<string, SettingValue> = {};
  for (const spec of SETTINGS_REGISTRY) {
    const v = coerce(spec, (raw.settings ?? {})[spec.key]);
    if (v !== undefined) settings[spec.key] = v;
  }
  return { version: 1, settings, keybindings: sanitizeOverrides(raw.keybindings) };
}

/** Import a profile document into the user scope + keybinding overrides. */
export function importProfile(json: string): void {
  const doc = parseProfileExport(json);
  saveScope("user", { ...loadScope("user"), ...doc.settings });
  saveOverrides({ ...loadOverrides(), ...doc.keybindings });
}
