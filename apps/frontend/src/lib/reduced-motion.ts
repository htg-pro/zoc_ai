/**
 * Reduced-motion system (R6.6, R6.8) and the Chat_Surface's motion gate
 * (R19.1, R19.2, R19.3, R19.5).
 *
 * The pure pieces — `motionClass` (token → CSS class, animated vs static) and
 * `staticStateCue` (run state → distinct static icon + color) — are exercised
 * by property tests. `useReducedMotion` mirrors the OS `prefers-reduced-motion`
 * preference into React state for components that swap animated nodes for
 * static ones.
 *
 * Two systems live here, and that is deliberate for the length of the cutover.
 * The class-based half (`motionClass`, `transitionClass`, `ANIMATED_CLASS`,
 * `STATIC_CLASS`, `TRANSITIONS`) serves the Legacy_Panel and is removed by task
 * 26.2, not before: `features/agent/rows.tsx` and `RunCardView.tsx` import from
 * it by name. The `MOTION_VARIANTS` half at the bottom of the file serves the
 * Chat_Surface, whose animations run through `motion` rather than keyframes.
 * `useReducedMotion()` keeps its exact signature and is shared by both, which
 * is what keeps the Monaco decoration callers untouched.
 */
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { TargetAndTransition, Transition } from "motion/react";

/** Continuous/looping animation tokens defined by the Motion_System (R6.1). */
export type MotionToken =
  | "pulse-dot"
  | "orb-glow"
  | "shimmer"
  | "caret-blink"
  | "typing-dot"
  | "fade-row"
  | "spinner"
  | "progress-bar";

/**
 * Animated tokens that must be neutralized to a single fixed visual state when
 * reduced-motion is enabled (R6.6). `fade-row` is a one-shot transition that is
 * shortened rather than removed (R6.7), so it keeps a (static) class either way.
 */
const ANIMATED_CLASS: Record<MotionToken, string> = {
  "pulse-dot": "motion-pulse-dot",
  "orb-glow": "motion-orb-glow",
  shimmer: "motion-shimmer",
  "caret-blink": "motion-caret-blink",
  "typing-dot": "motion-typing-dot",
  "fade-row": "motion-fade-row",
  spinner: "motion-spinner",
  "progress-bar": "motion-progress-bar",
};

const STATIC_CLASS: Record<MotionToken, string> = {
  "pulse-dot": "motion-static-pulse-dot",
  "orb-glow": "motion-static-orb-glow",
  shimmer: "motion-static-shimmer",
  "caret-blink": "motion-static-caret-blink",
  "typing-dot": "motion-static-typing-dot",
  "fade-row": "motion-static-fade-row",
  spinner: "motion-static-spinner",
  "progress-bar": "motion-static-progress-bar",
};

/**
 * Resolve a motion token to its CSS class. With reduced-motion enabled the
 * static (no continuous/looping animation) variant is returned; otherwise the
 * animated variant.
 */
export function motionClass(token: MotionToken, reducedMotion: boolean): string {
  return reducedMotion ? STATIC_CLASS[token] : ANIMATED_CLASS[token];
}

/** Whether a resolved motion class is a looping/continuous (animated) variant. */
export function isAnimatedClass(cls: string): boolean {
  return (Object.values(ANIMATED_CLASS) as string[]).includes(cls);
}

/* ── Transition tokens (R18.3, R18.6) ─────────────────────────────────────
 *
 * The chat surface's row entry, row expansion, and state-change transitions
 * draw their duration + easing from this closed registry only. A property test
 * collects every transition class rendered in the tree and asserts membership
 * here, so "only those tokens" (R18.3) is checkable rather than aspirational.
 */

export type TransitionToken = "row-enter" | "row-expand" | "state-change";

export const TRANSITIONS: Readonly<
  Record<TransitionToken, { ms: number; easing: string }>
