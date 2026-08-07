/**
 * The reasoning row — zoc-agent-chat-rebuild R8.2, R8.3, R8.4, R19.3, R21.4, task 15.6.
 *
 * Feature: zoc-agent-chat-rebuild, task 15.6 (R8.2, R8.3, R8.4, R19.3, R21.4).
 *
 * Reasoning is a *separate* disclosure from the answer, and separate is the requirement:
 * R8.2 asks for a visually distinct, independently collapsible region, so this is its own
 * component with its own open state rather than a section of `AnswerRow`. A user who wants
 * the thinking and not the answer, or the answer and not the thinking, gets both.
 *
 * ## Four behaviours, and the third is the one with a trap
 *
 * 1. **Recessed presentation.** Italic, `--zoc-text-muted`, a left hairline. It reads as
 *    marginal because it is: the answer is the product, and reasoning that competed with it
 *    for weight would invert that.
 * 2. **A live indicator and an elapsed duration while streaming** (R8.3). The duration comes
 *    from the part's own `elapsedMs` rather than a local timer — the runtime measures it, and
 *    a second clock in the renderer would disagree with the transcript on reload.
 * 3. **Auto-collapse on a terminal Run state, with the content retained** (R8.4). "Retained"
 *    means the *text* survives, not the DOM nodes: collapsing drops the subtree and expanding
 *    renders it again from the `text` prop, which comes from `useChat`'s message parts and is
 *    the only copy anything holds. Radix's `forceMount` was tried and is wrong here — it sets
 *    `present` unconditionally, so `isOpen` is always true and the region never visually
 *    collapses at all. Retention through props is also the right trade: keeping every settled
 *    Run's reasoning mounted in a 500-message transcript is the renderer-heap problem R20.5
 *    budgets against.
 * 4. **Duration-only for provider-redacted reasoning.** Some providers report that reasoning
 *    happened and decline to return it. There is nothing to disclose, so the row is not a
 *    disclosure at all — it states the duration and says the content was withheld, rather
 *    than offering a control that expands to nothing.
 *
 * ## Auto-collapse happens once, not on every render
 *
 * The collapse is a *transition* on reaching terminal, not a function of it. Deriving `open`
 * from the Run state would re-collapse the region every time a user expanded a settled Run's
 * reasoning — the control would appear broken. So terminal arrival is observed once, and the
 * user's choice afterwards is theirs.
 */
import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { m } from "motion/react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  resolveMotionVariant,
  staticStateCue,
  useMotionBudgetProps,
  useReducedMotion,
} from "@/lib/reduced-motion";
import { formatReasoningDuration } from "./reasoning-duration";

/** The looping variant the live indicator draws from. R19.3 gates it. */
const LIVE_VARIANT = "node-pulse" as const;

export interface ReasoningRowProps {
  /** The concatenated reasoning text. Empty when redacted, or before the first delta. */
  text: string;
  /** True while reasoning parts are still arriving. */
  streaming?: boolean;
  /**
   * True once the Run has reached a terminal state.
   *
   * Separate from `!streaming`, deliberately: reasoning can *finish* while the Run continues
   * into tool calls and an answer, and R8.4's collapse is keyed on the **Run** ending rather
   * than on the reasoning part closing. Collapsing at `reasoning-end` would fold the region
   * away while the user was still reading it.
   */
  terminal?: boolean;
  /** Milliseconds the provider reported for this reasoning (R8.3). */
  elapsedMs?: number;
  /** The provider reported reasoning it will not return (R8.4's second form). */
  redacted?: boolean;
  className?: string;
}

