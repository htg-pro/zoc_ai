/**
 * run-cards.ts — group normalized feed rows into per-run cards for the region.
 *
 * The region shows one card per run. A card's rows come from the single
 * `normalizeEvents → FeedRow[]` seam grouped by `runId`; a locally tracked run
 * with no rows yet still gets an (empty) card so "Starting…" is visible. This
 * replaces the two hand-built `RunTrace` shells that could disagree about a
 * run's status.
 *
 * Rules:
 *  1. Every locally tracked run gets a card, with its rows from the feed.
 *  2. Every run present in the feed but not tracked locally also gets a card
 *     (a shared-session viewer, or a run started from another window).
 *  3. The focused run is hoisted to the top.
 */
import type { FeedRow } from "./normalize";
import { orderRuns, type TrackedRun } from "./agent-runs";
import type { RunPhase as LifecycleRunPhase } from "./run-lifecycle";
import { deriveFollowUps } from "./follow-ups";

export interface RunCard {
  runId: string;
  /** The run's rows, in feed order. Empty when no event has arrived yet. */
  rows: FeedRow[];
  /** The locally tracked run, when this card corresponds to one. */
  run?: TrackedRun;
}

/**
 * The terminal run-summary row, derived from the tracked run record rather than
 * the `done` frame (which the normalizer consumes as `lifecycle`) — so it
 * carries the run's elapsed time (R8.2), files-changed count (R8.7), and, for a
 * zero-change agent run, the Gateway's reason (R8.8).
 */
export function runSummaryRow(run: TrackedRun): Extract<FeedRow, { kind: "run-summary" }> {
  const outcome: LifecycleRunPhase =
    run.phase === "failed"
      ? "failed"
      : run.phase === "cancelled"
        ? "cancelled"
        : run.phase === "interrupted"
          ? "interrupted"
          : "done";
  return {
    kind: "run-summary",
    id: `run-summary:${run.runId}`,
    seq: Number.MAX_SAFE_INTEGER,
    runId: run.runId,
    outcome,
    mode: run.mode,
    elapsedMs: Math.max(0, (run.endedAt ?? run.startedAt) - run.startedAt),
    filesChanged: run.filesChanged ?? 0,
    reason: run.outcomeReason ?? null,
  };
}

/**
 * Follow-up chips derived from a terminal run, scoped to its `runId` so a new
 * run's rows replace them (R21.4). Empty (no chips) when nothing useful can be
 * derived — the renderer then shows nothing.
 */
export function followUpsRow(run: TrackedRun): Extract<FeedRow, { kind: "follow-ups" }> {
  const outcome: LifecycleRunPhase =
    run.phase === "failed"
      ? "failed"
      : run.phase === "cancelled"
        ? "cancelled"
        : run.phase === "interrupted"
          ? "interrupted"
          : "done";
  return {
    kind: "follow-ups",
    id: `follow-ups:${run.runId}`,
    seq: Number.MAX_SAFE_INTEGER,
    runId: run.runId,
    chips: deriveFollowUps({
      outcome,
      filesChanged: run.filesChanged ?? 0,
      failedStage: null,
      checksFailed: false,
    }),
  };
}

export function assembleRunCards(params: {
  rows: readonly FeedRow[];
  trackedRuns: readonly TrackedRun[];
  focusedRunId?: string | null;
}): RunCard[] {
  const { rows, trackedRuns, focusedRunId } = params;

  const rowsByRun = new Map<string, FeedRow[]>();
  const order: string[] = [];
  for (const row of rows) {
    const existing = rowsByRun.get(row.runId);
    if (existing) {
      existing.push(row);
    } else {
      rowsByRun.set(row.runId, [row]);
      order.push(row.runId);
    }
  }

  const ordered = orderRuns(trackedRuns);
  const cards: RunCard[] = ordered.map((run) => ({
    runId: run.runId,
    run,
    rows: rowsByRun.get(run.runId) ?? [],
  }));

  // Rule 2: a run seen in the feed but not tracked locally.
  for (const runId of order) {
    if (!trackedRuns.some((run) => run.runId === runId)) {
      cards.push({ runId, rows: rowsByRun.get(runId) ?? [] });
    }
  }

  // Rule 3: focus first.
  if (focusedRunId) {
    const index = cards.findIndex((card) => card.runId === focusedRunId);
    if (index > 0) cards.unshift(...cards.splice(index, 1));
  }

  return cards;
}
