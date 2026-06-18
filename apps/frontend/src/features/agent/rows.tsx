/**
 * rows.tsx — the eight typed Event_Row components for the Agent_Panel Run_Feed.
 *
 * Ported from `apps/workbench/src/rows.tsx` (branch `zocai-ecosystem-rebuild`)
 * into the preserved `apps/frontend` shell and restyled with the existing
 * zoc-studio design tokens (`--zoc-ember`, `--zoc-info`, `--zoc-row-bg`,
 * `--zoc-row-border`, …) so the new feed visually matches the panel chrome
 * (R1.5). One component per Event_Row kind is retained verbatim (R3.2, R3.3).
 *
 * Requirements:
 * - R3.2 / R3.3: provide one distinct row component for each of the eight
 *   Event_Row kinds and select exactly one per event-type discriminator.
 * - R3.7: rows render inline inside the existing run region without enclosing
 *   the Panel_Shell; a row never mutates a previously rendered row.
 * - R1.5: styling uses the preserved zoc-studio CSS tokens so the feed blends
 *   with the rest of the shell.
 * - R11.1 / R11.3: the shared Event_Contract is imported from the canonical
 *   `@zoc-studio/shared-types` package (the branch's `@llama-studio/...`
 *   import is rewritten here).
 *
 * The `ROW_COMPONENTS` registry pins the one-component-per-type mapping and is
 * consumed by `AgentRunFeed`'s dispatch (task 2.6). `isRecognizedEvent` gates
 * unrecognized payloads out of the feed (R3.5).
 *
 * Approval decision (task 3.4): `ApprovalRow` is wired to the single decision
 * client. Selecting approve or reject posts exactly one
 * `postAgentDecision({ runId, decision })` to `POST /v1/agent/decision`,
 * disables BOTH actions on that row, and ignores any subsequent selection
 * (R5.2, R5.3). The transport stays injectable through the optional
 * `onDecision` prop (for tests); when omitted it defaults to
 * `gateway-client.postAgentDecision`, which is the only decision client — the
 * legacy `resolveApproval`/`retryApproval` path is not used. Both actions are
 * re-enabled ONLY when the post fails with a transport error, so a genuine
 * decision is never silently lost; a successful post keeps both disabled. The
 * Gateway's budget-exceeded pause arrives as an `approval` Event_Row, so the
 * same ApprovalRow and the same `/decision` path resolve it (R5.4).
 *
 * See design.md "Approval flow wired to `/decision`".
 */
import { useRef, useState } from "react";
import type { ComponentType } from "react";
import type { AgentEvents } from "@zoc-studio/shared-types";
import { postAgentDecision } from "./gateway-client";

/** The Event_Contract discriminator union. */
type EventType = AgentEvents.EventType;

/** Props shared by every row component: the typed event it renders. */
export interface RowProps<E> {
  event: E;
}

/* ── Shared style fragments (zoc-studio tokens, R1.5) ─────────────────── */

/** Inline row container — matches the nested-row look used across the panel. */
const ROW_BASE =
  "feed-row flex flex-col gap-1 rounded-md border border-[var(--zoc-row-border)] " +
  "bg-[var(--zoc-row-bg)] px-2.5 py-1.5 text-[13px] text-[var(--zoc-text)] animate-fade-row";

/** Section label — faint uppercase, like the panel's activity labels. */
const ROW_LABEL =
  "feed-row-label text-[10px] font-semibold uppercase tracking-wide text-[var(--zoc-text-faint)]";

/** Primary body text. */
const ROW_TEXT = "feed-row-text text-[13px] leading-snug text-[var(--zoc-text-secondary)]";

/** A small inline tag/badge. */
const TAG_BASE =
  "feed-tag inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium";

