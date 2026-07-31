/**
 * Property 85: Token_Rate measures generation, not time-to-first-token.
 * Validates R13.8.
 *
 * The generator is the one design.md:3702 says lives in the runtime's own suite rather
 * than the renderer's — an output-delta schedule paired with **two** time-to-first-token
 * intervals — and the pairing is the whole design of the property. Drawing both
 * intervals per case makes each iteration its own invariance check: the same schedule is
 * measured twice, once behind a short wait and once behind a long one, and the two rates
 * must agree *within that draw*. A regression to dispatch-anchored timing therefore fails
 * on a single case rather than needing a comparison across iterations to notice.
 *
 * The other three clauses are the ones a plausible rewrite gets wrong rather than a typo:
 * `null` before the first delta, `null` for a zero-width interval (which is a division by
 * zero, not a rate of zero), and — after reconciliation — exactly the provider's token
 * count over the first-to-last-delta span.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { createTokenRateMeter } from "../token-rate.ts";

/** Property 85 runs at the default 100 (design.md:4464). */
const RUNS = { numRuns: 100 } as const;

/** One delta: how long after the previous one it arrived, and how big it was. */
interface Delta {
  readonly gapMs: number;
  readonly chars: number;
}

/**
 * A schedule of at least two deltas.
 *
 * Two is the floor because a single delta spans no interval, and that case is asserted
 * separately rather than mixed in — a generator that sometimes produced one delta would
 * make the invariance clause vacuously true for those draws.
 */
const schedule: fc.Arbitrary<readonly Delta[]> = fc.array(
  fc.record({
    gapMs: fc.integer({ min: 0, max: 400 }),
    chars: fc.integer({ min: 1, max: 200 }),
  }),
  { minLength: 2, maxLength: 40 },
);

/** The two waits before the first token, drawn per case. */
const ttftPair: fc.Arbitrary<readonly [number, number]> = fc.tuple(
  fc.integer({ min: 0, max: 60_000 }),
  fc.integer({ min: 0, max: 60_000 }),
);

const reportedTokens = fc.integer({ min: 1, max: 20_000 });

/** Play a schedule into a meter that starts counting `ttftMs` after dispatch. */
function play(
  deltas: readonly Delta[],
  ttftMs: number,
  reported: number | null,
): { rate: number | null; spanMs: number } {
  // The clock is `NaN` on purpose: every timestamp is supplied explicitly, so any code
  // path that fell back to reading the clock would produce `NaN` and fail loudly rather
  // than quietly making the property measure wall time.
  const meter = createTokenRateMeter({ now: () => Number.NaN });
  let at = ttftMs;
  let first: number | null = null;
  for (const delta of deltas) {
    at += delta.gapMs;
    if (first === null) first = at;
    meter.observeDelta(delta.chars / 4, at);
  }
  if (reported !== null) meter.reconcile(reported);
  return { rate: meter.current(), spanMs: at - (first ?? at) };
}

/** The reported rate, rounded exactly as the meter rounds it. */
function expectedRate(tokens: number, spanMs: number): number | null {
  if (spanMs <= 0 || tokens <= 0) return null;
  return Math.round(((tokens * 1000) / spanMs) * 10) / 10;
}

describe("Property 85: Token_Rate measures generation, not time-to-first-token (R13.8)", () => {
  it("computes the same rate for both time-to-first-token intervals", () => {
    fc.assert(
      fc.property(schedule, ttftPair, reportedTokens, (deltas, [shortWait, longWait], tokens) => {
        const behindShort = play(deltas, shortWait, tokens);
        const behindLong = play(deltas, longWait, tokens);

        // The invariance check, inside one draw. Both halves also have to agree about the
        // interval itself, or an implementation could reach the same rate by two wrongs.
        expect(behindLong.spanMs).toBe(behindShort.spanMs);
        expect(behindLong.rate).toBe(behindShort.rate);
      }),
      RUNS,
    );
  });

  it("equals the provider's output tokens over the first-to-last-delta interval", () => {
    fc.assert(
      fc.property(schedule, ttftPair, reportedTokens, (deltas, [ttftMs], tokens) => {
        const { rate, spanMs } = play(deltas, ttftMs, tokens);
        expect(rate).toBe(expectedRate(tokens, spanMs));
      }),
      RUNS,
    );
  });

  it("is null before the first output delta, whatever the wait was", () => {
    fc.assert(
      fc.property(ttftPair, reportedTokens, ([ttftMs], tokens) => {
        const meter = createTokenRateMeter({ now: () => ttftMs });
        // Reconciled but never fed a delta: a provider can report usage for a Run that
        // produced no output, and that is an absent rate rather than a zero one.
        meter.reconcile(tokens);
        expect(meter.current()).toBeNull();
        expect(meter.activeMs).toBe(0);
      }),
      RUNS,
    );
  });

  it("is null for a zero-width generation interval", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 200 }), { minLength: 1, maxLength: 20 }),
        ttftPair,
        reportedTokens,
        (sizes, [ttftMs], tokens) => {
          // Every delta at the same instant. The rate is undefined, not infinite and not
          // zero, so the only honest answer is none.
          const meter = createTokenRateMeter({ now: () => Number.NaN });
          for (const chars of sizes) meter.observeDelta(chars / 4, ttftMs);
          meter.reconcile(tokens);
          expect(meter.current()).toBeNull();
        },
      ),
      RUNS,
    );
  });

  it("is unaffected by the wait even before the provider reports usage", () => {
    // The estimate has to satisfy the invariance too. If it did not, the live pill would
    // move as a function of time-to-first-token and then jump when usage arrived, which is
    // the visible symptom of the bug this property exists to prevent.
    fc.assert(
      fc.property(schedule, ttftPair, (deltas, [shortWait, longWait]) => {
        expect(play(deltas, longWait, null).rate).toBe(play(deltas, shortWait, null).rate);
      }),
      RUNS,
    );
  });
});