> = {
  "row-enter": { ms: 160, easing: "cubic-bezier(0.2, 0, 0, 1)" },
  "row-expand": { ms: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" },
  "state-change": { ms: 120, easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
};

/** Reduced motion replaces movement with opacity, capped at this many ms (R18.6). */
export const REDUCED_MOTION_MAX_MS = 100;

const TRANSITION_CLASS: Record<TransitionToken, string> = {
  "row-enter": "zoc-transition-row-enter",
  "row-expand": "zoc-transition-row-expand",
  "state-change": "zoc-transition-state-change",
};

/** The single reduced-motion transition class: opacity-only, ≤ 100 ms (R18.6). */
export const REDUCED_MOTION_TRANSITION_CLASS = "zoc-transition-reduced";

/** The full closed set of transition classes this system can emit. */
export const TRANSITION_CLASSES: readonly string[] = [
  ...Object.values(TRANSITION_CLASS),
  REDUCED_MOTION_TRANSITION_CLASS,
];

/**
 * Resolve a transition token to its CSS class. Under reduced motion every token
 * collapses to a single opacity-only class whose duration does not exceed
 * {@link REDUCED_MOTION_MAX_MS} (R18.6); otherwise the token's movement class.
 */
export function transitionClass(token: TransitionToken, reducedMotion: boolean): string {
  return reducedMotion ? REDUCED_MOTION_TRANSITION_CLASS : TRANSITION_CLASS[token];
}

/** Whether a class belongs to the declared transition-token registry (R18.3). */
export function isTransitionClass(cls: string): boolean {
  return TRANSITION_CLASSES.includes(cls);
}

export type RunCueState = "active" | "complete" | "error";

export interface StateCue {
  /** lucide-react icon name used for the static indicator. */
  icon: string;
  /** Design-token color variable name (without `var(...)`). */
  colorVar: string;
  /** Accessible label for the state. */
  label: string;
}

/**
 * Static icon + color cue for a run state, used when reduced-motion replaces
 * the animated indicator (R6.8). Each state is pairwise distinct.
 */
export function staticStateCue(state: RunCueState): StateCue {
  switch (state) {
    case "active":
      return { icon: "Loader", colorVar: "--accent-purple", label: "Active" };
    case "complete":
      return { icon: "CheckCircle2", colorVar: "--success", label: "Complete" };
    case "error":
      return { icon: "XCircle", colorVar: "--danger", label: "Error" };
  }
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** React hook mirroring the OS reduced-motion preference. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(REDUCED_MOTION_QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    setReduced(mql.matches);
    mql.addEventListener?.("change", onChange);
    return () => mql.removeEventListener?.("change", onChange);
  }, []);

  return reduced;
}

/* ── Motion variant registry (R19.1, R19.2, R19.3, R19.5) ─────────────────
 *
 * Feature: zoc-agent-chat-rebuild, task 12.3.
 *
 * **Additive.** Everything above stays exactly as it is until task 26.2:
 * `features/agent/rows.tsx` and `RunCardView.tsx` import `motionClass`,
 * `transitionClass`, and `useReducedMotion` by name, and the twelve legacy
 * keyframes those classes resolve to are still in `globals.css`. The
 * Chat_Surface uses the registry below and none of the class helpers; the two
 * systems coexist for the length of the cutover.
 *
 * The registry is the Chat_Surface's whole animation inventory — one entry per
 * row of the Design_Document's motion table — which is what makes R19.1 and
 * R19.2 checkable facts about a data structure rather than review conventions:
 *
 * | Variant             | Trigger                        | Properties        | Duration     |
 * |---------------------|--------------------------------|-------------------|--------------|
 * | `row-entrance`      | a settled row mounts           | opacity, y 4→0    | 200 ms       |
 * | `card-entrance`     | plan / diff / error card mounts| opacity, scale    | 240 ms       |
 * | `dock-entrance`     | request becomes pending        | opacity, y 8→0    | 240 ms       |
 * | `row-expand`        | disclosure toggled             | opacity           | 200 ms       |
 * | `mark-breath`       | Run enters `running`           | opacity           | 2400 ms loop |
 * | `node-pulse`        | tool call running              | opacity, scale    | 1400 ms loop |
 * | `caret-blink`       | text part open                 | opacity           | 1000 ms loop |
 * | `pill-state-change` | run state transition           | opacity           | 140 ms       |
 * | `hunk-decision`     | accept / reject                | opacity           | 80 ms        |
 *
 * Two entries in that table need a word of explanation.
 *
 * `row-expand` animates opacity only. The height half of a disclosure is a
 * layout property, and R19.1 confines this registry to `transform`, `opacity`,
 * and `filter`; the height change therefore rides the existing
 * `zoc-transition-row-expand` CSS token (see `TRANSITIONS` above), which the
 * `prefers-reduced-motion` block in `globals.css` already caps and collapses.
 * Keeping height out of the registry is what lets every entry satisfy R19.1
 * without an exemption.
 *
 * The toast slot in R19.5's arithmetic (1 row + 1 card + 2 expands + 1 mark +
 * 3 nodes + 1 caret + 1 pill + 1 toast = 11) belongs to `sonner`, which
 * animates its own toasts. It has no entry here because nothing in this
 * registry drives it — but it does occupy one of the twelve, which is why
 * {@link MOTION_CONCURRENCY_LIMIT} is counted at the provider and not derived
 * from the registry's size.
 */

/** The only CSS properties a registry entry may animate (R19.1). */
export type AnimatableProperty = "transform" | "opacity" | "filter";

/** R19.1's closed property budget. */
export const ANIMATABLE_PROPERTIES: readonly AnimatableProperty[] = [
  "transform",
  "opacity",
  "filter",
];

/** No entrance animation may run longer than this (R19.2). */
export const MOTION_MAX_ENTRANCE_MS = 240;

/** The Chat_Surface animates no more elements than this at once (R19.5). */
export const MOTION_CONCURRENCY_LIMIT = 12;

/**
 * Durations mirroring the `--zoc-dur-*` tokens in `globals.css`, so a duration
 * lives in one place across CSS and JS. The three loop durations are declared
 * on their entries: a 2.4 s breath is not a transition duration and has no
 * token.
 */
export const MOTION_DURATION_MS = {
  instant: 80,
  fast: 140,
  base: 200,
  slow: 240,
} as const;

/** Cubic-bezier form of `--zoc-ease-out`. */
export const MOTION_EASE_OUT: [number, number, number, number] = [0.2, 0, 0, 1];

/** Cubic-bezier form of `--zoc-ease-inout`. */
export const MOTION_EASE_INOUT: [number, number, number, number] = [0.4, 0, 0.2, 1];

/** Easings a registry entry may use: the two token curves, or a linear step. */
export type MotionEasing = [number, number, number, number] | "linear";

export type MotionVariantName =
  | "row-entrance"
  | "card-entrance"
  | "dock-entrance"
  | "row-expand"
  | "mark-breath"
  | "node-pulse"
  | "caret-blink"
  | "pill-state-change"
  | "hunk-decision";

/**
 * `entrance` is the class R19.2's 240 ms ceiling applies to; `loop` is the
 * class R19.3 must be able to stop outright; `state` is a one-shot cross-fade
 * that is neither.
 */
export type MotionVariantKind = "entrance" | "loop" | "state";

export interface MotionVariantSpec {
  kind: MotionVariantKind;
  /**
   * The properties this entry declares it animates — a subset of
   * {@link ANIMATABLE_PROPERTIES}. {@link animatedPropertiesOf} derives the
   * same set from the targets, so the declaration is checkable rather than
   * trusted.
   */
  properties: readonly AnimatableProperty[];
  /** One cycle for a `loop`; the whole animation otherwise. */
  durationMs: number;
  ease: MotionEasing;
  /** `true` for the looping entries, which reduced motion must silence. */
  repeat: boolean;
  /** Keyframe timing offsets, when the entry steps rather than eases. */
  times?: readonly number[];
  initial: TargetAndTransition;
  animate: TargetAndTransition;
  exit?: TargetAndTransition;
}

export const MOTION_VARIANTS: Readonly<Record<MotionVariantName, MotionVariantSpec>> = {
  "row-entrance": {
    kind: "entrance",
    properties: ["opacity", "transform"],
    durationMs: MOTION_DURATION_MS.base,
    ease: MOTION_EASE_OUT,
    repeat: false,
    initial: { opacity: 0, y: 4 },
    animate: { opacity: 1, y: 0 },
  },
  "card-entrance": {
    kind: "entrance",
    properties: ["opacity", "transform"],
    durationMs: MOTION_DURATION_MS.slow,
    ease: MOTION_EASE_OUT,
    repeat: false,
    initial: { opacity: 0, scale: 0.985 },
    animate: { opacity: 1, scale: 1 },
  },
  "dock-entrance": {
    kind: "entrance",
    properties: ["opacity", "transform"],
    durationMs: MOTION_DURATION_MS.slow,
    ease: MOTION_EASE_OUT,
    repeat: false,
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: 8 },
  },
  "row-expand": {
    kind: "state",
    properties: ["opacity"],
    durationMs: MOTION_DURATION_MS.base,
    ease: MOTION_EASE_OUT,
    repeat: false,
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
  },
  "mark-breath": {
    kind: "loop",
    properties: ["opacity"],
    durationMs: 2400,
    ease: MOTION_EASE_INOUT,
    repeat: true,
    initial: { opacity: 1 },
    animate: { opacity: [1, 0.55, 1] },
  },
  "node-pulse": {
    kind: "loop",
    properties: ["opacity", "transform"],
    durationMs: 1400,
    ease: MOTION_EASE_INOUT,
    repeat: true,
    initial: { opacity: 1, scale: 1 },
    animate: { opacity: [1, 0.72, 1], scale: [1, 1.12, 1] },
  },
  "caret-blink": {
    kind: "loop",
    properties: ["opacity"],
    durationMs: 1000,
    // A step rather than a fade: hold, cut, hold, cut.
    ease: "linear",
    repeat: true,
    times: [0, 0.49, 0.5, 1],
    initial: { opacity: 1 },
    animate: { opacity: [1, 1, 0, 0] },
  },
  "pill-state-change": {
    kind: "state",
    properties: ["opacity"],
    durationMs: MOTION_DURATION_MS.fast,
    ease: MOTION_EASE_INOUT,
    repeat: false,
    initial: { opacity: 0 },
    animate: { opacity: 1 },
  },
  "hunk-decision": {
    kind: "state",
    properties: ["opacity"],
    durationMs: MOTION_DURATION_MS.instant,
    ease: MOTION_EASE_OUT,
    repeat: false,
    initial: { opacity: 0 },
    animate: { opacity: 1 },
  },
};