/** intent → IntentRow. Carries the allocator decision (R1.6, R1.9). */
export function IntentRow({ event }: RowProps<AgentEvents.IntentEvent>): JSX.Element {
  return (
    <div className={ROW_BASE} data-event-type="intent">
      <span className={`${ROW_LABEL} text-[var(--zoc-ember)]`}>Intent</span>
      <span className={ROW_TEXT}>{event.text}</span>
      <span className="feed-row-meta flex flex-wrap items-center gap-1.5">
        <span className={`${TAG_BASE} feed-tag--tier border border-[var(--zoc-row-border)] bg-[var(--zoc-panel)] text-[var(--zoc-text-muted)]`}>
          {event.modelTier}
        </span>
        <span className={`${TAG_BASE} feed-tag--window border border-[var(--zoc-row-border)] bg-[var(--zoc-panel)] text-[var(--zoc-text-muted)]`}>
          {event.contextWindowTokens} tok
        </span>
        {event.fallbackReason !== undefined && (
          <span className={`${TAG_BASE} feed-tag--fallback border border-[var(--zoc-error)]/40 bg-[var(--zoc-error)]/10 text-[var(--zoc-error)]`}>
            fallback: {event.fallbackReason}
          </span>
        )}
      </span>
    </div>
  );
}

/** thinking → ThinkingRow. Collapsible edit reasoning (R3.6). */
export function ThinkingRow({ event }: RowProps<AgentEvents.ThinkingEvent>): JSX.Element {
  // `collapsible` is always true on the contract; render as a <details> so the
  // reasoning can be folded away without leaving the inline row flow.
  return (
    <details className={ROW_BASE} data-event-type="thinking">
      <summary className={`${ROW_LABEL} cursor-pointer text-[var(--zoc-agent)]`}>Thinking</summary>
      <span className={`${ROW_TEXT} mt-1`}>{event.text}</span>
    </details>
  );
}

