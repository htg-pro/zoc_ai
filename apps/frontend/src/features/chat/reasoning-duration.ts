/**
 * The reasoning row's elapsed-duration format — zoc-agent-chat-rebuild R8.3.
 *
 * Feature: zoc-agent-chat-rebuild, R8.3.
 *
 * Its own module rather than a helper inside `ReasoningRow.tsx`, because a file exporting both
 * a component and a function is a fast-refresh boundary the Vite plugin warns about — and
 * because the format is the thing Property 7's sibling assertions read, so a test importing it
 * should not pull a component and Radix in behind it.
 */

/**
 * The elapsed duration, at the precision a reader can use.
 *
 * Sub-second reasoning is reported in milliseconds, because "0s" reads as "it did not happen"
 * and the point of the readout is that it did. Past a second, tenths — a reasoning pass timed
 * to the millisecond invites a precision the number does not have. Past a minute, `m s`,
 * because "94.0s" is a number a reader has to convert.
 */
export function formatReasoningDuration(elapsedMs: number): string {
  const safe = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  if (safe < 1000) return `${String(Math.round(safe))}ms`;
  const seconds = safe / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}m ${String(Math.round(seconds % 60))}s`;
}