/** Every registry key, for callers that need to walk the whole inventory. */
export const MOTION_VARIANT_NAMES = Object.keys(MOTION_VARIANTS) as MotionVariantName[];

/**
 * Motion's shorthand target keys that compile down to a `transform`. Anything
 * here counts as `transform` for R19.1, and — because reduced motion must not
 * move anything — is what {@link resolveMotionVariant} drops when reduced.
 */
const TRANSFORM_TARGET_KEYS: readonly string[] = [
  "x",
  "y",
  "z",
  "translateX",
  "translateY",
  "translateZ",
  "scale",
  "scaleX",
  "scaleY",
  "scaleZ",
  "rotate",
  "rotateX",
  "rotateY",
  "rotateZ",
  "skew",
  "skewX",
  "skewY",
  "transform",
  "transformPerspective",
];

/**
 * The properties a target actually animates, with the transform shorthands
 * folded into `"transform"`. A key outside R19.1's budget is reported under its
 * own name rather than swallowed, so an out-of-budget entry is visible to a
 * caller comparing this against {@link ANIMATABLE_PROPERTIES}.
 */
export function animatedPropertiesOf(target: TargetAndTransition): readonly string[] {
  const properties = new Set<string>();
  for (const key of Object.keys(target)) {
    // Neither is an animated property: one carries the transition, the other
    // the post-animation style commit.
    if (key === "transition" || key === "transitionEnd") continue;
    properties.add(TRANSFORM_TARGET_KEYS.includes(key) ? "transform" : key);
  }
  return [...properties];
}

