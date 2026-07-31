/**
 * The action badge — zoc-agent-chat-rebuild R10.11, R21.7, task 18.2.
 *
 * One letter and one shape in a fixed-width monospace slot, per plan file: `A` create, `M` modify,
 * `D` delete, `R` rename. The letter is the compact form the plan card's file rows need; the shape is
 * what makes the four distinguishable without colour perception (R21.7), and it is drawn from the same
 * geometric vocabulary the tool timeline teaches — filled means "this writes something new", an outline
 * means "this takes something away", an arrow means "this moves".
 *
 * **The badge is `aria-hidden`, and the action reaches a screen reader as a word.** A file row's
 * accessible name states the action in full ("create src/a.ts, +41 −0, 1 hunk"), so announcing the badge
 * as well would read the same fact twice — once as a letter that means nothing spoken. `DiffReview`'s
 * header states the action in words for the same reason: a diff open in front of you should not require
 * decoding a letter.
 *
 * **Drawn as SVG rather than bordered `div`s**, following `ToolNode`: an arrow and a half-filled circle
 * are not expressible as CSS borders without hacks that break at fractional device-pixel ratios, and the
 * four shapes have to read as one family at 8 px.
 */
import type { HunkAction } from "@zoc-studio/shared-types";

import { cn } from "@/lib/utils";
import { ACTION_LETTER } from "./hunk-lines";

/** The badge's coordinate box. 12 u for an 8 px render, so a 1 u stroke is crisp. */
const VIEW_BOX = "0 0 12 12";

function glyphOf(action: HunkAction) {
  const colour = "var(--zoc-text-secondary)";
  switch (action) {
    case "create":
      return <circle cx="6" cy="6" r="4" fill={colour} />;
    case "modify":
      return (
        <>
          <circle cx="6" cy="6" r="4" fill="none" stroke={colour} strokeWidth="1.5" />
          {/* The filled left half: "some of this file changes", against create's filled whole. */}
          <path d="M6 2A4 4 0 0 0 6 10Z" fill={colour} />
        </>
      );
    case "delete":
      return <rect x="2.5" y="2.5" width="7" height="7" fill="none" stroke={colour} strokeWidth="1.5" />;
    case "rename":
      return (
        <path
          d="M2 6H9M6.5 3L9.5 6L6.5 9"
          fill="none"
          stroke={colour}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
  }
}

export interface ActionBadgeProps {
  action: HunkAction;
  className?: string;
}

export function ActionBadge({ action, className }: ActionBadgeProps) {
  return (
    <span
      className={cn("inline-flex w-6 shrink-0 items-center gap-1 font-mono", className)}
      data-zoc-action-badge={action}
      style={{ fontSize: "var(--zoc-text-label)", color: "var(--zoc-text-secondary)" }}
      aria-hidden
    >
      <svg
        viewBox={VIEW_BOX}
        width="var(--zoc-node-size)"
        height="var(--zoc-node-size)"
        focusable={false}
        data-zoc-action-shape={action}
      >
        {glyphOf(action)}
      </svg>
      {ACTION_LETTER[action]}
    </span>
  );
}
