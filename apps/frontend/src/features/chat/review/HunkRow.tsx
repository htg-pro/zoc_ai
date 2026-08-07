/**
 * One reviewable hunk — zoc-agent-chat-rebuild R10.2, R10.3, R10.12, R10.13, R21.5, R21.7, task 18.2.
 *
 * Feature: zoc-agent-chat-rebuild, task 18.2 (R10.2, R10.3, R10.12, R10.13, R21.5, R21.7).
 *
 * A header line, the accept/reject pair, and the diff body under both. Focusable, with the accessible
 * name R21.5 asks for — the file path and the hunk's line range — and operable entirely from the
 * keyboard: `A` accepts, `R` rejects, `Space` toggles, `J`/`K` and the arrows move between hunks, and
 * `Enter` reveals the rest of a long body.
 *
 * ## Why an accept/reject pair rather than the design's checkbox
 *
 * design.md's Radix table pairs "hunk accept/reject" with `@radix-ui/react-checkbox` on the grounds that
 * "tri-state is unnecessary". A checkbox is binary, and R10.3's decision model is not: `undecided` is the
 * default, and it is distinguishable from `rejected` in the one place it matters — the footer reads
 * "0 of 12 hunks accepted" for a review nobody has started and for a review where every hunk was
 * explicitly turned down, and those are different states of the user's attention. A checkbox would have
 * to encode `undecided` as unchecked, which makes "I have read this and I do not want it" and "I have not
 * looked" the same fact. So the pair is two `aria-pressed` buttons, and neither pressed *is* `undecided`.
 * The keyboard affordance the checkbox was chosen for is supplied directly, and by more keys than a
 * checkbox offers.
 *
 * ## Why a stale file's controls are absent rather than disabled
 *
 * The same rule `ToolEntry` follows for a non-retryable failure: a disabled control invites a user to
 * work out why it is disabled. A stale hunk has no accept/reject pair, and the file's warning strip
 * states the reason and offers `Regenerate` — which is the action that can actually help (R10.8).
 *
 * ## Why the tint is never alone
 *
 * Added and removed lines carry a background tint *and* a gutter glyph, both from
 * `hunk-lines.ts`, because R21.7 forbids carrying state in colour alone. The two columns of line
 * numbers are the third signal, and which of them exists is what R10.12 and R10.13 ask for: a `create`
 * has no pre-change column at all, and a `delete` has no post-change column — omitted rather than
 * rendered blank, because a blank column reads as "nothing was removed from a file that existed".
 */
import { useMemo, type KeyboardEvent } from "react";

import { cn } from "@/lib/utils";
import type { Hunk, HunkAction } from "@zoc-studio/shared-types";
import type { HunkDecision } from "../store";
import {
  HUNK_COLLAPSE_LINES,
  gutterGlyphOf,
  hunkAccessibleName,
  hunkCounts,
  hunkHeaderOf,
  hunkLines,
  sidesOf,
  type HunkLineKind,
} from "./hunk-lines";

/** The tint per line kind. Backgrounds only; the glyph beside them is the non-colour carrier. */
function tintOf(kind: HunkLineKind): string | undefined {
  switch (kind) {
    case "add":
      return "var(--zoc-diff-add-bg)";
    case "remove":
      return "var(--zoc-diff-del-bg)";
    case "context":
      return undefined;
  }
}

function glyphColourOf(kind: HunkLineKind): string {
  switch (kind) {
    case "add":
      return "var(--zoc-success)";
    case "remove":
      return "var(--zoc-error)";
    case "context":
      return "var(--zoc-text-faint)";
  }
}

export interface HunkRowProps {
  /** The file this hunk belongs to. Part of the accessible name (R21.5). */
  path: string;
  action: HunkAction;
  hunk: Hunk;
  decision: HunkDecision;
  /** True when the file is stale: this hunk is not selectable, and the rest of the plan still is. */
  locked?: boolean;
  /** True when a body longer than {@link HUNK_COLLAPSE_LINES} is shown in full. */
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onDecide: (decision: HunkDecision) => void;
  /** Move focus by one hunk. Supplied by `DiffReview`, which owns the list. */
  onMove?: (delta: 1 | -1) => void;
  className?: string;
}

