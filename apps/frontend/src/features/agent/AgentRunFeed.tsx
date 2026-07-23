/**
 * AgentRunFeed.tsx — the Run_Feed body of the preserved Agent_Panel.
 *
 * Adapted from `apps/workbench/src/AgentFeed.tsx` (branch
 * `zocai-ecosystem-rebuild`) into the preserved `apps/frontend` shell. It is
 * the NEW run-feed body that replaces `AgentTimeline.tsx` inside row 3 of
 * `AgentPanel.tsx` (the wiring itself lands in task 4.2). It renders the typed
 * Event_Rows registered by `ROW_COMPONENTS` and intentionally drops validated
 * telemetry kinds with no row component; it must not enclose or alter the
 * Panel_Shell (R3.7).
 *
 * Requirements (merge spec):
 * - R3.2 / R3.3: WHEN the Run_Feed receives an Event_Contract payload it
 *   selects exactly one row component from the `ROW_COMPONENTS` registry by the
 *   payload's event-type discriminator; one distinct component per kind.
 * - R3.4: received Event_Rows are appended in the Gateway's emission order
 *   (the seq-ordered, append-only feed from `useAgentStream`) WITHOUT altering
 *   previously rendered rows.
 * - R3.5: a payload with an unrecognized event type is discarded via
 *   `isRecognizedEvent` WITHOUT altering the rendered feed.
 * - R3.7: rows render INLINE inside the existing run region only — there is no
 *   Panel_Shell wrapper here, so the preserved chrome is untouched.
 *
 * The component also keeps the carried-over 100 ms render budget
 * (Rebuild-R7.2): if a row cannot render within the budget under load it is
 * either skipped or rendered late with a visual warning indicator. The render
 * budget logic is transport-free, so the file splits into a pure presentational
 * view (`AgentRunFeedView`) and a live container (`AgentRunFeed`) that wires the
 * `useAgentStream` subscription.
 *
 * The recognized-type guard (`isRecognizedEvent`) and the one-component-per-type
 * registry (`ROW_COMPONENTS`) are imported from the sibling `rows.tsx` so the
 * dispatch + discard rules have a single source of truth (R6.3, design.md).
 *
 * See design.md "New: run-feed body `AgentRunFeed.tsx` and `rows.tsx`".
 */
import { useEffect, useRef, useState } from "react";

import useAgentStream from "./useAgentStream";
import type { AgentEvent, UseAgentStreamOptions } from "./useAgentStream";
import { ROW_COMPONENTS, isRecognizedEvent } from "./rows";

/** The render budget for a single row (Rebuild-R7.2). */
export const RENDER_BUDGET_MS = 100;

/**
 * Under-load fallback strategy when a row cannot render within the budget:
 * - `"late-warning"` (default): render the row but flag it with a visual
 *   delayed-render warning indicator (non-destructive — prior rows untouched).
 * - `"skip"`: omit the over-budget row from the feed.
 * Both are sanctioned by Rebuild-R7.2.
 */
export type OverBudgetStrategy = "late-warning" | "skip";

export interface AgentRunFeedViewProps {
  /** The append-only, seq-ordered feed (from `useAgentStream`). */
  events: readonly AgentEvent[];
  /** Per-row render budget in ms. Defaults to {@link RENDER_BUDGET_MS}. */
  renderBudgetMs?: number;
  /** Fallback when a row misses the budget. Defaults to `"late-warning"`. */
  overBudgetStrategy?: OverBudgetStrategy;
  /** Monotonic clock, injectable for tests. Defaults to `performance.now`. */
  now?: () => number;
}

/** Reads a monotonic timestamp, falling back to `Date.now` where needed. */
function defaultNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Pure presentational feed. Selects each recognized event's single row
 * component from `ROW_COMPONENTS` (R3.2, R3.3), appends in emission order
 * without mutating prior rows (R3.4), discards unrecognized types via
 * `isRecognizedEvent` (R3.5), and enforces the 100 ms render budget with a
 * skip-or-late-with-warning fallback (Rebuild-R7.2).
 *
 * It renders only the inline feed rows — no surrounding Panel_Shell chrome — so
 * dropping it into the existing run region leaves the shell untouched (R3.7).
 */