/**
 * The one target reduced motion resolves to: the visible end state, applied
 * with no transition. Opacity-only, so nothing moves and nothing loops (R19.3),
 * and the element still ends up in the state the animation was there to
 * reach — an entrance that is skipped must not leave a row invisible.
 */
export const REDUCED_MOTION_TARGET: TargetAndTransition = { opacity: 1 };

export interface ResolvedMotionVariant {
  initial: TargetAndTransition;
  animate: TargetAndTransition;
  exit?: TargetAndTransition;
  /** Absent under reduced motion: the target applies instantly. */
  transition?: Transition;
}

function transitionFor(spec: MotionVariantSpec): Transition {
  return {
    duration: spec.durationMs / 1000,
    ease: spec.ease,
    ...(spec.times ? { times: [...spec.times] } : {}),
    ...(spec.repeat ? { repeat: Number.POSITIVE_INFINITY, repeatType: "loop" as const } : {}),
  };
}

/**
 * Resolve a registry entry to the props a `m` element spreads. Under reduced
 * motion every entry collapses to {@link REDUCED_MOTION_TARGET} with no
 * transition, which is R19.3's second layer: `MotionConfig reducedMotion="user"`
 * suppresses transforms globally, and this suppresses the looping opacity
 * keyframes the global switch keeps.
 */