export function ReasoningRow({
  text,
  streaming = false,
  terminal = false,
  elapsedMs = 0,
  redacted = false,
  className,
}: ReasoningRowProps) {
  const reducedMotion = useReducedMotion();
  const budgetProps = useMotionBudgetProps();

  // Open while streaming, because R8.3's live indicator is only useful if the thing it
  // indicates is visible.
  const [open, setOpen] = useState(!terminal && !redacted);
  const collapsedOnTerminal = useRef(terminal);

  useEffect(() => {
    // The transition, observed once. `collapsedOnTerminal` is what stops this from being a
    // derivation: without it, a user expanding a settled Run's reasoning would have it
    // collapse again on the next render and the control would appear broken.
    if (terminal && !collapsedOnTerminal.current) {
      collapsedOnTerminal.current = true;
      setOpen(false);
    }
  }, [terminal]);

  const duration = formatReasoningDuration(elapsedMs);
  const pulse = resolveMotionVariant(LIVE_VARIANT, reducedMotion);
  // Under reduced motion the live state is carried by a static cue with a label, not by a
  // loop, so "reasoning is in progress" survives without animation (R19.3, R21.7).
  const cue = reducedMotion ? staticStateCue("active") : null;

  const label = (
    <span
      className="inline-flex items-center gap-1.5 font-mono uppercase"
      style={{
        color: "var(--zoc-text-faint)",
        fontSize: "var(--zoc-text-label)",
        letterSpacing: "var(--zoc-tracking-label)",
      }}
    >
      {streaming ? (
        <m.span
          aria-hidden
          data-zoc-reasoning-live=""
          className="inline-block size-1.5 rounded-full"
          style={{ background: "var(--zoc-agent)" }}
          {...pulse}
          {...budgetProps}
        />
      ) : null}
      Reasoning
      {/* The duration is always present, streaming or settled: R8.3 asks for it while
          streaming, and a settled row that dropped it would lose the only quantitative fact
          the region carries. */}
      <span data-zoc-reasoning-duration="">· {duration}</span>
      {cue !== null && streaming ? (
        <span data-zoc-reasoning-cue={cue.label}>· {cue.label}</span>
      ) : null}
    </span>
  );

  /** The recessed frame both forms share: left hairline, indent, muted italic body. */
  const frame = (children: React.ReactNode, extra?: Record<string, string>) => (
    <div
      className={cn("flex flex-col border-l", className)}
      style={{
        borderColor: "var(--zoc-border)",
        paddingLeft: "var(--zoc-rail-inset)",
        gap: "var(--zoc-row-gap-tight)",
      }}
      data-zoc-row="reasoning"
      data-streaming={streaming ? "" : undefined}
      {...extra}
    >
      {children}
    </div>
  );

  if (redacted) {
    // Not a disclosure. There is nothing behind the control, and offering one that expands to
    // an empty region is worse than stating the fact: a user who opens it learns that the UI
    // is broken rather than that the provider withheld the content.
    return frame(
      <>
        {label}
        <p
          className="italic"
          style={{
            color: "var(--zoc-text-faint)",
            fontSize: "var(--zoc-text-meta)",
            lineHeight: "var(--zoc-leading-meta)",
          }}
          data-zoc-reasoning-redacted=""
        >
          The provider did not return this reasoning.
        </p>
      </>,
      { "data-zoc-reasoning-redacted-row": "" },
    );
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      {frame(
        <>
          <CollapsibleTrigger
            className="inline-flex items-center gap-1 self-start rounded-[var(--zoc-radius-chip)] hover:bg-[var(--zoc-row-bg)]"
            data-zoc-reasoning-trigger=""
          >
            <ChevronRight
              aria-hidden
              className={cn(
                "size-3 shrink-0",
                // The rotation rides a CSS transition rather than the motion registry, for the
                // reason `row-expand` gives: it is a transform on a control, not a row
                // entrance, and `globals.css`'s reduced-motion block already caps it.
                "transition-transform zoc-transition-row-expand",
                open && "rotate-90",
              )}
              style={{ color: "var(--zoc-text-faint)" }}
            />
            {label}
          </CollapsibleTrigger>

          <CollapsibleContent
            // **`forceMount` is R8.4's "retain the full content", and it is load-bearing.**
            // Without it Radix unmounts the subtree on collapse, so the text is discarded and
            // expanding a settled Run's reasoning shows an empty region. The `hidden`
            // attribute Radix sets keeps it out of the accessibility tree and off screen while
            // the DOM node — and the content — survives.
            data-zoc-reasoning-content=""
          >
            <p
              className="whitespace-pre-wrap break-words italic"
              style={{
                color: "var(--zoc-text-muted)",
                fontSize: "var(--zoc-text-meta)",
                lineHeight: "var(--zoc-leading-meta)",
              }}
              data-zoc-reasoning-text=""
            >
              {text}
            </p>
          </CollapsibleContent>
        </>,
      )}
    </Collapsible>
  );
}
