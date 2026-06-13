/**
 * Elapsed-time formatting for the Title_Bar Running indicator (R3.2).
 *
 * Pure: turns a non-negative millisecond duration into a zero-padded
 * `HH:MM:SS` string. Hours are unbounded; minutes and seconds are in [0,59].
 */

const pad2 = (n: number): string => String(n).padStart(2, "0");

export interface ElapsedParts {
  hours: number;
  minutes: number;
  seconds: number;
}

/** Decompose a non-negative duration (ms) into H/M/S parts. */
export function elapsedParts(ms: number): ElapsedParts {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  return {
    hours: Math.floor(totalSeconds / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
  };
}

/** Format a non-negative duration (ms) as `HH:MM:SS`. */
export function formatElapsed(ms: number): string {
  const { hours, minutes, seconds } = elapsedParts(ms);
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
}
