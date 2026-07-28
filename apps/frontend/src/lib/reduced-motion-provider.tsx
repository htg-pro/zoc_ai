/**
 * The Chat_Surface's motion provider (R19.3, R19.5).
 *
 * Feature: zoc-agent-chat-rebuild, task 12.3.
 *
 * `ChatPanel` mounts this once, above everything that animates. It is the JSX
 * shell of the gate whose logic lives in `reduced-motion.ts` — kept in its own
 * module so the gate stays a plain module of functions and constants and a
 * component does not turn it into a fast-refresh boundary.
 *
 * Three things happen here, and each closes a hole the other two leave:
 *
 * 1. `MotionConfig reducedMotion="user"` is R19.3's kill-switch. With it,
 *    Motion follows the OS preference for every descendant: transform
 *    animations are skipped and opacity transitions are kept, which is the
 *    "disable entrance, exit, and looping animations … retain instant state
 *    changes" behaviour the requirement asks for. It is a single programmatic
 *    gate rather than a prop threaded through every row.
 * 2. `LazyMotion features={domAnimation} strict` holds the bundle budget. The
 *    `strict` flag makes the `m`-only rule a runtime error as well as a lint
 *    error: the full `motion` component throws inside this tree.
 * 3. The dev-only concurrency counter backs R19.5. It is provided through
 *    context and consumed by `useMotionBudgetProps`, so a component opts in by
 *    spreading two lifecycle props; production gets `null` and no counter.
 */
import { useMemo, type ReactNode } from "react";
import { LazyMotion, MotionConfig, domAnimation } from "motion/react";

import { MotionBudgetContext, createMotionBudget, type MotionBudget } from "./reduced-motion";

export interface ChatMotionProviderProps {
  children?: ReactNode;
  /**
   * Overrides the dev-only concurrency counter. Tests inject one to read its
   * peak; passing `null` disables counting outright. Left undefined, a counter
   * exists in development builds and not in production ones.
   */
  budget?: MotionBudget | null;
}

export function ChatMotionProvider({ children, budget }: ChatMotionProviderProps) {
  const resolvedBudget = useMemo(() => {
    if (budget !== undefined) return budget;
    return import.meta.env.DEV ? createMotionBudget() : null;
  }, [budget]);

  return (
    <MotionBudgetContext.Provider value={resolvedBudget}>
      <LazyMotion features={domAnimation} strict>
        <MotionConfig reducedMotion="user">{children}</MotionConfig>
      </LazyMotion>
    </MotionBudgetContext.Provider>
  );
}
