/**
 * Plugin manifest schema + parser (develop.md Phase 12).
 *
 * An internal plugin manifest — deliberately *not* full VS Code compatibility.
 * It declares identity (id/name/version), `activationEvents`, and a
 * `contributes` block (commands, views, tasks, snippets, themes, languages).
 * This module is pure: it parses and validates a manifest into a normalized
 * shape or a list of human-readable errors, so a malformed plugin fails loudly
 * and in isolation rather than corrupting the host.
 */

export interface ContributedCommand {
  id: string;
  title: string;
  category?: string;
}

export interface ContributedView {
  id: string;
  name: string;
  location: "sidebar" | "panel";
}

export interface ContributedTask {
  id: string;
  label: string;
  command: string;
}

export interface ContributedSnippet {
  language: string;
  name: string;
  prefix: string;
  body: string;
}

export interface ContributedTheme {
  id: string;
  label: string;
  type: "dark" | "light";
}

export interface ContributedLanguage {
  id: string;
  extensions: string[];
  aliases: string[];
}

export interface PluginContributes {
  commands: ContributedCommand[];
  views: ContributedView[];
  tasks: ContributedTask[];
  snippets: ContributedSnippet[];
  themes: ContributedTheme[];
  languages: ContributedLanguage[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  activationEvents: string[];
  contributes: PluginContributes;
}

export interface ManifestParseResult {
  manifest: PluginManifest | null;
  errors: string[];
}

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const VERSION_RE = /^\d+\.\d+\.\d+([-+].+)?$/;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function emptyContributes(): PluginContributes {
  return { commands: [], views: [], tasks: [], snippets: [], themes: [], languages: [] };
}

function parseCommands(raw: unknown, errors: string[]): ContributedCommand[] {
  if (!Array.isArray(raw)) return [];
  const out: ContributedCommand[] = [];
  raw.forEach((c, i) => {
    const id = str((c as Record<string, unknown>)?.id);
    const title = str((c as Record<string, unknown>)?.title);
    if (!id || !title) {
      errors.push(`contributes.commands[${i}] requires "id" and "title".`);
      return;
    }
    out.push({ id, title, category: str((c as Record<string, unknown>)?.category) });
  });
  return out;
}

function parseViews(raw: unknown, errors: string[]): ContributedView[] {
  if (!Array.isArray(raw)) return [];
  const out: ContributedView[] = [];
  raw.forEach((v, i) => {
    const id = str((v as Record<string, unknown>)?.id);
    const name = str((v as Record<string, unknown>)?.name);
    if (!id || !name) {
      errors.push(`contributes.views[${i}] requires "id" and "name".`);
      return;
    }
    const loc = str((v as Record<string, unknown>)?.location);
    out.push({ id, name, location: loc === "panel" ? "panel" : "sidebar" });
  });
  return out;
}

function parseTasks(raw: unknown): ContributedTask[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => {
      const r = t as Record<string, unknown>;
      const id = str(r?.id);
      const label = str(r?.label);
      const command = str(r?.command);
      return id && label && command ? { id, label, command } : null;
    })
    .filter((t): t is ContributedTask => t !== null);
}

function parseSnippets(raw: unknown): ContributedSnippet[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => {
      const r = s as Record<string, unknown>;
      const language = str(r?.language);
      const name = str(r?.name);
      const prefix = str(r?.prefix);
      const body = typeof r?.body === "string" ? (r.body as string) : undefined;
      return language && name && prefix && body !== undefined
        ? { language, name, prefix, body }
        : null;
    })
    .filter((s): s is ContributedSnippet => s !== null);
}

function parseThemes(raw: unknown): ContributedTheme[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => {
      const r = t as Record<string, unknown>;
      const id = str(r?.id);
      const label = str(r?.label);
      return id && label ? { id, label, type: r?.type === "light" ? "light" : "dark" } : null;
    })
    .filter((t): t is ContributedTheme => t !== null);
}

function parseLanguages(raw: unknown): ContributedLanguage[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => {
      const r = l as Record<string, unknown>;
      const id = str(r?.id);
      return id ? { id, extensions: strArray(r?.extensions), aliases: strArray(r?.aliases) } : null;
    })
    .filter((l): l is ContributedLanguage => l !== null);
}

/** Parse + validate a manifest from a JSON string or an already-parsed object. */
export function parsePluginManifest(input: string | object): ManifestParseResult {
  const errors: string[] = [];
  let raw: Record<string, unknown>;
  try {
    raw = (typeof input === "string" ? JSON.parse(input) : input) as Record<string, unknown>;
  } catch {
    return { manifest: null, errors: ["Manifest is not valid JSON."] };
  }
  if (!raw || typeof raw !== "object") {
    return { manifest: null, errors: ["Manifest must be a JSON object."] };
  }

  const id = str(raw.id);
  const name = str(raw.name);
  const version = str(raw.version);

  if (!id) errors.push('Manifest requires a non-empty "id".');
  else if (!ID_RE.test(id)) errors.push(`Invalid id "${id}" — use letters, digits, ".", "-", "_".`);
  if (!name) errors.push('Manifest requires a non-empty "name".');
  if (!version) errors.push('Manifest requires a "version".');
  else if (!VERSION_RE.test(version)) errors.push(`Invalid version "${version}" — expected semver (e.g. 1.0.0).`);

  // Contributions are parsed even on identity errors so we can surface all
  // problems at once; but a fatal identity error yields a null manifest.
  const c = (raw.contributes as Record<string, unknown>) ?? {};
  const contributes: PluginContributes = {
    commands: parseCommands(c.commands, errors),
    views: parseViews(c.views, errors),
    tasks: parseTasks(c.tasks),
    snippets: parseSnippets(c.snippets),
    themes: parseThemes(c.themes),
    languages: parseLanguages(c.languages),
  };

  if (!id || !name || !version || (id && !ID_RE.test(id)) || (version && !VERSION_RE.test(version))) {
    return { manifest: null, errors };
  }

  return {
    manifest: {
      id,
      name,
      version,
      description: str(raw.description) ?? "",
      activationEvents: strArray(raw.activationEvents),
      contributes,
    },
    errors,
  };
}

export { emptyContributes };
