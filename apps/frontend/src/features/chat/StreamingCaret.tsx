/**
 * The streaming caret — zoc-agent-chat-rebuild R19.1, R19.3, R21.7, task 23.1.
 *
 * Feature: zoc-agent-chat-rebuild, task 23.1 (R19.1, R19.3, R21.7).
 *
 * The third of the three animated nodes named by 23.1, beside the rail node (`ToolNode`) and the
 * mark spark (`ZocMark`). It marks the open text part: the answer is still arriving, and the last
 * character is not the last character.
 *
 * ## Why it is a component and not a `::after`
 *
 * A pseudo-element cannot carry a reduced-motion cue. `caret-blink` is a *loop*, and R19.3 requires
 * a loop to stop outright rather than slow down — which leaves "still arriving" communicated by
 * nothing at all unless a static carrier takes over. `staticStateCue("active")` is that carrier, the
 * same substitution `ToolNode` makes for the running node, so the two agree on what a stopped
 * animation is replaced by rather than each inventing an answer.
 *
 * ## Why it is `aria-hidden` and still has a label
 *
 * The caret is decorative to a screen reader — the transcript's live region already reports the text
 * as it arrives (R21.2), and a blinking block announced beside every delta would be noise. Under
 * reduced motion the cue's label rides along as a `title` so the fact survives in the accessibility
 * tree for a user who has motion off but is reading visually, which is the case the cue exists for.
 */
import { m } from "motion/react";

import { cn } from "@/lib/utils";
import {
  resolveMotionVariant,
  staticStateCue,
  useMotionBudgetProps,
  useReducedMotion,
} from "@/lib/reduced-motion";

/** The registry entry this component is the sole consumer of. */
const CARET_VARIANT = "caret-blink" as const;

export interface StreamingCaretProps {
  className?: string;
}

export function StreamingCaret({ className }: StreamingCaretProps) {
  const reducedMotion = useReducedMotion();
  const budgetProps = useMotionBudgetProps();

  // One element animates (R19.5's arithmetic gives the caret exactly one slot). Under reduced motion
  // this resolves to the visible end state with no transition, so nothing blinks (R19.3).
  const blink = resolveMotionVariant(CARET_VARIANT, reducedMotion);
  // With the blink suppressed, "still arriving" needs a non-animated carrier or it is communicated by
  // nothing at all (R19.3, R21.7).
  const cue = reducedMotion ? staticStateCue("active") : null;

  return (
    <m.span
      aria-hidden
      data-zoc-streaming-caret=""
      // Both facts on the element, so a test can read the reduced-motion substitution without
      // re-deriving it from a media query.
      data-reduced-motion={reducedMotion ? "" : undefined}
      {...(cue ? { "data-cue": cue.label, title: cue.label } : {})}
      className={cn("ml-0.5 inline-block w-[0.5ch] align-baseline", className)}
      style={{
        // Sized from the type scale rather than a fixed height, so the caret matches whatever line
        // the answer's last character sits on.
        height: "1em",
        // The token layer supplies the colour for the same reason `ZocMark` does not paint from
        // `cue.colorVar`: those names belong to the earlier R6.8 cue palette and resolve to nothing
        // in the Chat_Surface layer, which would draw an invisible caret.
        backgroundColor: "var(--zoc-agent)",
        // Reduced motion swaps the blink for a steady, dimmer bar — present, but not shouting.
        opacity: reducedMotion ? 0.6 : undefined,
      }}
      {...blink}
      {...budgetProps}
    />
  );
}
