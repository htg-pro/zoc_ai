/**
 * scroll-decision.ts — the pure autoscroll decision (R18.4, R18.5).
 *
 * Automatic scrolling follows the newest row only while the viewport is at the
 * bottom; once the user scrolls away, autoscroll is suppressed and a
 * jump-to-latest affordance is offered instead. The two are exact complements.
 */

/** Default distance-from-bottom, in px, still counted as "at the newest row". */
export const AUTOSCROLL_THRESHOLD_PX = 48;

export interface ScrollDecision {
  autoScroll: boolean;
  showJumpToLatest: boolean;
}

export function scrollDecision(input: {
  distanceFromBottomPx: number;
  newRowArrived: boolean;
  thresholdPx?: number;
}): ScrollDecision {
  const threshold = input.thresholdPx ?? AUTOSCROLL_THRESHOLD_PX;
  const atBottom = input.distanceFromBottomPx <= threshold;
  return {
    autoScroll: atBottom && input.newRowArrived,
    showJumpToLatest: !atBottom,
  };
}
