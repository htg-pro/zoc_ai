/**
 * Context-usage indicator computation (R4.12, R4.15).
 *
 * Pure: given consumed tokens and a context limit, returns the ratio
 * (clamped to [0,1]), an integer percent in [0,100], and a warning flag that
 * is active iff consumed/limit >= 0.9.
 */

export const CONTEXT_WARNING_THRESHOLD = 0.9;

export interface ContextUsage {
  consumed: number;
  limit: number;
  /** consumed/limit clamped to [0,1]; 0 when limit <= 0. */
  ratio: number;
  /** Integer percentage in [0,100]. */
  percent: number;
  /** True iff ratio >= 0.9. */
  warning: boolean;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

export function contextUsage(consumed: number, limit: number): ContextUsage {
  const safeConsumed = Math.max(0, consumed);
  const rawRatio = limit > 0 ? safeConsumed / limit : 0;
  const ratio = clamp01(rawRatio);
  return {
    consumed: safeConsumed,
    limit,
    ratio,
    percent: Math.round(ratio * 100),
    // Use the unclamped ratio for the threshold so >100% still warns.
    warning: limit > 0 && rawRatio >= CONTEXT_WARNING_THRESHOLD,
  };
}
