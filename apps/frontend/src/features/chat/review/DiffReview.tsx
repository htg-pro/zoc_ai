/**
 * One file's diff — zoc-agent-chat-rebuild R10.2, R10.8, R10.12, R10.13, R10.14, R21.5, task 18.2.
 *
 * Feature: zoc-agent-chat-rebuild, task 18.2 (R10.2, R10.8, R10.12, R10.13, R10.14, R21.5).
 *
 * The header states the action in words, the hunks are a `role="list"` of {@link HunkRow}s, and a stale
 * file gets a warning strip with `Regenerate` instead of an accept/reject pair on every hunk.
 *
 * ## One component with four rendering modes rather than four components
 *
 * All four actions arrive as the same `DiffPart` → `Hunk` structure, so what differs between them is
 * which sides exist and what the header says. `sidesOf` in `hunk-lines.ts` answers the first and
 * `actionLabelOf` the second, which keeps the difference between a create and a modify to two function
 * calls instead of two files that drift apart.
 *
 * ## A pure rename has no hunks, and it is still a decision
 *
 * The change is entirely in the path, so there is nothing to review line by line — and it still has to
 * be acceptable or not. That decision lands under the store's reserved `__file__` key and is rendered
 * here as the file-level pair. It is the reason `ApplySelection` carries `acceptedFiles` beside
 * `hunkIds`: a hunkless change contributes no hunk id and still has to reach apply.
 *
 * ## Focus navigation lives here because the list does
 *
 * `J`/`K` and the arrows move between hunks, and "between" is a fact about the list rather than about a
 * row. The rows report a direction; this component finds the neighbour in its own subtree and focuses
 * it, clamped at both ends — a wrap would move a reviewer from the last hunk to the first without
 * telling them the list ended.
 */
import { useRef } from "react";

import { cn } from "@/lib/utils";
import type { DiffPart } from "@zoc-studio/shared-types";
import { FILE_LEVEL_DECISION, type HunkDecision } from "../store";
import { HunkRow } from "./HunkRow";
import { actionLabelOf } from "./hunk-lines";

/** The copy a stale diff shows, kept verbatim from the legacy panel so the phrasing is familiar. */
export const STALE_COPY = "The file changed since this was proposed.";

export interface DiffReviewProps {
  diff: DiffPart;
  /** Computed by the card through `isStale`, so one staleness rule serves the whole review. */
  stale: boolean;
  /** hunkId → decision for this file, plus the reserved file-level key. */
  decisions: Readonly<Record<string, HunkDecision>>;
  /**
   * Whether one hunk's long body is shown in full.
   *
   * A predicate rather than a `Set`, because the store keys expansion by a row id that includes the
   * plan and the path — hunk ids are unique only *within* a file — and building a per-file `Set` on
   * every render to hide that would allocate one collection per file per commit.
   */
  isExpanded: (hunkId: string) => boolean;
  onDecideHunk: (hunkId: string, decision: HunkDecision) => void;
  onDecideFile: (decision: HunkDecision) => void;
  onExpandedChange: (hunkId: string, expanded: boolean) => void;
  /** Absent means no regeneration is offered, which is only true outside a stale file. */
  onRegenerate?: () => void;
  /** R1.4: a read-only viewer reads the diff and decides nothing, so the controls are absent. */
  readOnly?: boolean;
  className?: string;
}

