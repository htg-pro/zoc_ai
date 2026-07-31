/**
 * A hunk's lines, header, and accessible name — zoc-agent-chat-rebuild R10.2, R10.11–R10.14, R21.5,
 * R21.7, task 18.2.
 *
 * The arithmetic half of the diff review, split from the components for the reason the timeline's model
 * is split from `ToolEntry`: line classification, numbering, the two side flags, and the accessible name
 * are all facts about a `Hunk`, and Properties 20, 21, and 56 should be assertable without mounting a
 * tree.
 *
 * ## Line numbers come from the hunk, not from the patch header
 *
 * `Hunk` carries `oldStart`, `oldLines`, `newStart`, and `newLines` as validated fields, and `patch` as
 * "the unified-diff body for this hunk only, without the file header" — which may or may not begin with
 * an `@@` line depending on the producer. Numbering from the fields is therefore both simpler and
 * strictly more reliable: a malformed or absent `@@` line cannot shift every line number in the body.
 * A leading `@@` line is skipped when present, because it is a restatement of what the fields say.
 *
 * ## Why a glyph *and* a tint
 *
 * R21.7 asks that state be distinguishable without colour perception. A background tint alone fails
 * that; a `+`/`−` in the gutter alone is easy to miss at 12 px in a monospace column. Both, always, from
 * one function — so a row cannot decide to draw the tint and skip the glyph.
 */

import type { Hunk, HunkAction } from "@zoc-studio/shared-types";

export type HunkLineKind = "add" | "remove" | "context";

export interface HunkLine {
  readonly kind: HunkLineKind;
  readonly text: string;
  /** 1-based line number in the pre-change file. Absent on an added line. */
  readonly oldNumber?: number;
  /** 1-based line number in the post-change file. Absent on a removed line. */
  readonly newNumber?: number;
}

/** Body lines past this many collapse behind a show-all control. */
export const HUNK_COLLAPSE_LINES = 40;

/** The gutter glyph per line kind: the non-colour carrier of "added" and "removed" (R21.7). */
export function gutterGlyphOf(kind: HunkLineKind): string {
  switch (kind) {
    case "add":
      return "+";
    case "remove":
      // U+2212, matching the `+n −m` counts elsewhere in the card rather than the ASCII hyphen the
      // patch itself uses.
      return "−";
    case "context":
      return " ";
  }
}

/**
 * One hunk's patch, parsed into numbered lines.
 *
 * A `\ No newline at end of file` marker is dropped: it is diff metadata rather than file content, and
 * rendering it as a context line would put a sentence in the middle of the code that is not in the file.
 */
export function hunkLines(hunk: Hunk): readonly HunkLine[] {
  const lines: HunkLine[] = [];
  let oldNumber = hunk.oldStart;
  let newNumber = hunk.newStart;

  const raw = hunk.patch.split("\n");
  // A trailing empty element is the artefact of a patch ending in a newline, not a blank line in the
  // file. Dropping it here keeps every hunk from rendering one phantom line at the end.
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();

  for (const line of raw) {
    if (line.startsWith("@@")) continue;
    if (line.startsWith("\\")) continue;

    if (line.startsWith("+")) {
      lines.push({ kind: "add", text: line.slice(1), newNumber });
      newNumber += 1;
      continue;
    }
    if (line.startsWith("-")) {
      lines.push({ kind: "remove", text: line.slice(1), oldNumber });
      oldNumber += 1;
      continue;
    }
    // A context line is prefixed with a space in a well-formed patch. An unprefixed line is taken as
    // context rather than discarded: a producer that trimmed trailing whitespace is a common enough
    // bug that losing the line would be the worse failure.
    lines.push({
      kind: "context",
      text: line.startsWith(" ") ? line.slice(1) : line,
      oldNumber,
      newNumber,
    });
    oldNumber += 1;
    newNumber += 1;
  }

  return lines;
}

/** Added and removed line counts for one hunk, from its parsed body. */
export function hunkCounts(hunk: Hunk): { readonly added: number; readonly removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of hunkLines(hunk)) {
    if (line.kind === "add") added += 1;
    else if (line.kind === "remove") removed += 1;
  }
  return { added, removed };
}

/**
 * Which sides of the diff a file's action has (R10.12, R10.13).
 *
 * A `create` has no pre-change side and a `delete` has no post-change side, and the corresponding gutter
 * column is *omitted* rather than rendered blank — an empty column reads as "nothing was removed from a
 * file that existed", which is a different and wrong statement.
 */
export function sidesOf(action: HunkAction): { readonly pre: boolean; readonly post: boolean } {
  switch (action) {
    case "create":
      return { pre: false, post: true };
    case "delete":
      return { pre: true, post: false };
    case "modify":
    case "rename":
      return { pre: true, post: true };
  }
}

/**
 * The hunk's header line.
 *
 * `modify` and `rename` get the conventional `@@ −a,b +c,d @@`. `create` and `delete` get a sentence
 * instead, because their conventional form contains a zero-length range — `@@ -1,0 +1,41 @@` — and a
 * reader has to decode which side the zero is on to learn the one fact that matters.
 */
export function hunkHeaderOf(hunk: Hunk, action: HunkAction): string {
  const counts = hunkCounts(hunk);
  if (action === "create") return `@@ new file, +${String(counts.added)} @@`;
  if (action === "delete") return `@@ deleted file, −${String(counts.removed)} @@`;
  return `@@ −${String(hunk.oldStart)},${String(hunk.oldLines)} +${String(hunk.newStart)},${String(hunk.newLines)} @@`;
}

/**
 * R21.5's accessible name: the file path and the hunk's line range.
 *
 * The range is the pre-change one, inclusive, and an empty pre-change range — a `create` — is named as
 * the post-change range instead. "lines 1–0" is what the naive arithmetic produces there, and a screen
 * reader announcing a backwards range is worse than no range at all.
 */
export function hunkAccessibleName(path: string, hunk: Hunk): string {
  if (hunk.oldLines === 0) {
    const end = hunk.newStart + Math.max(1, hunk.newLines) - 1;
    return `${path}, new lines ${String(hunk.newStart)}–${String(end)}`;
  }
  const end = hunk.oldStart + hunk.oldLines - 1;
  return `${path}, lines ${String(hunk.oldStart)}–${String(end)}`;
}

/**
 * The single letter per action, which is the fixed-width column the plan card's file rows reserve
 * (R10.11).
 *
 * Here rather than beside `ActionBadge` for the fast-refresh reason the rest of the feature follows: a
 * module exporting both a component and a value is a refresh boundary, and both of these are read by
 * `PlanRow` as well as by the badge.
 */
export const ACTION_LETTER: Readonly<Record<HunkAction, string>> = {
  create: "A",
  modify: "M",
  delete: "D",
  rename: "R",
};

/** The word a file row's accessible name uses, since a spoken "A" means nothing. */
export const ACTION_WORD: Readonly<Record<HunkAction, string>> = {
  create: "create",
  modify: "modify",
  delete: "delete",
  rename: "rename",
};

/** The words a diff header states its action in, so a reader never decodes the badge letter. */
export function actionLabelOf(action: HunkAction, sourcePath?: string | null): string {
  switch (action) {
    case "create":
      return "New file";
    case "delete":
      return "Deleted";
    case "rename":
      return sourcePath === null || sourcePath === undefined
        ? "Renamed"
        : `Renamed from ${sourcePath}`;
    case "modify":
      return "Modified";
  }
}