export function resolveMotionVariant(
  name: MotionVariantName,
  reducedMotion: boolean,
): ResolvedMotionVariant {
  const spec = MOTION_VARIANTS[name];
  if (reducedMotion) {
    return {
      initial: REDUCED_MOTION_TARGET,
      animate: REDUCED_MOTION_TARGET,
      ...(spec.exit ? { exit: REDUCED_MOTION_TARGET } : {}),
    };
  }
  return {
    initial: spec.initial,
    animate: spec.animate,
    ...(spec.exit ? { exit: spec.exit } : {}),
    transition: transitionFor(spec),
  };
}

/* ── Concurrency budget (R19.5) ────────────────────────────────────────────
 *
 * A dev-only counter, mounted by the `MotionConfig` wrapper in
 * `reduced-motion-provider.tsx`. Animating components spread
 * {@link useMotionBudgetProps} onto their `m` element, which increments on
 * animation start and decrements on completion. The design's arithmetic says
 * the worst case is 11 concurrent elements, so a warning past 12 is the
 * regression signal rather than a routine occurrence.
 */

export interface MotionBudget {
  /** The concurrency ceiling this counter warns past. */
  readonly limit: number;
  /** Elements animating right now. */
  readonly active: number;
  /** High-water mark since construction or the last {@link MotionBudget.reset}. */
  readonly peak: number;
  start(): void;
  complete(): void;
  reset(): void;
}

export interface MotionBudgetOptions {
  limit?: number;
  /** Injected by tests; defaults to a `console.warn`. */
  onExceeded?: (active: number, limit: number) => void;
}

export function createMotionBudget(options: MotionBudgetOptions = {}): MotionBudget {
  const limit = options.limit ?? MOTION_CONCURRENCY_LIMIT;
  const onExceeded =
    options.onExceeded ??
    ((active: number, ceiling: number) => {
      console.warn(
        `[motion] ${active} elements animating concurrently, budget is ${ceiling} (R19.5).`,
      );
    });

  let active = 0;
  let peak = 0;
  // Latched so one over-budget burst warns once rather than once per frame.
  let warned = false;

  return {
    limit,
    get active() {
      return active;
    },
    get peak() {
      return peak;
    },
    start() {
      active += 1;
      if (active > peak) peak = active;
      if (active > limit && !warned) {
        warned = true;
        onExceeded(active, limit);
      }
    },
    complete() {
      active = Math.max(0, active - 1);
      if (active <= limit) warned = false;
    },
    reset() {
      active = 0;
      peak = 0;
      warned = false;
    },
  };
}

/**
 * The budget in scope, or `null` in production and anywhere outside the
 * provider — counting animations is a development affordance, not behaviour.
 */
export const MotionBudgetContext = createContext<MotionBudget | null>(null);

/** Motion lifecycle props an animating element spreads onto its `m` node. */
export interface MotionBudgetProps {
  onAnimationStart?: () => void;
  onAnimationComplete?: () => void;
}

const NO_BUDGET_PROPS: MotionBudgetProps = {};

/**
 * Lifecycle handlers wired to the ambient {@link MotionBudget}, or an empty
 * (stable) object when there is none, so a component spreads the same props
 * either way and production carries no counter.
 */
export function useMotionBudgetProps(): MotionBudgetProps {
  const budget = useContext(MotionBudgetContext);
  return useMemo(() => {
    if (!budget) return NO_BUDGET_PROPS;
    return {
      onAnimationStart: () => budget.start(),
      onAnimationComplete: () => budget.complete(),
    };
  }, [budget]);
}
