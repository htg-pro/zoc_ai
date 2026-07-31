/**
 * The tool-call timeline's model — zoc-agent-chat-rebuild R9.2, R9.4, R9.5, R9.7, 16.1.
 *
 * Everything about a timeline entry that is a *decision* rather than a layout lives here as a
 * pure function: which shape a node takes, how a path is truncated, what the metric column
 * reads, where a cluster begins, and what a screen reader is told. The components below are
 * then only spacing and elements.
 *
 * That split is deliberate and Properties 44, 45, and 46 are why. Clustering at "more than
 * three consecutive calls" is an off-by-one waiting to happen, path truncation has an
 * invariant a renderer cannot state, and an accessible name assembled inline is one nobody can
 * test without mounting a tree. All three are arithmetic, so all three are testable as
 * arithmetic.
 */

import type { ToolKind } from "@zoc-studio/shared-types";

/**
 * R9.5's threshold, as the design words it: clustering fires at the **fourth** consecutive
 * call, so a run of three stays individually legible.
 *
 * Named rather than inlined because the requirement is "more than 3" and the comparison is
 * `> CLUSTER_THRESHOLD` — writing `>= 4` at the call site would be the same number and a
 * worse record of which reading it implements.
 */
export const CLUSTER_THRESHOLD = 3;

/** Paths listed in full before the entry collapses to a count (R9.4). */
export const MAX_LISTED_PATHS = 3;

/** A path longer than this is middle-truncated. */
export const MAX_PATH_CHARS = 44;

/**
 * The six node shapes, one per `ToolKind`.
 *
 * **Shape encodes what the tool did, not which tool it was**, which is what makes a run's
 * timeline scannable: a reader learns six shapes once rather than a glyph per tool. It is also
 * R21.7's requirement met structurally — the state is in the shape, so colour is never the
 * only carrier.
 */
export type NodeShape =
  | "circle-hollow"
  | "circle-filled"
  | "square"
  | "diamond"
  | "triangle"
  | "diamond-hollow";

const SHAPE_BY_KIND: Readonly<Record<ToolKind, NodeShape>> = {
  read: "circle-hollow",
  write: "circle-filled",
  execute: "square",
  mcp: "diamond",
  network: "triangle",
  search: "diamond-hollow",
};

/** A failed call's node, whatever its kind: a filled square in the error colour (R9.6). */
export const FAILURE_SHAPE: NodeShape = "square";

export function nodeShapeOf(kind: ToolKind, state: ToolEntryState): NodeShape {
  return state === "failed" ? FAILURE_SHAPE : SHAPE_BY_KIND[kind];
}

/** Where a call is in its lifecycle. `denied` is a permission refusal, not a failure. */
export type ToolEntryState = "running" | "succeeded" | "failed" | "denied";

/** The state word a screen reader hears, and the one the row shows as text (R21.7). */
const STATE_LABEL: Readonly<Record<ToolEntryState, string>> = {
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  denied: "denied",
};

export function stateLabelOf(state: ToolEntryState): string {
  return STATE_LABEL[state];
}

/**
 * A duration, at the precision the metric column can use.
 *
 * Sub-second in milliseconds and seconds to one decimal, for the reason the reasoning row's
 * formatter gives: `0s` reads as "it did not happen". Separate from that formatter rather than
 * shared, because this one is a *column* — it is read alongside twenty others and wants a
 * narrow, uniform width, whereas the reasoning row's stands alone in a sentence.
 */
