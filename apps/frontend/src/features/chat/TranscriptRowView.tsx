/**
 * The transcript row renderer — zoc-agent-chat-rebuild task 17.1.
 *
 * One `TranscriptRow` drawn. Paired with `transcript-model.ts` and split from it for the reason
 * `reasoning-duration.ts` gives: a module exporting both a component and a function is a
 * fast-refresh boundary, and the model is what the properties import — a test asserting which rows
 * a message produces should not pull Radix and Monaco in behind it.
 *
 * **The `switch` here is exhaustive over the union, and one arm renders `null`.** `sources` is
 * classified by the factory and drawn by 36.4. It is listed rather than folded into a default so that
 * adding a row kind is a compile error here rather than a part that silently disappears, and
 * {@link ROWS_AWAITING_A_RENDERER} names it so the gap is a checked fact rather than a comment.
 *
 * **A row never logs and never mutates.** The unknown-discriminant log fires once, in the factory,
 * at the point the decision was made — a component doing it would log per mount, and the
 * virtualiser mounts and unmounts rows as they scroll.
 *
 * **The two review arms read a context, and they are the only arms that do.** A plan card needs the
 * on-disk digests, the receipt, and four handlers, none of which belong in the row model. Reading them
 * through `useReviewSurface` inside a slot component — rather than through this component's own props —
 * keeps a change to any of them from re-rendering every other mounted row, which is what R8.1 and
 * Property 6 are about. A hook cannot be called inside a `switch` arm, so each slot is its own
 * component.
 */
import { AnswerRow } from "./AnswerRow";
import { CompactionRow } from "./CompactionRow";
import { ErrorRow } from "./ErrorRow";
import { HistoricalRow } from "./HistoricalRow";
import { ReasoningRow } from "./ReasoningRow";
import { PermissionWaitingRow } from "./permission/PermissionWaitingRow";
import { DiffReview } from "./review/DiffReview";
import { PlanRow } from "./review/PlanRow";
import { useReviewSurface } from "./review/review-surface";
import { ToolTimeline } from "./timeline/ToolTimeline";
import { UnknownPartRow } from "./UnknownPartRow";
import { UsageRow } from "./UsageRow";
import { UserTurnRow } from "./UserTurnRow";
import { isStale } from "./review/hunk-selection";
import { useChatSurface } from "./store";
import type { TranscriptRow } from "./transcript-model";

export interface TranscriptRowViewProps {
  row: TranscriptRow;
  /** Retry a failed tool call (R9.6). Absent means no control is offered. */
  onToolRetry?: (toolCallId: string) => void;
  /** Retry the Run behind a failed error row (R16.6). */
  onErrorRetry?: () => void;
  /** Carry on from an interrupted Run's partial transcript (R16.5). */
  onErrorContinue?: () => void;
  /** Resolves a folded message id into a turn label for `CompactionRow` (R34.3). */
  resolveFoldedTurn?: (messageId: string) => string | undefined;
}

export function TranscriptRowView({
  row,
  onToolRetry,
  onErrorRetry,
  onErrorContinue,
  resolveFoldedTurn,
}: TranscriptRowViewProps) {
  switch (row.kind) {
    case "user":
      return <UserTurnRow text={row.text} />;

    case "answer":
      return <AnswerRow text={row.text} streaming={row.streaming} />;

    case "reasoning":
      return (
        <ReasoningRow
          text={row.text}
          streaming={row.streaming}
          terminal={row.terminal}
          elapsedMs={row.elapsedMs}
          redacted={row.redacted}
        />
      );

    case "tools":
      return (
        <ToolTimeline
          entries={row.entries}
          {...(onToolRetry === undefined ? {} : { onRetry: onToolRetry })}
        />
      );

    case "usage":
      return (
        <UsageRow usage={row.usage} {...(row.model === undefined ? {} : { model: row.model })} />
      );

    case "error":
      return (
        <ErrorRow
          error={row.error}
          {...(onErrorRetry === undefined ? {} : { onRetry: onErrorRetry })}
          {...(onErrorContinue !== undefined && isInterrupted(row.error)
            ? { onContinue: onErrorContinue }
            : {})}
        />
      );

    case "compaction":
      return (
        <CompactionRow
          compaction={row.compaction}
          {...(resolveFoldedTurn === undefined ? {} : { resolveFoldedTurn })}
        />
      );

    case "historical":
      return <HistoricalRow item={row.item} />;

    case "unknown":
      return <UnknownPartRow discriminant={row.discriminant} />;

    case "plan":
      return <PlanRowSlot row={row} />;

    case "diff":
      return <DiffRowSlot row={row} />;

    case "permission":
      // The decision itself is made in the dock, outside this scroll container (R11.8). What belongs
      // here is the record: what was asked, and what was decided.
      return <PermissionWaitingRow request={row.request} />;

    // ── Classified, not yet drawn ──────────────────────────────────────
    case "sources":
      return null;
  }
}

