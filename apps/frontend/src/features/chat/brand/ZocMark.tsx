/**
 * The Zoc AI brand mark as a component (R18.1, R18.2, R18.3, R18.7) with the
 * running-state breath (R19.1, R19.3).
 *
 * Feature: zoc-agent-chat-rebuild, task 13.2.
 *
 * The geometry is inlined rather than loaded from `public/brand/zoc-mark.svg`
 * through an `<img>`, because three of this component's four jobs need the
 * shape in the document: the gradient stops resolve from the token layer, the
 * monochrome variant inherits `currentColor`, and the running state animates a
 * layer inside the mark. The path data is byte-identical to the asset task 13.1
 * authored, and a test asserts that rather than trusting it — the asset stays
 * the source of truth, and the icon pipeline (13.3) reads the mono asset, not
 * this file.
 *
 * Run state is a prop, not a class-name convention, so the four states are a
 * closed set a reader can enumerate:
 *
 * | State      | Fill                                  | Motion                  |
 * |------------|---------------------------------------|-------------------------|
 * | `idle`     | gradient `agent-strong → agent-soft`  | none                    |
 * | `running`  | same gradient, breathing spark layer  | `mark-breath`, 2400 ms  |
 * | `complete` | `--zoc-success`                       | none                    |
 * | `failed`   | `--zoc-error`                         | none                    |
 *
 * `idle` and `running` share the gradient deliberately: the gradient is the
 * mark's own identity (R18.2's standalone variant), and R18.7 asks for activity
 * to be signalled in the mark's violet and spark palette — so the running state
 * adds the spark's breath rather than a different hue. The two terminal states
 * are the only ones that leave the violets, which is what keeps "violet means
 * Zoc AI is working" true.
 *
 * Every colour resolves through a custom property. There is no hex literal here
 * and there must not be one (R17.1).
 */
import { useId } from "react";
import { m } from "motion/react";

import { cn } from "@/lib/utils";
import {
  resolveMotionVariant,
  staticStateCue,
  useMotionBudgetProps,
  useReducedMotion,
  type RunCueState,
  type StateCue,
} from "@/lib/reduced-motion";

/**
 * The mark's optical geometry, identical to
 * `apps/frontend/public/brand/zoc-mark.svg` (task 13.1): one closed subpath,
 * non-zero winding, fill only, on a 24 u box.
 */
export const ZOC_MARK_PATH =
  "M4 4H20V7L14.75 12H17.25L12 17H20V20H4V17H7.5L12.75 12H10.25L15.5 7H4Z";

/** The mark's viewBox, shared by every variant. */
const ZOC_MARK_VIEW_BOX = "0 0 24 24";

/**
 * The rendered sizes the mark is drawn and reviewed at. 16 is the documented
 * minimum (R18.3); 40 is the empty state's size (22.8) and 48 is the
 * legibility story's (13.4), so both are in the union rather than reached
 * through a cast.
 */
export const ZOC_MARK_SIZES = [16, 20, 24, 32, 40, 48, 64] as const;

export type ZocMarkSize = (typeof ZOC_MARK_SIZES)[number];

export type ZocMarkState = "idle" | "running" | "complete" | "failed";

/**
 * The token each state paints with, so R18.7 is a fact about a data structure
 * rather than a review note: activity — `idle` and `running` — stays inside the
 * brand violets, and only the two terminal states leave them.
 */
export const ZOC_MARK_STATE_TOKENS: Readonly<Record<ZocMarkState, readonly string[]>> =
  Object.freeze({
    idle: ["--zoc-agent-strong", "--zoc-agent-soft"],
    running: ["--zoc-agent-strong", "--zoc-agent-soft"],
    complete: ["--zoc-success"],
    failed: ["--zoc-error"],
  });

/** The spark layer's highlight token, the gradient's far stop. */
const ZOC_MARK_SPARK_TOKEN = "--zoc-agent-soft";

/** The looping variant the running state draws from (R19.3 gates it). */
const ZOC_MARK_BREATH_VARIANT = "mark-breath" as const;

/** Run states that own a static cue; `idle` owns none because nothing is happening. */
const CUE_FOR_STATE: Readonly<Record<ZocMarkState, RunCueState | null>> = Object.freeze({
  idle: null,
  running: "active",
  complete: "complete",
  failed: "error",
});

export interface ZocMarkProps {
  /** Rendered size in CSS px. 16 is the documented minimum (R18.3). */
  size?: ZocMarkSize;
  /** Drives the spark's activity animation and its tint (R18.7). */
  state?: ZocMarkState;
  /** Single-colour rendering; inherits `currentColor`. */
  mono?: boolean;
  /**
   * The mark's accessible name. Omitted, the mark is decorative and hidden from
   * assistive technology — which is the right default, because most instances
   * sit beside a label that already names the thing.
   */
  title?: string;
  /** Layout passthrough; the mark itself carries no positioning. */
  className?: string;
}

/** `var(--token)`, so a token name is written once per call site. */
function tokenValue(token: string): string {
  return `var(${token})`;
}

