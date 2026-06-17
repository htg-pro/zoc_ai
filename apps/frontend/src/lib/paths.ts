/**
 * Pure path helpers for Explorer file operations (develop.md Phase 2).
 *
 * Workspace paths are absolute and may use "/" (POSIX) or "\\" (Windows). These
 * helpers detect the separator from the input so the same logic works on both,
 * and they power the open-tab remapping after a rename/move/delete. Pure and
 * dependency-free so they can be unit-tested without a DOM or Tauri.
 */
import type { OpenFile } from "./store";

/** Detect the path separator used by `p` (defaults to "/"). */
export function sepOf(p: string): "/" | "\\" {
  return p.includes("\\") && !p.includes("/") ? "\\" : "/";
}

export function dirname(p: string): string {
  const sep = sepOf(p);
  const trimmed = p.endsWith(sep) ? p.slice(0, -1) : p;
  const idx = trimmed.lastIndexOf(sep);
  return idx <= 0 ? trimmed.slice(0, idx + 1) || sep : trimmed.slice(0, idx);
}

export function basename(p: string): string {
  const sep = sepOf(p);
  const trimmed = p.endsWith(sep) ? p.slice(0, -1) : p;
  const idx = trimmed.lastIndexOf(sep);
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/** Join a directory and a child name with the directory's separator. */
export function joinPath(dir: string, name: string): string {
  const sep = sepOf(dir);
  const base = dir.endsWith(sep) ? dir.slice(0, -1) : dir;
  return `${base}${sep}${name}`;
}

/** The path that results from renaming `path`'s final component to `newName`. */
export function renamedPath(path: string, newName: string): string {
  return joinPath(dirname(path), newName);
}

/** True when `path` is `base` or sits underneath it. */
export function isWithin(base: string, path: string): boolean {
  if (path === base) return true;
  const sep = sepOf(base);
  const prefix = base.endsWith(sep) ? base : base + sep;
  return path.startsWith(prefix);
}

/** Remap a path after `from` was renamed/moved to `to`. Handles both the exact
 *  path and any descendant (when `from` was a directory). Returns the input
 *  unchanged when it isn't affected. */
export function remapPath(path: string, from: string, to: string): string {
  if (path === from) return to;
  if (isWithin(from, path)) {
    const sep = sepOf(from);
    const prefix = from.endsWith(sep) ? from : from + sep;
    return to + (to.endsWith(sep) ? "" : sep) + path.slice(prefix.length);
  }
  return path;
}

/** Open-file list after `from` was renamed/moved to `to`: rewrites affected
 *  paths and the display name of the directly-renamed file. */
export function remapOpenFiles(files: OpenFile[], from: string, to: string): OpenFile[] {
  return files.map((f) => {
    const next = remapPath(f.path, from, to);
    if (next === f.path) return f;
    return { ...f, path: next, name: basename(next) };
  });
}

/** The active-file path after a rename/move. */
export function remapActive(active: string | null, from: string, to: string): string | null {
  return active ? remapPath(active, from, to) : active;
}

/** Open-file list after `deleted` (file or directory) was removed: drops the
 *  entry and any descendants. */
export function openFilesAfterDelete(files: OpenFile[], deleted: string): OpenFile[] {
  return files.filter((f) => !isWithin(deleted, f.path));
}

/** The active-file path after `deleted` was removed: falls back to the last
 *  remaining open file, or null. */
export function activeAfterDelete(
  files: OpenFile[],
  active: string | null,
  deleted: string,
): string | null {
  if (active && isWithin(deleted, active)) {
    const remaining = openFilesAfterDelete(files, deleted);
    return remaining[remaining.length - 1]?.path ?? null;
  }
  return active;
}