/**
 * Whether an error row is an interrupted Run rather than a failure (R16.5).
 *
 * The row carries `ErrorPart | RunLifecyclePart` because 17.1 folds a terminal lifecycle with no
 * accompanying error part into the same row. Only the lifecycle arm can be interrupted, and the
 * "continue" affordance is meaningless for the other arm — an `ErrorPart` describes a Run that failed,
 * and there is no partial result to carry forward.
 */
function isInterrupted(error: Extract<TranscriptRow, { kind: "error" }>["error"]): boolean {
  return error.type === "run-lifecycle" && error.state === "interrupted";
}

/**
 * A plan card wired to the review surface.
 *
 * Its own component so the context read happens for plan rows and nothing else. Everything about the
 * card's state — decisions, expansion — comes from the chat-local store inside `PlanRow`; what arrives
 * here is what only the panel knows: digests, the receipt, and the four handlers.
 */
function PlanRowSlot({ row }: { row: Extract<TranscriptRow, { kind: "plan" }> }) {
  const surface = useReviewSurface();
  const receipt = surface.receiptOf?.(row.plan.planId) ?? null;

  return (
    <PlanRow
      plan={row.plan}
      diffs={row.diffs}
      receipt={receipt}
      {...(surface.onDisk === undefined ? {} : { onDisk: surface.onDisk })}
      {...(surface.onApply === undefined ? {} : { onApply: surface.onApply })}
      {...(surface.onDiscard === undefined
        ? {}
        : {
            onDiscard: () => {
              surface.onDiscard?.(row.plan.planId);
            },
          })}
      {...(surface.onRegenerate === undefined
        ? {}
        : {
            onRegenerate: (path: string) => {
              surface.onRegenerate?.(row.plan.planId, path);
            },
          })}
      {...(surface.onRollback === undefined ? {} : { onRollback: surface.onRollback })}
    />
  );
}

/**
 * A diff with no plan in its message.
 *
 * Reachable only from a transcript whose plan part is missing — a persisted Session written by an older
 * runtime, or a stream that lost it. It renders the review without a footer, because apply is a
 * plan-level action (R10.1) and a diff on its own has no plan to apply. Decisions still write to the
 * store under the diff's own `planId`, so a plan arriving later finds the review already done.
 */
function DiffRowSlot({ row }: { row: Extract<TranscriptRow, { kind: "diff" }> }) {
  const surface = useReviewSurface();
  const decisions = useChatSurface(
    (state) => state.hunkDecisions[row.diff.planId]?.[row.diff.path],
  );
  const expanded = useChatSurface((state) => state.expanded);
  const decideHunk = useChatSurface((state) => state.decideHunk);
  const decideFile = useChatSurface((state) => state.decideFile);
  const setExpanded = useChatSurface((state) => state.setExpanded);

  const stale = isStale(row.diff, surface.onDisk ?? new Map<string, string>());
  const key = (hunkId: string) => `${row.diff.planId}|${row.diff.path}|${hunkId}`;

  return (
    <DiffReview
      diff={row.diff}
      stale={stale}
      decisions={decisions ?? {}}
      isExpanded={(hunkId) => expanded.has(key(hunkId))}
      onDecideHunk={(hunkId, decision) => {
        decideHunk(row.diff.planId, row.diff.path, hunkId, decision);
      }}
      onDecideFile={(decision) => {
        decideFile(row.diff.planId, row.diff.path, decision);
      }}
      onExpandedChange={(hunkId, open) => {
        setExpanded(key(hunkId), open);
      }}
      {...(stale && surface.onRegenerate !== undefined
        ? {
            onRegenerate: () => {
              surface.onRegenerate?.(row.diff.planId, row.diff.path);
            },
          }
        : {})}
    />
  );
}
