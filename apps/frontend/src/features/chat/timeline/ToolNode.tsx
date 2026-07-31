/**
 * A timeline node — zoc-agent-chat-rebuild R9.7, R19.1, R19.3, R21.7, 16.1.
 *
 * One 8 px glyph on the rail, and the only thing in the timeline that animates. Its whole job
 * is to encode *what a tool did* in a shape, so a reader learns six shapes once rather than a
 * glyph per tool — and so the state survives without colour (R21.7), which is why the shape is
 * the carrier and the tint is decoration.
 *
 * **Drawn as SVG rather than a bordered `div`.** A triangle and a diamond are not expressible
 * as CSS borders without a hack that breaks at fractional device-pixel ratios, and the six
 * shapes have to read as one family at 8 px — same optical weight, same box. One `viewBox` and
 * six paths gives that; three `border-radius` tricks and a rotated square does not.
 */
import { m } from "motion/react";

import {
  resolveMotionVariant,
  staticStateCue,
  useMotionBudgetProps,
  useReducedMotion,
} from "@/lib/reduced-motion";
import { cn } from "@/lib/utils";
import { nodeShapeOf, type NodeShape, type ToolEntryState } from "./tool-entry-model";
import type { ToolKind } from "@zoc-studio/shared-types";

/** The looping variant a running node draws from. R19.3 gates it. */
const RUNNING_VARIANT = "node-pulse" as const;

/** The node's own coordinate box. 12 u for a 8 px render, so a 1 u stroke is crisp. */
const VIEW_BOX = "0 0 12 12";

/** Each shape as one closed path on that box, all with the same optical area. */
const PATH_BY_SHAPE: Readonly<Record<NodeShape, string>> = {
  "circle-hollow": "M6 1.5A4.5 4.5 0 1 1 6 10.5A4.5 4.5 0 1 1 6 1.5Z",
  "circle-filled": "M6 1.5A4.5 4.5 0 1 1 6 10.5A4.5 4.5 0 1 1 6 1.5Z",
  square: "M2 2H10V10H2Z",
  diamond: "M6 1L11 6L6 11L1 6Z",
  "diamond-hollow": "M6 1L11 6L6 11L1 6Z",
  triangle: "M6 1.5L11 10.5H1Z",
};

/** Which shapes are drawn as an outline rather than a fill. */
const HOLLOW: ReadonlySet<NodeShape> = new Set(["circle-hollow", "diamond-hollow"]);

/** The token a node paints from, by state. Failure is the only state that leaves the rail. */
function colourOf(state: ToolEntryState): string {
  switch (state) {
    case "failed":
      return "var(--zoc-error)";
    case "denied":
      return "var(--zoc-ember)";
    case "running":
      return "var(--zoc-agent)";
    case "succeeded":
      return "var(--zoc-text-faint)";
  }
}

export interface ToolNodeProps {
  kind: ToolKind;
  state: ToolEntryState;
  className?: string;
}

export function ToolNode({ kind, state, className }: ToolNodeProps) {
  const reducedMotion = useReducedMotion();
  const budgetProps = useMotionBudgetProps();

  const shape = nodeShapeOf(kind, state);
  const hollow = HOLLOW.has(shape);
  const colour = colourOf(state);
  const running = state === "running";

  // One element animates, and only while the call is in flight (R19.5's arithmetic gives the
  // timeline one slot per running node). Under reduced motion this resolves to the visible end
  // state with no transition, so nothing loops (R19.3).
  const pulse = resolveMotionVariant(RUNNING_VARIANT, reducedMotion);
  // With motion suppressed the running state needs a non-animated carrier, or "this is still
  // going" is communicated by nothing at all (R19.3, R21.7).
  const cue = running && reducedMotion ? staticStateCue("active") : null;

  const glyph = (
    <path
      d={PATH_BY_SHAPE[shape]}
      fill={hollow ? "none" : colour}
      stroke={hollow ? colour : "none"}
      strokeWidth={hollow ? 1.5 : 0}
      data-zoc-node-glyph=""
    />
  );

  return (
    <span
      className={cn("inline-flex shrink-0 items-center justify-center", className)}
      style={{ width: "var(--zoc-node-size)", height: "var(--zoc-node-size)" }}
      data-zoc-tool-node=""
      // Both facts on the element, so a test — and a stylesheet — can read the shape without
      // re-deriving it from the kind, and R21.7's "state is not colour-only" is checkable.
      data-shape={shape}
      data-state={state}
      {...(cue !== null ? { "data-cue": cue.label } : {})}
      // The node is decoration: the entry's own `aria-label` already names the tool, its state,
      // and its duration, so announcing the glyph would repeat all three.
      aria-hidden
    >
      <svg viewBox={VIEW_BOX} width="100%" height="100%" focusable={false}>
        {running ? (
          <m.g {...pulse} {...budgetProps}>
            {glyph}
          </m.g>
        ) : (
          glyph
        )}
      </svg>
    </span>
  );
}
