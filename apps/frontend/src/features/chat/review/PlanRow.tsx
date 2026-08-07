/**
 * The plan card — zoc-agent-chat-rebuild R10.1, R10.7, R10.9, R10.11, R10.15, R16.7, R21.5, task 18.2.
 *
 * Feature: zoc-agent-chat-rebuild, task 18.2 (R10.1, R10.7, R10.9, R10.11, R10.15, R16.7).
 *
 * The decision tier's one card: a file list with an action badge and per-file change counts, the verify
 * line, and a footer that is the commit point. After an apply it stops being a review and becomes a
 * receipt naming what landed, under which checkpoint, and what rolling back would do.
 *
 * ## The card reads the store rather than taking decisions as props
 *
 * A hunk row writes a decision and this footer reads it, three levels up. Threading that through props
 * would put the review's state in whatever renders the transcript — which is the case `store.ts` exists
 * for and the reason `hunkDecisions` is keyed plan → path → hunk rather than flat.
 *
 * ## Why the footer's numbers come from one function
 *
 * `Apply (4)` and `4 of 4 hunks accepted` are the same count, and a card that derived them separately is
 * a card where they can disagree. Both read `reviewTally`, and the apply button's own payload comes from
 * `applicableHunks` — so the number on the button is the length of the list the button sends.
 *
 * ## Discard writes nothing, and that is the whole of R10.9
 *
 * Discarding clears this plan's decisions and reports the intent upward. There is no filesystem call on
 * that path by construction: apply is the only thing that ever sends hunk ids, and a discarded plan's
 * selection is empty because its decisions are gone. Property 22 asserts exactly that.
 */
import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import type { DiffPart, PlanPart } from "@zoc-studio/shared-types";
import { ActionBadge } from "./ActionBadge";
import { DiffReview } from "./DiffReview";
import { useChatSurface, type HunkDecision } from "../store";
import type { ApplyReceipt } from "./apply-receipt";
import { ACTION_WORD } from "./hunk-lines";
import {
  applicableHunks,
  applyDisabledReason,
  applyEnabled,
  isStale,
  reviewTally,
  type ApplySelection,
} from "./hunk-selection";

/** The store key for one hunk's expansion state: unique across files, which a hunk id is not. */
function hunkRowKey(planId: string, path: string, hunkId: string): string {
  return `${planId}|${path}|${hunkId}`;
}

/** The store key for one file's disclosure. */
function fileRowKey(planId: string, path: string): string {
  return `${planId}|${path}`;
}

function pluralHunks(count: number): string {
  return count === 1 ? "1 hunk" : `${String(count)} hunks`;
}

export interface PlanRowProps {
  plan: PlanPart;
  /** The diffs for this plan. A file with no diff yet renders its row and discloses nothing. */
  diffs: readonly DiffPart[];
  /**
   * path → the file's current digest on disk, for the staleness check (R10.8).
   *
   * Checked here on every render rather than once on arrival, because the second of R10.8's two moments
   * is the one that matters: the file changes during the minutes a reviewer spends reading.
   */
  onDisk?: ReadonlyMap<string, string>;
  /** Set once the plan has been applied. The card becomes this receipt (R10.15, R16.7). */
  receipt?: ApplyReceipt | null;
  onApply?: (selection: ApplySelection) => void;
  onDiscard?: () => void;
  onRegenerate?: (path: string) => void;
  onRollback?: (checkpointId: string) => void;
  /**
   * R1.4: a read-only viewer reads the plan and decides nothing.
   *
   * Set, the footer keeps its tally and loses its two controls, and every file's hunks become
   * undecidable — the card is still the whole answer to "what was proposed", which is what a viewer
   * came for.
   */
  readOnly?: boolean;
  className?: string;
}