export function formatDuration(durationMs: number): string {
  const safe = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  if (safe < 1000) return `${String(Math.round(safe))}ms`;
  const seconds = safe / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${String(Math.floor(seconds / 60))}m ${String(Math.round(seconds % 60))}s`;
}

/**
 * Middle-truncate a path so the filename survives (R9.4).
 *
 * **The filename is the invariant**, and it is why this is not a `slice`: a reader scanning a
 * timeline identifies an entry by its file, so `src/features/…/Composer.tsx` is useful and
 * `src/features/chat/composer/Comp…` is not. The head is kept too, because the first segment
 * is what distinguishes `src/` from `test/`.
 *
 * A filename alone longer than the budget is returned whole rather than truncated. Cutting it
 * would defeat the entire point of the function, and an over-wide cell is the lesser cost.
 */
export function truncatePath(path: string, maxChars: number = MAX_PATH_CHARS): string {
  if (path.length <= maxChars) return path;

  const lastSlash = path.lastIndexOf("/");
  const filename = lastSlash === -1 ? path : path.slice(lastSlash + 1);
  if (filename.length + 2 >= maxChars) return filename;

  // The ellipsis costs one character; the rest is split between head and tail, with the tail
  // taking the filename in full.
  const headBudget = maxChars - filename.length - 2;
  return `${path.slice(0, headBudget)}…/${filename}`;
}

/**
 * The path list an entry shows, collapsing past three to a count (R9.4).
 *
 * The *first* path is named in the collapsed form rather than the count standing alone, because
 * "4 files" tells a reader nothing they can act on and `Composer.tsx and 3 more` tells them
 * where the change landed.
 *
 * **Duplicates are removed, and that is a correctness fix rather than tidying.** Property 44
 * calls these "path sets", and the runtime can legitimately report the same path twice — a tool
 * that read a file, wrote it, and read it back. Rendering a list keyed by path would then give
 * React duplicate keys, which drops elements unpredictably: a path present twice in the data
 * would be *less* reachable than one present once. Deduplicating makes the set semantics real,
 * and it also makes the count the user sees the number of distinct files touched, which is the
 * number they care about.
 */
export function summarisePaths(
  paths: readonly string[],
  maxListed: number = MAX_LISTED_PATHS,
): { readonly shown: readonly string[]; readonly overflow: number } {
  const unique = [...new Set(paths)];
  if (unique.length <= maxListed) return { shown: unique, overflow: 0 };
  return { shown: unique.slice(0, 1), overflow: unique.length - 1 };
}

/** One tool call, reduced to what a timeline entry renders. */
export interface ToolEntryModel {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly kind: ToolKind;
  readonly state: ToolEntryState;
  readonly durationMs: number;
  /** The one-line summary the runtime produced, if the call has finished. */
  readonly summary?: string;
  /** The model's arguments, for the expanded detail (R9.3). */
  readonly input?: string;
  /** The tool's result, for the expanded detail. */
  readonly output?: string;
  readonly readPaths?: readonly string[];
  readonly writtenPaths?: readonly string[];
  /** Set when `state` is `failed` or `denied`. */
  readonly error?: { readonly code: string; readonly message: string; readonly retryable: boolean };
  /** `142L`, `+24 −11`, `exit 0`, `12 hits` — the runtime's own figure. */
  readonly metric?: string;
}

/**
 * The accessible name R9.7 and R21.4 require: tool name, state, duration.
 *
 * A function rather than a template at the call site, so Property 46 can assert the *contract*
 * — that all three facts are present — without mounting a tree, and so the cluster and the
 * entry cannot drift into naming themselves differently.
 */
export function accessibleNameOf(entry: ToolEntryModel): string {
  return `${entry.toolName}, ${stateLabelOf(entry.state)}, ${formatDuration(entry.durationMs)}`;
}

/** Either one call, or a run of consecutive calls to the same tool collapsed into one row. */
export type TimelineItem =
  | { readonly kind: "entry"; readonly entry: ToolEntryModel }
  | {
      readonly kind: "cluster";
      readonly toolName: string;
      readonly toolKind: ToolKind;
      /** The run length, which is what the row displays as `N × toolName` (R9.5). */
      readonly count: number;
      readonly members: readonly ToolEntryModel[];
      /** Summed across members, so the cluster carries one duration like an entry does. */
      readonly durationMs: number;
      /** `failed` when any member failed — a cluster hiding a failure would be worse than no cluster. */
      readonly state: ToolEntryState;
    };

/**
 * Group consecutive same-tool calls, clustering past the threshold (R9.5).
 *
 * **Consecutive, not merely repeated**, and that is the load-bearing word: `read read write
 * read read` is four reads in total and no run longer than two, so it clusters nothing. A
 * grouping by tool name over the whole sequence would collapse those four into one row and
 * destroy the ordering the timeline exists to show.
 *
 * A cluster's state is `failed` if **any** member failed. Reporting a cluster as succeeded
 * because most of it did would hide the one entry the user needs to open.
 */
export function groupTimeline(entries: readonly ToolEntryModel[]): readonly TimelineItem[] {
  const items: TimelineItem[] = [];
  let index = 0;

  while (index < entries.length) {
    const first = entries[index] as ToolEntryModel;
    let end = index + 1;
    while (end < entries.length && entries[end]?.toolName === first.toolName) end += 1;
    const run = entries.slice(index, end);

    if (run.length > CLUSTER_THRESHOLD) {
      items.push({
        kind: "cluster",
        toolName: first.toolName,
        toolKind: first.kind,
        count: run.length,
        members: run,
        durationMs: run.reduce((total, member) => total + member.durationMs, 0),
        state: clusterStateOf(run),
      });
    } else {
      for (const entry of run) items.push({ kind: "entry", entry });
    }
    index = end;
  }

  return items;
}

/**
 * A cluster's single state, worst-first.
 *
 * `failed` outranks `running` outranks `denied` outranks `succeeded`: a failure is the thing
 * that needs attention, and a cluster still running is not yet a success.
 */
function clusterStateOf(run: readonly ToolEntryModel[]): ToolEntryState {
  if (run.some((entry) => entry.state === "failed")) return "failed";
  if (run.some((entry) => entry.state === "running")) return "running";
  if (run.some((entry) => entry.state === "denied")) return "denied";
  return "succeeded";
}