export function AgentRunFeedView({
  events,
  renderBudgetMs = RENDER_BUDGET_MS,
  overBudgetStrategy = "late-warning",
  now = defaultNow,
}: AgentRunFeedViewProps): JSX.Element {
  // First time each event (by seq) is observed during render — the start of
  // its render-budget clock. Recorded in a ref so it survives re-renders and
  // never resets, keeping the budget measured from true arrival.
  const firstSeenRef = useRef<Map<number, number>>(new Map());
  // Seqs already measured against the budget, so each is judged exactly once.
  const measuredRef = useRef<Set<number>>(new Set());
  const [delayedSeqs, setDelayedSeqs] = useState<Set<number>>(() => new Set());
  const [skippedSeqs, setSkippedSeqs] = useState<Set<number>>(() => new Set());

  // Stamp arrival for any newly seen event before it commits to the DOM.
  for (const event of events) {
    if (!firstSeenRef.current.has(event.seq)) {
      firstSeenRef.current.set(event.seq, now());
    }
  }

  // After commit, measure render latency for not-yet-judged events and apply
  // the over-budget fallback (Rebuild-R7.2).
  useEffect(() => {
    const overBudget: number[] = [];
    for (const event of events) {
      if (measuredRef.current.has(event.seq)) {
        continue;
      }
      const seenAt = firstSeenRef.current.get(event.seq);
      measuredRef.current.add(event.seq);
      if (seenAt !== undefined && now() - seenAt > renderBudgetMs) {
        overBudget.push(event.seq);
      }
    }
    if (overBudget.length === 0) {
      return;
    }
    if (overBudgetStrategy === "skip") {
      setSkippedSeqs((prev) => {
        const next = new Set(prev);
        for (const seq of overBudget) {
          next.add(seq);
        }
        return next;
      });
    } else {
      setDelayedSeqs((prev) => {
        const next = new Set(prev);
        for (const seq of overBudget) {
          next.add(seq);
        }
        return next;
      });
    }
  }, [events, renderBudgetMs, overBudgetStrategy, now]);

  return (
    <div
      className="agent-run-feed flex h-full min-h-0 flex-col gap-1.5 overflow-y-auto px-3 py-2"
      role="log"
      aria-live="polite"
      aria-label="Agent run feed"
    >
      {events.map((event) => {
        // R3.5: unrecognized event types are discarded without altering the feed.
        if (!isRecognizedEvent(event)) {
          return null;
        }
        // Rebuild-R7.2 (skip strategy): omit a row that missed the render budget.
        if (skippedSeqs.has(event.seq)) {
          return null;
        }
        // R3.2 / R3.3: exactly one row component per event type.
        const Row = ROW_COMPONENTS[event.type];
        const delayed = delayedSeqs.has(event.seq);
        return (
          <div
            key={event.seq}
            className={delayed ? "feed-item feed-item--delayed" : "feed-item"}
          >
            {delayed && (
              <span
                className="feed-delayed-warning text-[10px] font-medium text-[var(--zoc-ember)]"
                role="status"
                title="Rendered after the 100 ms budget"
              >
                ⚠ delayed render
              </span>
            )}
            <Row event={event} />
          </div>
        );
      })}
    </div>
  );
}

export interface AgentRunFeedProps {
  /** Options forwarded to {@link useAgentStream} (transport injection, etc.). */
  streamOptions?: UseAgentStreamOptions;
  /** Per-row render budget in ms. Defaults to {@link RENDER_BUDGET_MS}. */
  renderBudgetMs?: number;
  /** Fallback when a row misses the budget. Defaults to `"late-warning"`. */
  overBudgetStrategy?: OverBudgetStrategy;
}

/**
 * Live container: subscribes to the Gateway SSE bus via `useAgentStream` (R3.1)
 * and renders the ordered, append-only feed through {@link AgentRunFeedView}.
 * Mounted inside the existing Agent_Panel run region by task 4.2; it renders
 * only feed rows and never the Panel_Shell (R3.7).
 */
export default function AgentRunFeed({
  streamOptions,
  renderBudgetMs,
  overBudgetStrategy,
}: AgentRunFeedProps = {}): JSX.Element {
  const { events } = useAgentStream(streamOptions ?? {});
  return (
    <AgentRunFeedView
      events={events}
      renderBudgetMs={renderBudgetMs}
      overBudgetStrategy={overBudgetStrategy}
    />
  );
}