export function HunkRow({
  path,
  action,
  hunk,
  decision,
  locked = false,
  expanded,
  onExpandedChange,
  onDecide,
  onMove,
  className,
}: HunkRowProps) {
  const lines = useMemo(() => hunkLines(hunk), [hunk]);
  const counts = useMemo(() => hunkCounts(hunk), [hunk]);
  const sides = sidesOf(action);
  const overflows = lines.length > HUNK_COLLAPSE_LINES;
  const visible = expanded || !overflows ? lines : lines.slice(0, HUNK_COLLAPSE_LINES);

  const handleKeyDown = (event: KeyboardEvent<HTMLLIElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    switch (event.key) {
      case "a":
      case "A":
        if (locked) return;
        event.preventDefault();
        onDecide("accepted");
        return;
      case "r":
      case "R":
        if (locked) return;
        event.preventDefault();
        onDecide("rejected");
        return;
      case " ":
        if (locked) return;
        // Space flips acceptance rather than cycling through three states: `undecided` is where a
        // review starts, not something a user reaches for, and a toggle that could land back on it
        // would make two presses look like none.
        event.preventDefault();
        onDecide(decision === "accepted" ? "rejected" : "accepted");
        return;
      case "j":
      case "J":
      case "ArrowDown":
        event.preventDefault();
        onMove?.(1);
        return;
      case "k":
      case "K":
      case "ArrowUp":
        event.preventDefault();
        onMove?.(-1);
        return;
      case "Enter":
        // Nothing to disclose gets no disclosure, here as everywhere else in the panel.
        if (!overflows) return;
        event.preventDefault();
        onExpandedChange(!expanded);
        return;
      default:
        return;
    }
  };

  return (
    <li
      className={cn(
        "flex flex-col rounded-[var(--zoc-radius-chip)]",
        // The row is a tab stop (below), so it owes a focus indicator like any other control. Without
        // one, a keyboard user arrowing through a diff has no idea which hunk `A` would accept —
        // which is R21.5's operability sitting on top of an invisible cursor (R21.1).
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]",
        className,
      )}
      data-zoc-hunk-row={hunk.hunkId}
      data-decision={decision}
      {...(locked ? { "data-locked": "" } : {})}
      // Focusable so R21.5's "operable from the keyboard" has something to operate on, and named so a
      // screen-reader user knows which hunk they are on before they press `A`.
      tabIndex={0}
      aria-label={hunkAccessibleName(path, hunk)}
      onKeyDown={handleKeyDown}
      style={{ gap: "var(--zoc-row-gap-tight)" }}
    >
      <div className="flex items-center gap-2">
        <span
          className="font-mono"
          data-zoc-hunk-header=""
          style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-label)" }}
        >
          {hunkHeaderOf(hunk, action)}
        </span>
        <span
          className="font-mono tabular-nums"
          data-zoc-hunk-counts=""
          style={{ color: "var(--zoc-text-faint)", fontSize: "var(--zoc-text-label)" }}
        >
          +{counts.added} −{counts.removed}
        </span>
        <span className="flex-1" />
        {locked ? null : (
          <>
            <button
              type="button"
              data-zoc-hunk-accept=""
              aria-pressed={decision === "accepted"}
              onClick={() => {
                onDecide(decision === "accepted" ? "undecided" : "accepted");
              }}
              className={cn(
                "rounded-[var(--zoc-radius-chip)] px-1.5 py-0.5",
                "hover:bg-[var(--zoc-row-bg)] focus-visible:outline-none focus-visible:ring-2",
                "focus-visible:ring-[color:var(--zoc-agent-strong)]",
              )}
              style={{
                color: decision === "accepted" ? "var(--zoc-success)" : "var(--zoc-text-muted)",
                fontSize: "var(--zoc-text-label)",
              }}
            >
              Accept
            </button>
            <button
              type="button"
              data-zoc-hunk-reject=""
              aria-pressed={decision === "rejected"}
              onClick={() => {
                onDecide(decision === "rejected" ? "undecided" : "rejected");
              }}
              className={cn(
                "rounded-[var(--zoc-radius-chip)] px-1.5 py-0.5",
                "hover:bg-[var(--zoc-row-bg)] focus-visible:outline-none focus-visible:ring-2",
                "focus-visible:ring-[color:var(--zoc-agent-strong)]",
              )}
              style={{
                color: decision === "rejected" ? "var(--zoc-error)" : "var(--zoc-text-muted)",
                fontSize: "var(--zoc-text-label)",
              }}
            >
              Reject
            </button>
          </>
        )}
      </div>

      <div
        className="overflow-x-auto font-mono"
        data-zoc-hunk-body=""
        style={{ fontSize: "var(--zoc-text-meta)", lineHeight: "var(--zoc-leading-meta)" }}
      >
        {visible.map((line, index) => (
          <div
            key={`${String(index)}:${line.kind}`}
            className="flex whitespace-pre"
            data-zoc-hunk-line={line.kind}
            style={{ backgroundColor: tintOf(line.kind) }}
          >
            {sides.pre ? (
              <span
                className="w-10 shrink-0 select-none pr-2 text-right tabular-nums"
                data-zoc-line-old=""
                style={{ color: "var(--zoc-text-faint)" }}
              >
                {line.oldNumber ?? ""}
              </span>
            ) : null}
            {sides.post ? (
              <span
                className="w-10 shrink-0 select-none pr-2 text-right tabular-nums"
                data-zoc-line-new=""
                style={{ color: "var(--zoc-text-faint)" }}
              >
                {line.newNumber ?? ""}
              </span>
            ) : null}
            <span
              className="w-3 shrink-0 select-none"
              data-zoc-line-glyph={line.kind}
              style={{ color: glyphColourOf(line.kind) }}
              aria-hidden
            >
              {gutterGlyphOf(line.kind)}
            </span>
            <span style={{ color: "var(--zoc-text)" }}>{line.text}</span>
          </div>
        ))}
      </div>

      {overflows ? (
        <button
          type="button"
          data-zoc-hunk-show-all=""
          onClick={() => {
            onExpandedChange(!expanded);
          }}
          className="self-start rounded-[var(--zoc-radius-chip)] px-1 py-0.5 hover:bg-[var(--zoc-row-bg)]"
          style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-label)" }}
        >
          {expanded ? "Show fewer lines" : `Show all ${String(lines.length)} lines`}
        </button>
      ) : null}
    </li>
  );
}