export function DiffReview({
  diff,
  stale,
  decisions,
  isExpanded,
  onDecideHunk,
  onDecideFile,
  onExpandedChange,
  onRegenerate,
  readOnly = false,
  className,
}: DiffReviewProps) {
  const listRef = useRef<HTMLOListElement | null>(null);

  const moveFocus = (delta: 1 | -1) => {
    const list = listRef.current;
    if (list === null) return;
    const rows = [...list.querySelectorAll<HTMLElement>("[data-zoc-hunk-row]")];
    const current = rows.findIndex((row) => row === document.activeElement);
    if (current === -1) {
      rows[0]?.focus();
      return;
    }
    // Clamped rather than wrapped: reaching the end of a review is information, and a silent jump to
    // the other end loses it.
    const next = Math.min(rows.length - 1, Math.max(0, current + delta));
    rows[next]?.focus();
  };

  const fileDecision = decisions[FILE_LEVEL_DECISION] ?? "undecided";

  return (
    <div
      className={cn("flex flex-col", className)}
      data-zoc-diff-review={diff.path}
      style={{ gap: "var(--zoc-row-gap-tight)" }}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <span
          data-zoc-diff-action={diff.action}
          style={{ color: "var(--zoc-text-secondary)", fontSize: "var(--zoc-text-label)" }}
        >
          {actionLabelOf(diff.action, diff.sourcePath)}
        </span>
        {/*
          R10.14: both ends of a move, and the source is a separate element so a test can assert the
          old path is present rather than inferring it from a sentence.
        */}
        {diff.action === "rename" && diff.sourcePath !== null && diff.sourcePath !== undefined ? (
          <span
            className="font-mono"
            data-zoc-diff-source-path={diff.sourcePath}
            style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-meta)" }}
          >
            {diff.sourcePath} → {diff.path}
          </span>
        ) : (
          <span
            className="font-mono"
            data-zoc-diff-path={diff.path}
            style={{ color: "var(--zoc-text-secondary)", fontSize: "var(--zoc-text-meta)" }}
          >
            {diff.path}
          </span>
        )}
      </div>

      {stale ? (
        <div
          className="flex flex-wrap items-center gap-2 rounded-[var(--zoc-radius-chip)] px-2 py-1"
          data-zoc-diff-stale=""
          style={{
            backgroundColor: "var(--zoc-row-bg)",
            border: "1px solid var(--zoc-border)",
          }}
        >
          <span style={{ color: "var(--zoc-text)", fontSize: "var(--zoc-text-meta)" }}>
            {STALE_COPY}
          </span>
          {onRegenerate === undefined ? null : (
            <button
              type="button"
              data-zoc-diff-regenerate=""
              onClick={onRegenerate}
              className="rounded-[var(--zoc-radius-chip)] px-1.5 py-0.5 hover:bg-[var(--zoc-elev-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]"
              style={{ color: "var(--zoc-text)", fontSize: "var(--zoc-text-label)" }}
            >
              Regenerate
            </button>
          )}
        </div>
      ) : null}

      {diff.hunks.length === 0 ? (
        // A hunkless change — a pure rename. One decision for the file, and no list at all: an empty
        // `role="list"` announced as "list, 0 items" would tell a screen-reader user there was
        // something to review here and that it is missing.
        <div className="flex items-center gap-2" data-zoc-diff-file-decision={fileDecision}>
          <span style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-meta)" }}>
            No content change to review.
          </span>
          {stale || readOnly ? null : (
            <>
              <button
                type="button"
                data-zoc-file-accept=""
                aria-pressed={fileDecision === "accepted"}
                onClick={() => {
                  onDecideFile(fileDecision === "accepted" ? "undecided" : "accepted");
                }}
                className="rounded-[var(--zoc-radius-chip)] px-1.5 py-0.5 hover:bg-[var(--zoc-row-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]"
                style={{
                  color:
                    fileDecision === "accepted" ? "var(--zoc-success)" : "var(--zoc-text-muted)",
                  fontSize: "var(--zoc-text-label)",
                }}
              >
                Accept
              </button>
              <button
                type="button"
                data-zoc-file-reject=""
                aria-pressed={fileDecision === "rejected"}
                onClick={() => {
                  onDecideFile(fileDecision === "rejected" ? "undecided" : "rejected");
                }}
                className="rounded-[var(--zoc-radius-chip)] px-1.5 py-0.5 hover:bg-[var(--zoc-row-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]"
                style={{
                  color: fileDecision === "rejected" ? "var(--zoc-error)" : "var(--zoc-text-muted)",
                  fontSize: "var(--zoc-text-label)",
                }}
              >
                Reject
              </button>
            </>
          )}
        </div>
      ) : (
        <ol
          ref={listRef}
          role="list"
          className="flex list-none flex-col"
          data-zoc-hunk-list={diff.path}
          aria-label={`Hunks in ${diff.path}`}
          style={{ gap: "var(--zoc-row-gap)" }}
        >
          {diff.hunks.map((hunk) => (
            <HunkRow
              key={hunk.hunkId}
              path={diff.path}
              action={diff.action}
              hunk={hunk}
              decision={decisions[hunk.hunkId] ?? "undecided"}
              locked={stale || readOnly}
              expanded={isExpanded(hunk.hunkId)}
              onExpandedChange={(open) => {
                onExpandedChange(hunk.hunkId, open);
              }}
              onDecide={(decision) => {
                onDecideHunk(hunk.hunkId, decision);
              }}
              onMove={moveFocus}
            />
          ))}
        </ol>
      )}
    </div>
  );
}
