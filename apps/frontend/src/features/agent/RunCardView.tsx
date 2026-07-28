/**
 * RunCardView.tsx — a run's card, built entirely on `FeedRow[]` (R18.7).
 *
 * Rows come from the single `normalizeEvents` seam and render through the closed
 * `renderRow`. When collapsed the card still exposes the run's outcome, duration,
 * files-changed count, and any zero-change reason (R8.2/R8.7/R8.8) as a compact
 * summary line — it just doesn't repeat the row content (Property 37). A stalled,
 * reconnecting, or interrupted run shows that state plus its last stage and
 * Cancel/Retry controls (R8.3/R8.4).
 */
import { ChevronDown, ChevronRight, RotateCcw, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { transitionClass, useReducedMotion } from "@/lib/reduced-motion";
import type { FeedRow } from "./normalize";
import { renderRow, StreamingIndicator, RowActionsProvider } from "./rows";
import { followUpsRow, runSummaryRow, type RunCard } from "./run-cards";
import {
  canRetryRun,
  canStopRun,
  isTerminal,
  isTroubled,
  runDuration,
  runStatusLabel,
  type TrackedRun,
} from "./agent-runs";

/** Count the auditable steps in a run's rows (tool calls, diffs, commands, stages). */
export function summarizeSteps(rows: readonly FeedRow[]): number {
  return rows.filter(
    (r) =>
      r.kind === "tool-call" ||
      r.kind === "tool-group" ||
      r.kind === "diff" ||
      r.kind === "command" ||
      r.kind === "stage",
  ).length;
}

export interface RunCardViewProps {
  card: RunCard;
  focused: boolean;
  collapsed: boolean;
  readOnly?: boolean;
  onFocus?: (runId: string) => void;
  onStop?: (runId: string) => void;
  /** Re-run this run's work (R8.3/R8.4) — routed through the Composer path. */
  onRetry?: (runId: string) => void;
  /** Activate a follow-up chip through the Composer's submit path (R21.3). */
  onSubmitPrompt?: (prompt: string) => void;
  /** Probe a file's existence + SHA-256 for diff staleness (R12.7). */
  probeFile?: (path: string) => Promise<import("./diff-staleness").FileProbe | null>;
  /** Regenerate a stale diff through a real current-mode run (R12.8). */
  onRegenerateDiff?: (runId: string, path: string) => void;
}

function statusLabel(run: TrackedRun | undefined): string {
  return run ? runStatusLabel(run) : "Running…";
}

/** Compact one-line outcome for a collapsed, terminal run (R8.2/R8.7/R8.8). */
function collapsedSummary(run: TrackedRun): string {
  const files = run.filesChanged ?? 0;
  const parts = [runStatusLabel(run), runDuration(run, Date.now())];
  if (run.mode === "agent") {
    parts.push(`${files} file${files === 1 ? "" : "s"} changed`);
  } else if (run.mode === "plan") {
    parts.push("No changes applied");
  }
  if ((run.mode !== "agent" || files === 0) && run.outcomeReason) {
    parts.push(run.outcomeReason);
  }
  return parts.join(" · ");
}

function modeLabel(mode: TrackedRun["mode"] | undefined): string {
  switch (mode) {
    case "ask":
      return "Ask";
    case "plan":
      return "Plan";
    default:
      return "Agent";
  }
}

export function RunCardView({
  card,
  focused,
  collapsed,
  readOnly = false,
  onFocus,
  onStop,
  onRetry,
  onSubmitPrompt,
  probeFile,
  onRegenerateDiff,
}: RunCardViewProps): JSX.Element {
  const { run, rows } = card;
  const reduced = useReducedMotion();
  const steps = summarizeSteps(rows);
  const showStop = !readOnly && run != null && canStopRun(run);
  const showRetry = !readOnly && run != null && canRetryRun(run) && onRetry != null;
  const troubled = run != null && isTroubled(run);

  return (
    <div
      className={cn(
        "rounded-xl border border-[#26262B] bg-[#0B0B0F]",
        transitionClass("row-enter", reduced),
        focused && "border-[var(--zoc-accent,#a78bfa)]/40",
        troubled && "border-[var(--zoc-ember)]/40",
      )}
      data-testid="run-card"
      data-run-id={card.runId}
      data-focused={focused}
      data-collapsed={collapsed}
      data-phase={run?.phase ?? "running"}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          className="zoc-focus-ring flex min-w-0 items-center gap-1.5 text-left"
          aria-expanded={!collapsed}
          onClick={() => onFocus?.(card.runId)}
        >
          {collapsed ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
          <span className="text-[12px] font-semibold text-[#EDEDF0]">
            {modeLabel(run?.mode)}
          </span>
          <span className={cn("truncate text-[11px]", troubled ? "text-[var(--zoc-ember)]" : "text-[#71717A]")}>
            · {statusLabel(run)}
            {/* A stalled/reconnecting run shows its last stage too (R8.3). */}
            {troubled && run?.stage ? ` · ${run.stage}` : ""}
          </span>
        </button>
        <span className="ml-auto shrink-0 text-[11px] text-[#71717A]">
          {steps} step{steps === 1 ? "" : "s"}
        </span>
        {showStop && (
          <button
            type="button"
            className="zoc-focus-ring shrink-0 rounded border border-[#26262B] px-2 py-0.5 text-[11px] text-[#D4D4D8]"
            onClick={() => onStop?.(card.runId)}
          >
            <Square className="mr-1 inline h-3 w-3" />
            Stop
          </button>
        )}
        {showRetry && (
          <button
            type="button"
            className="zoc-focus-ring shrink-0 rounded border border-[#26262B] px-2 py-0.5 text-[11px] text-[#D4D4D8]"
            onClick={() => onRetry?.(card.runId)}
          >
            <RotateCcw className="mr-1 inline h-3 w-3" />
            Retry
          </button>
        )}
      </div>

      {/* Collapsed terminal card: still exposes outcome/duration/files/zero-reason
          (R8.2/R8.7/R8.8) as a compact line — without repeating row content. */}
      {collapsed && run && isTerminal(run) && (
        <div
          className="border-t border-[#1E1E23] px-3 py-1.5 text-[11px] text-[#8A8A93]"
          data-testid="run-card-collapsed-summary"
        >
          {collapsedSummary(run)}
        </div>
      )}

      {!collapsed && (
        <RowActionsProvider
          actions={{
            readOnly,
            submitPrompt: onSubmitPrompt,
            probeFile,
            regenerateDiff: onRegenerateDiff,
            retry: onRetry ? () => onRetry(card.runId) : undefined,
          }}
        >
          <div className="flex flex-col gap-2 border-t border-[#1E1E23] px-3 py-2">
            {rows.map((row) => (
              <div key={row.id} className={transitionClass("row-enter", reduced)}>
                {renderRow(row)}
              </div>
            ))}
            {/* The terminal run-summary is derived from the run record — the
                `done` frame is consumed by the lifecycle, not the normalizer
                (R8.7, R8.8). Rendered only when expanded, so a collapsed card
                never duplicates it (Property 37). Follow-up chips (R21) are
                scoped to this run's id and offer the next prompt. */}
            {run && isTerminal(run) && renderRow(runSummaryRow(run))}
            {run && isTerminal(run) && renderRow(followUpsRow(run))}
            <StreamingIndicator rows={rows} />
          </div>
        </RowActionsProvider>
      )}
    </div>
  );
}

export default RunCardView;

/** Whether a card should render collapsed by default. */
export function isCardCollapsed(run: TrackedRun | undefined, focused: boolean): boolean {
  return Boolean(run && isTerminal(run) && !focused);
}