/**
 * The colour the ring is painted in. Deliberately **not** `cue.colorVar`: those
 * names (`--accent-purple`, `--danger`) belong to the earlier R6.8 cue palette
 * and are not defined in the Spark or Chat_Surface token layers, so painting
 * from them would produce an invisible ring. `staticStateCue` supplies the fact
 * that a static cue is owed and the label that carries it as text; the token
 * layer supplies the colour, which keeps the ring inside R18.7's palette for
 * the running state.
 */
function ringColor(state: ZocMarkState, mono: boolean): string {
  if (mono) return "currentColor";
  const [token] = ZOC_MARK_STATE_TOKENS[state];
  return tokenValue(token);
}

function baseFill(state: ZocMarkState, mono: boolean, gradientId: string): string {
  if (mono) return "currentColor";
  if (state === "complete" || state === "failed") {
    return tokenValue(ZOC_MARK_STATE_TOKENS[state][0]);
  }
  return `url(#${gradientId})`;
}

export function ZocMark({
  size = 24,
  state = "idle",
  mono = false,
  title,
  className,
}: ZocMarkProps) {
  const reducedMotion = useReducedMotion();
  const budgetProps = useMotionBudgetProps();

  // React's ids carry colons, which are valid in an `id` but awkward in the
  // `url(#…)` references below; stripping them keeps the reference simple while
  // staying unique per instance, which matters because the legibility story
  // (13.4) mounts seven marks at once.
  const uid = useId().replace(/:/g, "");
  const titleId = `zoc-mark-title-${uid}`;
  const gradientId = `zoc-mark-gradient-${uid}`;
  const clipId = `zoc-mark-clip-${uid}`;

  const cueState = CUE_FOR_STATE[state];
  const cue: StateCue | null = cueState ? staticStateCue(cueState) : null;

  const labelled = typeof title === "string" && title.trim().length > 0;
  // The state rides along in the name, so a state that is otherwise a colour
  // change is also available as text (R21.7).
  const accessibleName = labelled ? (cue ? `${title} — ${cue.label}` : title) : undefined;

  const breathing = state === "running";
  // One element animates, whichever branch draws it (R19.5's arithmetic gives
  // the mark exactly one slot). Under reduced motion this resolves to the
  // visible end state with no transition, so nothing loops (R19.3).
  const breath = resolveMotionVariant(ZOC_MARK_BREATH_VARIANT, reducedMotion);

  const markBody = (
    <path
      d={ZOC_MARK_PATH}
      fill={baseFill(state, mono, gradientId)}
      fillRule="nonzero"
      data-zoc-mark-body=""
    />
  );

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={ZOC_MARK_VIEW_BOX}
      width={size}
      height={size}
      className={cn("shrink-0", className)}
      data-zoc-mark=""
      data-state={state}
      {...(labelled
        ? { role: "img", "aria-labelledby": titleId }
        : { "aria-hidden": true, focusable: false })}
    >
      {accessibleName ? <title id={titleId}>{accessibleName}</title> : null}
      {mono || state === "complete" || state === "failed" ? null : (
        <defs>
          {/* 135°: down-and-right across the optical box, in user space, so the
              angle holds at every rendered size. */}
          <linearGradient
            id={gradientId}
            gradientUnits="userSpaceOnUse"
            x1="4"
            y1="4"
            x2="20"
            y2="20"
          >
            <stop offset="0" stopColor={tokenValue("--zoc-agent-strong")} />
            <stop offset="1" stopColor={tokenValue(ZOC_MARK_SPARK_TOKEN)} />
          </linearGradient>
        </defs>
      )}

      {breathing && mono ? (
        // The monochrome variant has no second colour, so an overlay in
        // `currentColor` over an identical base would be invisible: the breath
        // applies to the mark itself. Still one animating element.
        <m.g data-zoc-mark-spark="" {...breath} {...budgetProps}>
          {markBody}
        </m.g>
      ) : (
        markBody
      )}

      {breathing && !mono ? (
        <>
          <clipPath id={clipId}>
            <path d={ZOC_MARK_PATH} />
          </clipPath>
          {/* The spark is the diagonal band between the two terminals, clipped
              to the mark, so the breath reads as the bolt lighting up rather
              than the whole logo fading. */}
          <m.g clipPath={`url(#${clipId})`} data-zoc-mark-spark="" {...breath} {...budgetProps}>
            <rect x="4" y="7" width="16" height="10" fill={tokenValue(ZOC_MARK_SPARK_TOKEN)} />
          </m.g>
        </>
      ) : null}

      {reducedMotion && cue ? (
        // The static stand-in for the breath: a ring is a shape, so the state
        // survives without motion and without colour perception (R19.3, R21.7).
        <circle
          cx="12"
          cy="12"
          r="11"
          fill="none"
          stroke={ringColor(state, mono)}
          strokeWidth="1.5"
          data-zoc-mark-ring=""
          data-cue={cue.icon}
        />
      ) : null}
    </svg>
  );
}