export function PlanRow({
  plan,
  diffs,
  onDisk,
  receipt,
  onApply,
  onDiscard,
  onRegenerate,
  onRollback,
  readOnly = false,
  className,
}: PlanRowProps) {
  const hunkDecisions = useChatSurface((state) => state.hunkDecisions);
  const expanded = useChatSurface((state) => state.expanded);
  const decideHunk = useChatSurface((state) => state.decideHunk);
  const decideFile = useChatSurface((state) => state.decideFile);
  const setExpanded = useChatSurface((state) => state.setExpanded);
  const toggleExpanded = useChatSurface((state) => state.toggleExpanded);
  const clearPlanDecisions = useChatSurface((state) => state.clearPlanDecisions);

  // Empty rather than optional at every call site: an absent digest map means "no digests measured
  // here", which `isStale` already treats as not-stale.
  const digests = useMemo(() => onDisk ?? new Map<string, string>(), [onDisk]);

  const diffByPath = useMemo(() => {
    const map = new Map<string, DiffPart>();
    for (const diff of diffs) {
      if (diff.planId === plan.planId) map.set(diff.path, diff);
    }
    return map;
  }, [diffs, plan.planId]);

  const tally = useMemo(
    () => reviewTally(plan, [...diffByPath.values()], hunkDecisions, digests),
    [plan, diffByPath, hunkDecisions, digests],
  );
  const selection = useMemo(
    () => applicableHunks(plan, [...diffByPath.values()], hunkDecisions, digests),
    [plan, diffByPath, hunkDecisions, digests],
  );

  const enabled = applyEnabled(selection);
  const disabledReason = applyDisabledReason(selection);

  // Local, not in the store: the confirmation is a transient state of this card in this render, and a
  // Session switch mid-confirmation should forget it rather than restore it.
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  if (receipt != null) {
    return (
      <ReceiptCard
        receipt={receipt}
        {...(onRollback === undefined ? {} : { onRollback })}
        className={className}
      />
    );
  }

  return (
    <section
      className={cn("flex flex-col rounded-[var(--zoc-radius-card)] border p-3", className)}
      data-zoc-plan-card={plan.planId}
      aria-label={`Plan: ${plan.title}`}
      style={{
        backgroundColor: "var(--zoc-elev-1)",
        borderColor: "var(--zoc-border)",
        boxShadow: "var(--zoc-shadow-1)",
        gap: "var(--zoc-row-gap)",
      }}
    >
      <header className="flex flex-wrap items-baseline gap-2">
        <span
          data-zoc-plan-title=""
          style={{ color: "var(--zoc-text)", fontSize: "var(--zoc-text-body)" }}
        >
          {plan.title}
        </span>
        <span
          data-zoc-plan-file-count={String(plan.files.length)}
          style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-label)" }}
        >
          {plan.files.length === 1 ? "1 file" : `${String(plan.files.length)} files`}
        </span>
      </header>

      <ul role="list" className="flex list-none flex-col" data-zoc-plan-files="">
        {plan.files.map((file) => {
          const diff = diffByPath.get(file.path);
          const stale = diff !== undefined && isStale(diff, digests);
          const open = expanded.has(fileRowKey(plan.planId, file.path));
          const fileDecisions: Readonly<Record<string, HunkDecision>> =
            hunkDecisions[plan.planId]?.[file.path] ?? {};

          return (
            <li key={file.path} className="flex flex-col" data-zoc-plan-file={file.path}>
              <button
                type="button"
                data-zoc-plan-file-trigger={file.path}
                aria-expanded={open}
                // The action reaches a screen reader as a word here, which is why `ActionBadge` is
                // `aria-hidden`: the letter and the shape are for the eye.
                aria-label={`${ACTION_WORD[file.action]} ${file.path}, +${String(file.addedLines)} −${String(file.removedLines)}, ${pluralHunks(file.hunkCount)}`}
                onClick={() => {
                  toggleExpanded(fileRowKey(plan.planId, file.path));
                }}
                className="flex items-center gap-2 rounded-[var(--zoc-radius-chip)] px-1 py-0.5 text-left hover:bg-[var(--zoc-row-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]"
              >
                <ChevronRight
                  aria-hidden
                  className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
                  style={{ color: "var(--zoc-text-faint)" }}
                />
                <ActionBadge action={file.action} />
                <span
                  className="min-w-0 flex-1 truncate font-mono"
                  style={{ color: "var(--zoc-text-secondary)", fontSize: "var(--zoc-text-meta)" }}
                >
                  {file.action === "rename" && file.sourcePath != null
                    ? `${file.sourcePath} → ${file.path}`
                    : file.path}
                </span>
                <span
                  className="shrink-0 font-mono tabular-nums"
                  data-zoc-plan-file-counts=""
                  style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-label)" }}
                >
                  +{file.addedLines} −{file.removedLines}
                </span>
                <span
                  className="w-16 shrink-0 text-right"
                  style={{ color: "var(--zoc-text-faint)", fontSize: "var(--zoc-text-label)" }}
                >
                  {pluralHunks(file.hunkCount)}
                </span>
                {stale ? (
                  <span
                    data-zoc-plan-file-stale=""
                    style={{ color: "var(--zoc-ember)", fontSize: "var(--zoc-text-label)" }}
                  >
                    stale
                  </span>
                ) : null}
              </button>

              {open && diff !== undefined ? (
                <DiffReview
                  className="pl-6 pt-1"
                  diff={diff}
                  stale={stale}
                  readOnly={readOnly}
                  decisions={fileDecisions}
                  isExpanded={(hunkId) => expanded.has(hunkRowKey(plan.planId, file.path, hunkId))}
                  onDecideHunk={(hunkId, decision) => {
                    decideHunk(plan.planId, file.path, hunkId, decision);
                  }}
                  onDecideFile={(decision) => {
                    decideFile(plan.planId, file.path, decision);
                  }}
                  onExpandedChange={(hunkId, open_) => {
                    setExpanded(hunkRowKey(plan.planId, file.path, hunkId), open_);
                  }}
                  {...(stale && onRegenerate !== undefined
                    ? {
                        onRegenerate: () => {
                          onRegenerate(file.path);
                        },
                      }
                    : {})}
                />
              ) : null}
            </li>
          );
        })}
      </ul>

      {plan.verificationCommand == null || plan.verificationCommand.length === 0 ? null : (
        <p
          className="font-mono"
          data-zoc-plan-verify=""
          style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-meta)" }}
        >
          verify: {plan.verificationCommand}
        </p>
      )}

      <footer
        className="flex flex-wrap items-center gap-2 border-t pt-2"
        style={{ borderColor: "var(--zoc-border)" }}
      >
        <span
          data-zoc-plan-tally=""
          style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-label)" }}
        >
          {tally.accepted} of {tally.total} hunks accepted
        </span>
        {tally.staleFiles > 0 ? (
          <span
            data-zoc-plan-stale-count={String(tally.staleFiles)}
            style={{ color: "var(--zoc-ember)", fontSize: "var(--zoc-text-label)" }}
          >
            {tally.staleFiles === 1 ? "1 stale file" : `${String(tally.staleFiles)} stale files`}
          </span>
        ) : null}
        <span className="flex-1" />
        {readOnly ? null : confirmingDiscard ? (
          <>
            <span style={{ color: "var(--zoc-text)", fontSize: "var(--zoc-text-label)" }}>
              Discard the plan? Nothing has been written.
            </span>
            <button
              type="button"
              data-zoc-plan-discard-confirm=""
              onClick={() => {
                setConfirmingDiscard(false);
                clearPlanDecisions(plan.planId);
                onDiscard?.();
              }}
              className="rounded-[var(--zoc-radius-chip)] px-2 py-0.5 hover:bg-[var(--zoc-row-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]"
              style={{ color: "var(--zoc-error)", fontSize: "var(--zoc-text-label)" }}
            >
              Discard
            </button>
            <button
              type="button"
              data-zoc-plan-discard-cancel=""
              onClick={() => {
                setConfirmingDiscard(false);
              }}
              className="rounded-[var(--zoc-radius-chip)] px-2 py-0.5 hover:bg-[var(--zoc-row-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]"
              style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-label)" }}
            >
              Keep reviewing
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              data-zoc-plan-discard=""
              onClick={() => {
                setConfirmingDiscard(true);
              }}
              className="rounded-[var(--zoc-radius-chip)] px-2 py-0.5 hover:bg-[var(--zoc-row-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]"
              style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-label)" }}
            >
              Discard
            </button>
            <button
              type="button"
              data-zoc-plan-apply=""
              disabled={!enabled}
              // The reason is on the control rather than in a tooltip, so it is available to a
              // screen reader and to a user who never hovers.
              {...(disabledReason === null ? {} : { title: disabledReason })}
              aria-describedby={disabledReason === null ? undefined : `${plan.planId}-apply-reason`}
              onClick={() => {
                onApply?.(selection);
              }}
              className={cn(
                "rounded-[var(--zoc-radius-chip)] px-2 py-0.5 focus-visible:outline-none",
                "focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]",
                enabled ? "hover:bg-[var(--zoc-elev-2)]" : "cursor-not-allowed",
              )}
              style={{
                color: enabled ? "var(--zoc-text)" : "var(--zoc-text-faint)",
                fontSize: "var(--zoc-text-label)",
              }}
            >
              Apply ({selection.hunkIds.length + selection.acceptedFiles.length})
            </button>
          </>
        )}
        {disabledReason === null || confirmingDiscard ? null : (
          <p
            id={`${plan.planId}-apply-reason`}
            data-zoc-plan-apply-reason=""
            className="w-full"
            style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-label)" }}
          >
            {disabledReason}
          </p>
        )}
      </footer>
    </section>
  );
}