/** read-files → ReadFilesRow. Lists the files (and optional spans) read. */
export function ReadFilesRow({ event }: RowProps<AgentEvents.ReadFilesEvent>): JSX.Element {
  return (
    <div className={ROW_BASE} data-event-type="read-files">
      <span className={`${ROW_LABEL} text-[var(--zoc-info)]`}>Read</span>
      <ul className="feed-file-list flex flex-col gap-0.5">
        {event.files.map((file, index) => (
          <li key={`${file.path}:${index}`} className="feed-file flex items-baseline gap-1 font-mono text-[12px]">
            <span className="feed-file-path text-[var(--zoc-text-secondary)]">{file.path}</span>
            {file.span !== undefined && (
              <span className="feed-file-span text-[var(--zoc-text-faint)]">
                :{file.span[0]}–{file.span[1]}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** edit-file → EditFileRow. Shows the path and the unified diff. */
export function EditFileRow({ event }: RowProps<AgentEvents.EditFileEvent>): JSX.Element {
  return (
    <div className={ROW_BASE} data-event-type="edit-file">
      <span className={`${ROW_LABEL} text-[var(--zoc-agent)]`}>Edit</span>
      <span className="feed-file-path font-mono text-[12px] text-[var(--zoc-text-secondary)]">{event.path}</span>
      <pre className="feed-diff overflow-x-auto rounded border border-[var(--zoc-row-border)] bg-[var(--zoc-bg)] p-2 font-mono text-[12px] leading-snug text-[var(--zoc-text-muted)]">
        {event.diff}
      </pre>
    </div>
  );
}

/** command → CommandRow. Shows the command and, when present, its outcome. */
export function CommandRow({ event }: RowProps<AgentEvents.CommandEvent>): JSX.Element {
  return (
    <div className={ROW_BASE} data-event-type="command">
      <span className={`${ROW_LABEL} text-[var(--zoc-info)]`}>Command</span>
      <code className="feed-command rounded border border-[var(--zoc-row-border)] bg-[var(--zoc-bg)] px-2 py-1 font-mono text-[12px] text-[var(--zoc-text-secondary)]">
        {event.command}
      </code>
      <span className="flex flex-wrap items-center gap-1.5">
        {event.exitCode !== undefined && (
          <span
            className={
              event.exitCode === 0
                ? `${TAG_BASE} feed-tag--ok border border-[var(--zoc-success)]/40 bg-[var(--zoc-success)]/10 text-[var(--zoc-success)]`
                : `${TAG_BASE} feed-tag--fail border border-[var(--zoc-error)]/40 bg-[var(--zoc-error)]/10 text-[var(--zoc-error)]`
            }
          >
            exit {event.exitCode}
          </span>
        )}
        {event.errorTag !== undefined && (
          <span className={`${TAG_BASE} feed-tag--error border border-[var(--zoc-error)]/40 bg-[var(--zoc-error)]/10 text-[var(--zoc-error)]`}>
            {event.errorTag}
          </span>
        )}
      </span>
    </div>
  );
}

/** summary → SummaryBlock. A free-text summary of the run so far. */
export function SummaryBlock({ event }: RowProps<AgentEvents.SummaryEvent>): JSX.Element {
  return (
    <div className={ROW_BASE} data-event-type="summary">
      <span className={`${ROW_LABEL} text-[var(--zoc-ember)]`}>Summary</span>
      <span className={ROW_TEXT}>{event.text}</span>
    </div>
  );
}

/* ── Approval decision seam (transport wired in task 3.4) ─────────────── */

/** The verdicts an ApprovalRow can record. */
export type ApprovalDecision = "approve" | "reject";

/**
 * Payload the decision transport receives. Bound by default to the single
 * decision client (`gateway-client.postAgentDecision`) which POSTs to
 * `/v1/agent/decision`; kept structurally compatible with that client so it
 * can be swapped for a test double via the `onDecision` prop.
 */
export interface AgentDecisionRequest {
  runId: string;
  decision: ApprovalDecision;
}

export interface ApprovalRowProps extends RowProps<AgentEvents.ApprovalEvent> {
  /**
   * Sends the recorded decision to the Gateway. Defaults to the single
   * decision client (`gateway-client.postAgentDecision`) and stays injectable
   * so tests can substitute a transport double. Selecting an action posts
   * exactly one decision and disables both buttons; the actions are re-enabled
   * only if this handler rejects (a transport error), so a genuine decision is
   * never lost (R5.2, R5.3).
   */
  onDecision?: (request: AgentDecisionRequest) => void | Promise<void>;
}

/**
 * approval → ApprovalRow. Presents the approve and reject actions for an
 * approval prompt (R5.1). Selecting either posts exactly one decision to
 * `POST /v1/agent/decision` through the single decision client, disables BOTH
 * actions, and ignores any subsequent selection (R5.2, R5.3). The Gateway's
 * budget-exceeded pause is delivered as an `approval` Event_Row, so this same
 * row and the same `/decision` path resolve it (R5.4). A decision already
 * carried on the event pre-records the choice so both actions render disabled.
 *
 * The actions are re-enabled ONLY if the post rejects with a transport error,
 * so a genuine decision is never lost and the developer can retry; a
 * successful post keeps both disabled.
 */
export function ApprovalRow({
  event,
  onDecision = postAgentDecision,
}: ApprovalRowProps): JSX.Element {
  const [decision, setDecision] = useState<ApprovalDecision | undefined>(event.decision);
  // Synchronous guard: React state updates are async, so a ref pins the
  // "a decision is recorded or in flight" fact immediately. This makes the
  // post fire at most once even under rapid/concurrent clicks (R5.2, R5.3) and
  // lets a transport error reopen the row by clearing the guard.
  const settledRef = useRef<boolean>(event.decision !== undefined);
  const decided = decision !== undefined;

  async function handleDecision(choice: ApprovalDecision): Promise<void> {
    // Ignore any selection once a decision is recorded or in flight.
    if (settledRef.current) {
      return;
    }
    settledRef.current = true;
    // Disable both actions immediately on selection.
    setDecision(choice);
    try {
      // Post exactly one decision carrying the row's runId and the verdict.
      await onDecision({ runId: event.runId, decision: choice });
      // Success: the decision stands; both actions stay disabled.
    } catch {
      // Transport error: the post did not land, so re-enable both actions to
      // avoid losing a genuine decision and allow a retry.
      settledRef.current = false;
      setDecision(undefined);
    }
  }

  return (
    <div className={`${ROW_BASE} border-[var(--zoc-ember)]/40`} data-event-type="approval">
      <span className={`${ROW_LABEL} text-[var(--zoc-ember)]`}>Approval</span>
      <span className={ROW_TEXT}>{event.prompt}</span>
      <span className="feed-row-actions flex items-center gap-2">
        <button
          type="button"
          className="feed-approval-action feed-approval-action--approve rounded-md border border-[var(--zoc-success)]/40 bg-[var(--zoc-success)]/10 px-2.5 py-0.5 text-[11px] font-semibold text-[var(--zoc-success)] transition-colors hover:bg-[var(--zoc-success)]/20 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={decided}
          aria-pressed={decision === "approve"}
          onClick={() => void handleDecision("approve")}
        >
          Approve
        </button>
        <button
          type="button"
          className="feed-approval-action feed-approval-action--reject rounded-md border border-[var(--zoc-error)]/40 bg-[var(--zoc-error)]/10 px-2.5 py-0.5 text-[11px] font-semibold text-[var(--zoc-error)] transition-colors hover:bg-[var(--zoc-error)]/20 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={decided}
          aria-pressed={decision === "reject"}
          onClick={() => void handleDecision("reject")}
        >
          Reject
        </button>
      </span>
      {decided && (
        <span className={`${TAG_BASE} feed-tag--decision-${decision} border border-[var(--zoc-row-border)] bg-[var(--zoc-panel)] text-[var(--zoc-text-muted)]`}>
          {decision}
        </span>
      )}
    </div>
  );
}

/** done → DoneRow. Terminal completion of the run (R3.4). */
export function DoneRow({ event }: RowProps<AgentEvents.DoneEvent>): JSX.Element {
  return (
    <div className={ROW_BASE} data-event-type="done">
      <span className="flex items-center gap-2">
        <span className={`${ROW_LABEL} text-[var(--zoc-success)]`}>Done</span>
        <span
          className={
            event.ok
              ? `${TAG_BASE} feed-tag--ok border border-[var(--zoc-success)]/40 bg-[var(--zoc-success)]/10 text-[var(--zoc-success)]`
              : `${TAG_BASE} feed-tag--fail border border-[var(--zoc-error)]/40 bg-[var(--zoc-error)]/10 text-[var(--zoc-error)]`
          }
        >
          {event.ok ? "ok" : "failed"}
        </span>
      </span>
      {event.reason !== undefined && <span className={ROW_TEXT}>{event.reason}</span>}
    </div>
  );
}

/**
 * One component per event type (R3.2, R3.3). A generic component view is used
 * so the registry can be indexed by the discriminator while each entry still
 * binds to its concrete event interface.
 */
export type RowComponent = ComponentType<RowProps<AgentEvents.AgentEvent>>;

/**
 * The authoritative event-type → row-component mapping. Exactly eight entries,
 * one per Event_Contract kind, enforced by `Record<EventType, ...>` (R3.2).
 */
export const ROW_COMPONENTS: Record<EventType, RowComponent> = {
  intent: IntentRow as RowComponent,
  thinking: ThinkingRow as RowComponent,
  "read-files": ReadFilesRow as RowComponent,
  "edit-file": EditFileRow as RowComponent,
  command: CommandRow as RowComponent,
  summary: SummaryBlock as RowComponent,
  approval: ApprovalRow as RowComponent,
  done: DoneRow as RowComponent,
};

/**
 * Returns true only for the eight recognized Event_Contract types (R3.5).
 * Consumed by `AgentRunFeed` so an unrecognized payload is discarded without
 * altering the rendered feed.
 */
export function isRecognizedEvent(event: { type?: unknown }): event is AgentEvents.AgentEvent {
  return typeof event.type === "string" && Object.prototype.hasOwnProperty.call(ROW_COMPONENTS, event.type);
}
