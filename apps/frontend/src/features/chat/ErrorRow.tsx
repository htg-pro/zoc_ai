/**
 * The error row — zoc-agent-chat-rebuild R16.6, task 16.3.
 *
 * Decision tier, and the only tier with a card: an error is a thing the user has to decide about
 * (retry, rephrase, or give up), so it is boxed, bordered, and carries an `--zoc-error` left bar.
 * R16.6 names the three things it must show — the `code`, the human `message`, and a retry control
 * when `retryable` is true — and that is what the card's primary line is.
 *
 * ## Everything arrives through the normaliser, and the row takes `unknown` to guarantee it
 *
 * The prop is `unknown` rather than an `AppError`, deliberately. Three producers reach this row —
 * a Workspace_Services HTTP error, an Agent_Runtime HTTP error, and a streamed `data-zoc-error`
 * part — and R16.6's point is that the surface cannot tell them apart. Accepting a pre-normalised
 * `AppError` would let a caller hand-build one and skip the path that unwraps `envelope`, which is
 * exactly the bug 16.2 found: the flag every retry affordance reads was being dropped in transit.
 * Taking `unknown` makes `normalizeError` unskippable.
 *
 * **The retry control is `offersRetry`, not `error.retryable`.** The default has to be decided
 * once, and it is "absent means no retry" — an unclassified failure is one nothing knows how to
 * retry. `offersRetry` also refuses a cancellation whatever the flag says, because a Run the user
 * stopped is not a failure and the affordance they want is the composer.
 *
 * **`details` is behind a disclosure, not on the primary line.** The design calls it developer
 * text, bounded to 600 characters and never a raw provider body — so it does not belong in the
 * sentence a user reads. Dropping it instead would make 16.2's fix pointless for one of the four
 * fields it recovered, so it is reachable and out of the way. A row with no `details` gets no
 * control, for the reason the timeline entry gives: a disclosure that expands to nothing teaches
 * a user the UI is broken.
 *
 * **`onContinue` is R16.5's affordance and is not a retry.** An interrupted Run produced real output
 * before its stream was lost, so the useful action is to keep that output and carry on from it — not to
 * discard it and run again. The two are offered separately because they mean opposite things about the
 * partial transcript, and only the panel knows which one this row is: it passes `onContinue` for an
 * interrupted lifecycle and `onRetry` for a failure (22.8).
 */
import { useState } from "react";
import { AlertTriangle, ChevronRight, CornerDownRight, RotateCw } from "lucide-react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { normalizeError, offersRetry } from "@/lib/errors";
import { cn } from "@/lib/utils";

export interface ErrorRowProps {
  /**
   * Anything at all: an `ErrorPart`, a `RuntimeRequestError`, a gateway envelope, a bare
   * `Error`. {@link normalizeError} reduces all of them to one shape.
   */
  error: unknown;
  /** Rendered only when {@link offersRetry} says so. */
  onRetry?: () => void;
  /** R16.5: carry on from the partial transcript an interrupted Run left behind. */
  onContinue?: () => void;
  /** The code assumed when the thrown value carries none of its own. */
  fallbackCode?: string;
  className?: string;
}

export function ErrorRow({ error, onRetry, onContinue, fallbackCode, className }: ErrorRowProps) {
  const [open, setOpen] = useState(false);
  const normalised =
    fallbackCode === undefined ? normalizeError(error) : normalizeError(error, fallbackCode);
  const showRetry = offersRetry(normalised) && onRetry !== undefined;
  const hasDetails = normalised.details !== undefined && normalised.details.length > 0;

  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-[var(--zoc-radius-card)] border",
        className,
      )}
      style={{
        background: "var(--zoc-elev-1)",
        borderColor: "var(--zoc-border)",
        boxShadow: "var(--zoc-shadow-1)",
        // The left bar is a border rather than a child element, so it is exactly as tall as the
        // card whatever the message wraps to.
        borderLeftWidth: "2px",
        borderLeftColor: "var(--zoc-error)",
      }}
      data-zoc-row="error"
      data-zoc-error-code={normalised.code}
      data-zoc-error-retryable={String(normalised.retryable === true)}
    >
      <div className="flex items-start gap-2 p-3">
        <AlertTriangle
          aria-hidden
          className="size-3.5 shrink-0 translate-y-[0.1em]"
          style={{ color: "var(--zoc-error)" }}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span
            className="font-mono uppercase"
            data-zoc-error-code-label=""
            style={{
              color: "var(--zoc-error)",
              fontSize: "var(--zoc-text-label)",
              letterSpacing: "var(--zoc-tracking-label)",
            }}
          >
            {normalised.code}
          </span>
          <p
            className="break-words"
            data-zoc-error-message=""
            style={{
              color: "var(--zoc-text)",
              fontSize: "var(--zoc-text-body)",
              lineHeight: "var(--zoc-leading-body)",
            }}
          >
            {normalised.message}
          </p>
        </div>
        {showRetry ? (
          <button
            type="button"
            onClick={onRetry}
            data-zoc-error-retry=""
            className="inline-flex shrink-0 items-center gap-1 rounded-[var(--zoc-radius-chip)] border px-2 py-1 hover:bg-[var(--zoc-row-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]"
            style={{
              borderColor: "var(--zoc-border)",
              color: "var(--zoc-text-secondary)",
              fontSize: "var(--zoc-text-label)",
            }}
          >
            <RotateCw aria-hidden className="size-3" />
            Retry
          </button>
        ) : null}
        {onContinue === undefined ? null : (
          <button
            type="button"
            onClick={onContinue}
            data-zoc-error-continue=""
            className="inline-flex shrink-0 items-center gap-1 rounded-[var(--zoc-radius-chip)] border px-2 py-1 hover:bg-[var(--zoc-row-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]"
            style={{
              borderColor: "var(--zoc-border)",
              color: "var(--zoc-text-secondary)",
              fontSize: "var(--zoc-text-label)",
            }}
          >
            <CornerDownRight aria-hidden className="size-3" />
            Continue with what we have
          </button>
        )}
      </div>

      {hasDetails ? (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger
            className="flex w-full items-center gap-1 px-3 pb-2 text-left"
            data-zoc-error-details-trigger=""
            style={{ color: "var(--zoc-text-faint)", fontSize: "var(--zoc-text-label)" }}
          >
            <ChevronRight
              aria-hidden
              className={cn(
                "size-3 shrink-0 transition-transform zoc-transition-row-expand",
                open && "rotate-90",
              )}
            />
            Details
          </CollapsibleTrigger>
          <CollapsibleContent data-zoc-error-details="">
            <pre
              className="overflow-x-auto whitespace-pre-wrap break-words px-3 pb-3 font-mono"
              style={{
                color: "var(--zoc-text-muted)",
                fontSize: "var(--zoc-text-meta)",
                lineHeight: "var(--zoc-leading-meta)",
              }}
            >
              {normalised.details}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}
