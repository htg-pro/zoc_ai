/**
 * One tool call in the timeline — zoc-agent-chat-rebuild R9.2, R9.3, R9.4, R9.6, R9.7, R21.4.
 *
 * Feature: zoc-agent-chat-rebuild, R9.2, R9.3, R9.4, R9.6, R9.7, R21.4.
 *
 * An `<li>` on the rail: node, tool name, one-line summary, then a right-aligned metric column
 * with the duration always rightmost. Expanding discloses the input, the output, and every
 * affected path.
 *
 * ## Three structural decisions
 *
 * **The metric column is fixed-width and the duration is always present.** That is what makes a
 * run's entries a scannable table rather than a ragged list — a reader's eye finds the duration
 * in the same place on every row, which is the whole value of R9.2's "always present".
 *
 * **The row's accessible name comes from `accessibleNameOf`, not from the DOM.** R9.7 and R21.4
 * want tool name, state, and duration in one string; assembling it inline would put the contract
 * in JSX where Property 46 cannot reach it without mounting a tree, and would let the cluster
 * name itself differently.
 *
 * **A non-retryable failure shows no retry control at all**, rather than a disabled one (R9.6).
 * A disabled button invites a user to work out why it is disabled; an absent one says the same
 * thing without asking anything of them.
 */
import { ChevronRight, RotateCw } from "lucide-react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ToolNode } from "./ToolNode";
import {
  accessibleNameOf,
  formatDuration,
  stateLabelOf,
  summarisePaths,
  truncatePath,
  type ToolEntryModel,
} from "./tool-entry-model";

export interface ToolEntryProps {
  entry: ToolEntryModel;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Rendered only when the entry failed *and* the failure is retryable (R9.6). */
  onRetry?: (toolCallId: string) => void;
  className?: string;
}

/** A monospace path list, or nothing when the call touched none. */
function PathList({ label, paths }: { label: string; paths: readonly string[] }) {
  if (paths.length === 0) return null;
  const { shown, overflow } = summarisePaths(paths);
  return (
    <div className="flex flex-wrap items-baseline gap-1" data-zoc-path-list={label}>
      <span
        className="font-mono uppercase"
        style={{
          color: "var(--zoc-text-faint)",
          fontSize: "var(--zoc-text-label)",
          letterSpacing: "var(--zoc-tracking-label)",
        }}
      >
        {label}
      </span>
      {shown.map((path) => (
        <span
          key={path}
          className="font-mono"
          // The full path is on the element, so the collapsed form is a *display* choice and
          // Property 44's "every path is reachable" holds without expanding anything.
          data-zoc-path={path}
          title={path}
          style={{ color: "var(--zoc-text-secondary)", fontSize: "var(--zoc-text-meta)" }}
        >
          {truncatePath(path)}
        </span>
      ))}
      {overflow > 0 ? (
        <span
          data-zoc-path-overflow={String(overflow)}
          style={{ color: "var(--zoc-text-faint)", fontSize: "var(--zoc-text-meta)" }}
        >
          and {overflow} more
        </span>
      ) : null}
    </div>
  );
}

/** A labelled preformatted block for the input or the output (R9.3). */
function DetailBlock({ label, body }: { label: string; body: string | undefined }) {
  if (body === undefined || body.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5" data-zoc-detail={label}>
      <span
        className="font-mono uppercase"
        style={{
          color: "var(--zoc-text-faint)",
          fontSize: "var(--zoc-text-label)",
          letterSpacing: "var(--zoc-tracking-label)",
        }}
      >
        {label}
      </span>
      <pre
        className="overflow-x-auto whitespace-pre-wrap break-words font-mono"
        // The value verbatim, which is what Property 44 compares against the source. A trim or
        // a re-serialise here would make "equal to the source values" false in a way no
        // rendering test would notice.
        data-zoc-detail-body={label}
        style={{
          color: "var(--zoc-text-secondary)",
          fontSize: "var(--zoc-text-meta)",
          lineHeight: "var(--zoc-leading-meta)",
        }}
      >
        {body}
      </pre>
    </div>
  );
}