interface ReceiptCardProps {
  receipt: ApplyReceipt;
  onRollback?: (checkpointId: string) => void;
  className?: string;
}

/**
 * The post-apply card: what landed, under which checkpoint, and what rollback would do.
 *
 * A partial failure reaches the same component (R16.7): the file list is exactly what was written, and
 * the failure's sentence sits beside it rather than replacing it. Rolling back is offered only when the
 * receipt carries a checkpoint id — inferring that a checkpoint "must" exist would offer a control that
 * fails when pressed.
 */
function ReceiptCard({ receipt, onRollback, className }: ReceiptCardProps) {
  return (
    <section
      className={cn("flex flex-col rounded-[var(--zoc-radius-card)] border p-3", className)}
      data-zoc-plan-receipt=""
      {...(receipt.partial ? { "data-zoc-receipt-partial": "" } : {})}
      style={{
        backgroundColor: "var(--zoc-elev-1)",
        borderColor: receipt.partial ? "var(--zoc-error)" : "var(--zoc-border)",
        boxShadow: "var(--zoc-shadow-1)",
        gap: "var(--zoc-row-gap-tight)",
      }}
    >
      <span
        data-zoc-receipt-summary=""
        style={{ color: "var(--zoc-text)", fontSize: "var(--zoc-text-body)" }}
      >
        {receipt.summary}
      </span>

      {receipt.failure === null ? null : (
        <span
          data-zoc-receipt-failure=""
          style={{ color: "var(--zoc-error)", fontSize: "var(--zoc-text-meta)" }}
        >
          {receipt.failure}
        </span>
      )}

      <ul role="list" className="flex list-none flex-col" data-zoc-receipt-files="">
        {receipt.files.map((file) => (
          <li
            key={file.path}
            className="font-mono"
            data-zoc-receipt-file={file.path}
            {...(file.action === undefined ? {} : { "data-action": file.action })}
            style={{ color: "var(--zoc-text-secondary)", fontSize: "var(--zoc-text-meta)" }}
          >
            {file.path}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        {receipt.checkpointId === null ? (
          <span
            data-zoc-receipt-no-checkpoint=""
            style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-label)" }}
          >
            No checkpoint was created, so this cannot be rolled back here.
          </span>
        ) : (
          <span
            className="font-mono"
            data-zoc-receipt-checkpoint={receipt.checkpointId}
            style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-label)" }}
          >
            checkpoint {receipt.checkpointId}
          </span>
        )}
        {receipt.rollbackable && receipt.checkpointId !== null && onRollback !== undefined ? (
          <button
            type="button"
            data-zoc-receipt-rollback=""
            // The per-file phrasing is the accessible name: "roll back 4 files" is ambiguous in the
            // one case R10.15 exists for, since rolling back a create removes a file.
            aria-label={`Roll back: ${receipt.rollbackActions.join(", ")}`}
            onClick={() => {
              onRollback(receipt.checkpointId as string);
            }}
            className="rounded-[var(--zoc-radius-chip)] px-2 py-0.5 hover:bg-[var(--zoc-row-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]"
            style={{ color: "var(--zoc-text)", fontSize: "var(--zoc-text-label)" }}
          >
            Roll back
          </button>
        ) : null}
      </div>
    </section>
  );
}
