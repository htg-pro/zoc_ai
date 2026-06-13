export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffLine {
  kind: "add" | "del" | "ctx" | "meta";
  text: string;
  oldNum?: number;
  newNum?: number;
}

export function parseUnifiedDiff(diff: string): { hunks: DiffHunk[]; adds: number; dels: number } {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let adds = 0;
  let dels = 0;
  let oldNum = 0;
  let newNum = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("---") || raw.startsWith("+++") || raw.startsWith("diff ") || raw.startsWith("index ")) {
      // skip file headers; the diff card shows file path separately
      continue;
    }
    if (raw.startsWith("@@")) {
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldNum = Number.parseInt(m[1], 10);
        newNum = Number.parseInt(m[2], 10);
      }
      current = { header: raw, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) {
      current = { header: "", lines: [] };
      hunks.push(current);
    }
    if (raw.startsWith("+")) {
      current.lines.push({ kind: "add", text: raw.slice(1), newNum });
      newNum += 1;
      adds += 1;
    } else if (raw.startsWith("-")) {
      current.lines.push({ kind: "del", text: raw.slice(1), oldNum });
      oldNum += 1;
      dels += 1;
    } else {
      current.lines.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw, oldNum, newNum });
      oldNum += 1;
      newNum += 1;
    }
  }
  return { hunks, adds, dels };
}

// ── Diff-review extension (R5, R10) ──────────────────────────────────
// Pure helpers for the diff-review workspace: line classification,
// "Review Pending" aggregation, change-position navigation with clamping,
// per-file apply/undo set operations, and applied-id persistence.

import type { DiffPatch } from "@llama-studio/shared-types";

export type LineKind = DiffLine["kind"];

export interface ReviewSummary {
  /** Number of changed files. */
  files: number;
  /** Total added lines across all files. */
  adds: number;
  /** Total removed lines across all files. */
  dels: number;
}

/** Per-file added/removed counts, parsed from a single patch (R5.4). */
export function patchCounts(patch: DiffPatch): { adds: number; dels: number } {
  const { adds, dels } = parseUnifiedDiff(patch.unified_diff);
  return { adds, dels };
}

/**
 * Aggregate the "Review Pending" summary across pending patches (R5.2).
 * All three values are non-negative integers; an empty set yields all-zeros.
 */
export function reviewSummary(patches: DiffPatch[]): ReviewSummary {
  let adds = 0;
  let dels = 0;
  for (const p of patches) {
    const c = patchCounts(p);
    adds += c.adds;
    dels += c.dels;
  }
  return { files: patches.length, adds, dels };
}

/** Clamp a 0-based change index into [0, count-1]; -1 when there are no changes. */
export function clampIndex(index: number, count: number): number {
  if (count <= 0) return -1;
  if (index < 0) return 0;
  if (index > count - 1) return count - 1;
  return index;
}

/** Next change, clamped at the last change (R5.5, R5.9). */
export function nextIndex(index: number, count: number): number {
  return clampIndex(index + 1, count);
}

/** Previous change, clamped at the first change (R5.6, R5.10). */
export function prevIndex(index: number, count: number): number {
  return clampIndex(index - 1, count);
}

/** 1-based display position "N of M" for the Review_Toolbar (R5.4). */
export function changePosition(
  index: number,
  count: number,
): { n: number; m: number } {
  if (count <= 0) return { n: 0, m: 0 };
  return { n: clampIndex(index, count) + 1, m: count };
}

/**
 * Remove exactly one file from the pending review set (apply or undo), leaving
 * every other pending file unchanged (R5.7, R5.8, R10.1, R10.2).
 */
export function removePatch(patches: DiffPatch[], id: string): DiffPatch[] {
  return patches.filter((p) => p.id !== id);
}

// ── Applied-id persistence (R10.6) ───────────────────────────────────

export function serializeAppliedIds(ids: ReadonlySet<string>): string {
  return JSON.stringify([...ids].sort());
}

export function deserializeAppliedIds(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr)
      ? new Set(arr.filter((x) => typeof x === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

/** Mark a patch id as applied (R10.6). */
export function markApplied(
  ids: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(ids);
  next.add(id);
  return next;
}

export function isApplied(ids: ReadonlySet<string>, id: string): boolean {
  return ids.has(id);
}
