/**
 * Reduced-motion system (R6.6, R6.8).
 *
 * The pure pieces — `motionClass` (token → CSS class, animated vs static) and
 * `staticStateCue` (run state → distinct static icon + color) — are exercised
 * by property tests. `useReducedMotion` mirrors the OS `prefers-reduced-motion`
 * preference into React state for components that swap animated nodes for
 * static ones.
 */
import { useEffect, useState } from "react";

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
