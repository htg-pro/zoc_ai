/**
 * Pure row model for the virtualized file explorer (§9.1).
 *
 * A virtualizer needs a flat list: it renders row `i..j` of a single array, so
 * the nested `FileNode` tree has to be projected into one row per *visible*
 * line. Keeping that projection here — pure, no React, no I/O — means the
 * tricky parts (which rows are visible, where the paging boundary falls, how
 * deep each row is indented) are unit-testable without mounting a component.
 *
 * Two limits keep a 50,000-file tree responsive:
 *
 * - Only expanded directories contribute rows, so the row count tracks what
 *   the user actually opened rather than the size of the workspace.
 * - A directory never contributes more than `CHILDREN_PAGE_SIZE` child rows at
 *   once; the remainder is collapsed behind a single `load-more` row.
 */
import type { FileNode } from "@/lib/tauri-bridge";

/** Never render more than this many children of one directory at once. */
export const CHILDREN_PAGE_SIZE = 1000;

/** Fixed row height in px, shared by the virtualizer and the row components. */
export const ROW_HEIGHT = 22;

export type EditState =
  | { kind: "rename"; path: string }
  | { kind: "newfile" | "newfolder"; dir: string }
  | null;

/** One rendered line in the explorer. */
export type TreeRow =
  | { kind: "node"; key: string; depth: number; node: FileNode }
  | { kind: "rename"; key: string; depth: number; node: FileNode }
  | {
      kind: "input";
      key: string;
      depth: number;
      dir: string;
      inputKind: "newfile" | "newfolder";
    }
  | {
      kind: "load-more";
      key: string;
      depth: number;
      dir: string;
      shown: number;
      total: number;
    };

export interface FlattenArgs {
  /** Absolute workspace root path. */
  root: string;
  /** Loaded children keyed by directory path. */
  children: Record<string, FileNode[]>;
  /** Which directory paths are expanded. */
  expanded: Record<string, boolean>;
  /** Per-directory reveal limit; defaults to `CHILDREN_PAGE_SIZE`. */
  limits?: Record<string, number>;
  /** In-flight rename / create, rendered inline. */
  edit?: EditState;
}

/**
 * Project the tree into the flat, ordered list of visible rows.
 *
 * Directories are listed before files and each group is sorted by name, so the
 * order is stable regardless of the order the backend returned children in.
 */
export function flattenTree({
  root,
  children,
  expanded,
  limits = {},
  edit = null,
}: FlattenArgs): TreeRow[] {
  const rows: TreeRow[] = [];
  const seen = new Set<string>();

  const walk = (dir: string, depth: number): void => {
    // Defensive: a symlink cycle must not hang the renderer.
    if (seen.has(dir)) return;
    seen.add(dir);

    if (edit && edit.kind !== "rename" && edit.dir === dir) {
      rows.push({
        kind: "input",
        key: `input:${dir}:${edit.kind}`,
        depth,
        dir,
        inputKind: edit.kind,
      });
    }

    const all = sortNodes(children[dir] ?? []);
    const limit = Math.max(1, limits[dir] ?? CHILDREN_PAGE_SIZE);
    const visible = all.slice(0, limit);

    for (const node of visible) {
      const renaming = edit?.kind === "rename" && edit.path === node.path;
      rows.push({
        kind: renaming ? "rename" : "node",
        key: node.path,
        depth,
        node,
      });
      if (node.kind === "dir" && expanded[node.path]) {
        walk(node.path, depth + 1);
      }
    }

    if (all.length > visible.length) {
      rows.push({
        kind: "load-more",
        key: `more:${dir}`,
        depth,
        dir,
        shown: visible.length,
        total: all.length,
      });
    }
  };

  walk(root, 0);
  return rows;
}

/** Directories first, then files; each group sorted case-insensitively. */
export function sortNodes(nodes: FileNode[]): FileNode[] {
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/** How many children of `dir` are still hidden behind "Load more". */
export function hiddenCount(
  dir: string,
  children: Record<string, FileNode[]>,
  limits: Record<string, number>,
): number {
  const total = (children[dir] ?? []).length;
  const limit = Math.max(1, limits[dir] ?? CHILDREN_PAGE_SIZE);
  return Math.max(0, total - limit);
}

/** Grow `dir`'s reveal limit by one page. */
export function revealMore(
  limits: Record<string, number>,
  dir: string,
  page = CHILDREN_PAGE_SIZE,
): Record<string, number> {
  const current = limits[dir] ?? page;
  return { ...limits, [dir]: current + page };
}

/** Left padding in px for a row at `depth`. */
export function indentFor(depth: number): number {
  return depth * 12 + 6;
}
