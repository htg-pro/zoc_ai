/**
 * Jump to latest — zoc-agent-chat-rebuild R20.8, task 17.2.
 *
 * Appears when the transcript is scrolled away from the newest row, and names how many rows have
 * arrived since. Both facts come from the store rather than from props: `anchored` is written by the
 * transcript's `onScroll` at the measured 32 px rule, and `rowsSinceUnanchored` is incremented by
 * the transcript as rows land. Threading either through props would put the transcript's scroll
 * state in the panel shell.
 *
 * **Re-anchoring is a store write, not a scroll call.** The control sets `anchored` and the
 * transcript's layout effect does the scrolling, so there is exactly one place that writes
 * `scrollTop` — which is what keeps R20.7's guarantee a property of one effect rather than of two
 * call sites that have to agree.
 *
 * The count is a live region: it changes while the control is on screen and a user who is reading it
 * to decide whether to jump should hear it change. `aria-atomic` is left at its default `true` here,
 * unlike the transcript's streaming region — the whole label is four words and re-reading it is the
 * announcement.
 */
import { ArrowDown } from "lucide-react";
import { m } from "motion/react";

import { resolveMotionVariant, useMotionBudgetProps, useReducedMotion } from "@/lib/reduced-motion";
import { cn } from "@/lib/utils";
import { useChatSurface } from "./store";

/** The entrance the dock and this control share: it is the same "pinned above the fold" gesture. */
const ENTRANCE_VARIANT = "dock-entrance" as const;

export interface JumpToLatestProps {
  className?: string;
}

export function JumpToLatest({ className }: JumpToLatestProps) {
  const anchored = useChatSurface((state) => state.anchored);
  const rowsSinceUnanchored = useChatSurface((state) => state.rowsSinceUnanchored);
  const setAnchored = useChatSurface((state) => state.setAnchored);
  const reducedMotion = useReducedMotion();
  const budgetProps = useMotionBudgetProps();

  // Anchored means the newest row is already in view, so the control would be a button that does
  // nothing. Rendering nothing rather than hiding it keeps it out of the tab order (R21.1).
  if (anchored) return null;

  const entrance = resolveMotionVariant(ENTRANCE_VARIANT, reducedMotion);

  return (
    <m.button
      type="button"
      onClick={() => {
        setAnchored(true);
      }}
      data-zoc-jump-to-latest=""
      className={cn(
        "absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5",
        "rounded-full border border-[color:var(--zoc-border)] bg-[color:var(--zoc-elev-2)]",
        "px-3 py-1.5 text-xs text-[color:var(--zoc-text)] shadow-lg",
        "hover:bg-[color:var(--zoc-elev-1)] focus-visible:outline-none focus-visible:ring-2",
        "focus-visible:ring-[color:var(--zoc-agent-strong)]",
        className,
      )}
      {...entrance}
      {...budgetProps}
    >
      <ArrowDown className="h-3.5 w-3.5" aria-hidden />
      <span>Jump to latest</span>
      {rowsSinceUnanchored > 0 ? (
        <span
          data-zoc-jump-count=""
          className="rounded-full bg-[color:var(--zoc-agent)]/20 px-1.5 text-[color:var(--zoc-text)]"
        >
          {rowsSinceUnanchored}
        </span>
      ) : null}
      {/*
        The visible badge is a bare number, which reads as "12" rather than as "12 new rows" to a
        screen reader. The unit is supplied here instead of through an `aria-label` on the button,
        because a label would replace the whole accessible name and the count would then have to be
        interpolated into it in a second place.
      */}
      <span className="sr-only">
        {rowsSinceUnanchored > 0
          ? `${String(rowsSinceUnanchored)} new ${rowsSinceUnanchored === 1 ? "row" : "rows"}`
          : ""}
      </span>
    </m.button>
  );
}
