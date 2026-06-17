/**
 * Most-recently-used lists for the command palette: recently opened files and
 * recently invoked commands. Persisted to localStorage so they survive reloads
 * in the browser preview and app restarts on the desktop. Pure, dependency-free
 * functions so they can be unit-tested without a DOM.
 */

const FILES_KEY = "zoc.recent.files";
const COMMANDS_KEY = "zoc.recent.commands";
const CAP = 12;

function storage(): Storage | null {
  if (typeof localStorage === "undefined") return null;
  if (
    typeof localStorage.getItem !== "function" ||
    typeof localStorage.setItem !== "function"
  ) {
    return null;
  }
  return localStorage;
}

/**
 * Move `value` to the front of `list`, de-duplicating, and cap the length.
 * Pure — the workhorse behind both recent lists.
 */
export function pushRecent(list: readonly string[], value: string, cap = CAP): string[] {
  const v = value.trim();
  if (!v) return [...list].slice(0, cap);
  const next = [v, ...list.filter((item) => item !== v)];
  return next.slice(0, cap);
}

function read(key: string): string[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function write(key: string, list: string[]): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(key, JSON.stringify(list));
  } catch {
    /* quota / serialization — ignore */
  }
}

export function recentFiles(): string[] {
  return read(FILES_KEY);
}

export function recordRecentFile(path: string): void {
  write(FILES_KEY, pushRecent(read(FILES_KEY), path));
}

export function recentCommands(): string[] {
  return read(COMMANDS_KEY);
}

export function recordRecentCommand(id: string): void {
  write(COMMANDS_KEY, pushRecent(read(COMMANDS_KEY), id));
}