export function ToolEntry({
  entry,
  open = false,
  onOpenChange,
  onRetry,
  className,
}: ToolEntryProps) {
  const readPaths = entry.readPaths ?? [];
  const writtenPaths = entry.writtenPaths ?? [];
  const hasDetail =
    entry.input !== undefined ||
    entry.output !== undefined ||
    readPaths.length > 0 ||
    writtenPaths.length > 0;
  // R9.6: a retry control exists only for a *retryable* failure. Not disabled — absent.
  const showRetry =
    entry.state === "failed" && entry.error?.retryable === true && onRetry !== undefined;

  const header = (
    <>
      <ToolNode kind={entry.kind} state={entry.state} />
      <span
        className="truncate font-mono"
        data-zoc-tool-name=""
        style={{ color: "var(--zoc-text)", fontSize: "var(--zoc-text-meta)" }}
      >
        {entry.toolName}
      </span>
      {entry.agentName === undefined ? null : (
        <span
          className="shrink-0 rounded-[var(--zoc-radius-chip)] border px-1 font-mono"
          data-zoc-agent-name={entry.agentName}
          style={{
            borderColor: "var(--zoc-border)",
            color: "var(--zoc-agent)",
            fontSize: "var(--zoc-text-label)",
          }}
        >
          {entry.agentName}
        </span>
      )}
      {entry.summary !== undefined && entry.summary.length > 0 ? (
        <span
          className="min-w-0 flex-1 truncate"
          data-zoc-tool-summary=""
          style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-meta)" }}
        >
          {entry.summary}
        </span>
      ) : (
        <span className="min-w-0 flex-1" />
      )}
      {/* The metric column: the runtime's figure, then the state as text, then the duration.
          Fixed order and `tabular-nums` so the column aligns across rows. */}
      {entry.metric !== undefined && entry.metric.length > 0 ? (
        <span
          className="shrink-0 font-mono tabular-nums"
          data-zoc-tool-metric=""
          style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-label)" }}
        >
          {entry.metric}
        </span>
      ) : null}
      <span
        className="shrink-0 font-mono uppercase"
        // The state as text, beside the shape: two non-colour carriers, which is R21.7 met
        // twice rather than relying on the node's tint.
        data-zoc-tool-state={entry.state}
        style={{
          color: "var(--zoc-text-faint)",
          fontSize: "var(--zoc-text-label)",
          letterSpacing: "var(--zoc-tracking-label)",
        }}
      >
        {stateLabelOf(entry.state)}
      </span>
      <span
        className="w-14 shrink-0 text-right font-mono tabular-nums"
        data-zoc-tool-duration=""
        style={{ color: "var(--zoc-text-faint)", fontSize: "var(--zoc-text-label)" }}
      >
        {formatDuration(entry.durationMs)}
      </span>
    </>
  );

  return (
    <li
      className={cn("flex flex-col", className)}
      // Restated for the same reason the timeline restates `list`: this `<li>` is a flex container,
      // and its parent is one too, so neither implicit role survives to the accessibility tree
      // unaided.
      role="listitem"
      style={{ gap: "var(--zoc-row-gap-tight)" }}
      data-zoc-tool-entry={entry.toolCallId}
      // R9.7 and R21.4's contract, from one function so the cluster cannot phrase it differently.
      aria-label={accessibleNameOf(entry)}
    >
      {hasDetail ? (
        <Collapsible open={open} onOpenChange={onOpenChange}>
          <CollapsibleTrigger
            className="flex w-full items-center gap-2 rounded-[var(--zoc-radius-chip)] px-1 py-0.5 text-left hover:bg-[var(--zoc-row-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]"
            data-zoc-tool-trigger=""
          >
            <ChevronRight
              aria-hidden
              className={cn(
                "size-3 shrink-0 transition-transform zoc-transition-row-expand",
                open && "rotate-90",
              )}
              style={{ color: "var(--zoc-text-faint)" }}
            />
            {header}
          </CollapsibleTrigger>
          <CollapsibleContent data-zoc-tool-detail="">
            <div
              className="flex flex-col gap-2 border-l pl-3 pt-1"
              style={{ borderColor: "var(--zoc-border)" }}
            >
              <DetailBlock label="input" body={entry.input} />
              <DetailBlock label="output" body={entry.output} />
              <PathList label="read" paths={readPaths} />
              <PathList label="wrote" paths={writtenPaths} />
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : (
        // No detail to disclose, so no disclosure: a trigger that expands to nothing teaches a
        // user the control is broken. Padded to match the trigger's box so the rail stays
        // aligned across rows either way.
        <div className="flex items-center gap-2 px-1 py-0.5 pl-[calc(0.75rem+0.5rem)]">
          {header}
        </div>
      )}

      {entry.error !== undefined ? (
        <div className="flex items-center gap-2 pl-6">
          <span
            data-zoc-tool-error={entry.error.code}
            style={{ color: "var(--zoc-error)", fontSize: "var(--zoc-text-meta)" }}
          >
            {entry.error.message}
          </span>
          {showRetry ? (
            <button
              type="button"
              onClick={() => onRetry(entry.toolCallId)}
              data-zoc-tool-retry=""
              aria-label={`Retry ${entry.toolName}`}
              className="inline-flex items-center gap-1 rounded-[var(--zoc-radius-chip)] px-1.5 py-0.5 hover:bg-[var(--zoc-row-bg)]"
              style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-label)" }}
            >
              <RotateCw aria-hidden className="size-3" />
              Retry
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
