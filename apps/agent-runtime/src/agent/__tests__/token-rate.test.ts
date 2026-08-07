/**
 * Token_Rate — zoc-agent-chat-rebuild R13.8, R13.10, R13.12, 9.9.
 *
 * Feature: zoc-agent-chat-rebuild, task 9.9 (R13.8, R13.10, R13.12).
 *
 * Both of 9.9's guards are here, and both are guards rather than tests in the sense
 * that they fail for a *plausible* rewrite rather than for a typo:
 *
 *   - The pre-first-token delay is outside the interval, so a regression to
 *     dispatch-anchored timing changes the number and fails.
 *   - A Run that produced no output tokens reports `null`, not `0`, because R13.12
 *     turns a `0` into a false claim about a model one level up.
 *
 * The clock is injected everywhere, so nothing here waits on wall time. That is safe
 * precisely because the *thing under test* is arithmetic over timestamps — unlike the
 * cancel grace, where the wall clock is the promise.
 */

import { describe, expect, it } from "vitest";

import {
  CHARS_PER_TOKEN,
  createNullTokenRateMeter,
  createTokenRateMeter,
  estimateTokens,
  meanTokensPerSecond,
} from "../token-rate.ts";

/** A meter over a clock the test advances by hand. */
function metered(options: { excludeToolTime?: boolean } = {}): {
  meter: ReturnType<typeof createTokenRateMeter>;
  at: (ms: number) => number;
} {
  let nowMs = 0;
  const meter = createTokenRateMeter({
    now: () => nowMs,
    ...(options.excludeToolTime === undefined ? {} : { excludeToolTime: options.excludeToolTime }),
  });
  return {
    meter,
    at: (ms) => {
      nowMs = ms;
      return ms;
    },
  };
}

describe("the interval starts at the first token (R13.8)", () => {
  it("excludes a 2 s pre-first-token delay from the denominator", () => {
    // The guard 9.9 names. Dispatch is at 0, the first token at 2000, the last at
    // 4000: two seconds of generation, not four. A regression to dispatch-anchored
    // timing halves the rate, which is why the assertion is on the number rather than
    // on the interval alone.
    const { meter } = metered();
    meter.observeDelta(0, 2_000);
    meter.observeDelta(0, 4_000);
    meter.reconcile(100);

    expect(meter.activeMs).toBe(2_000);
    expect(meter.current()).toBe(50);
  });

  it("reports the same rate whatever the time to first token was", () => {
    // The property the guard above is one case of: only the span between the first and
    // last token can move the number.
    const rates = [0, 500, 2_000, 30_000].map((ttft) => {
      const { meter } = metered();
      meter.observeDelta(0, ttft);
      meter.observeDelta(0, ttft + 2_000);
      meter.reconcile(100);
      return meter.current();
    });
    expect(new Set(rates)).toEqual(new Set([50]));
  });

  it("closes the interval at the last token, not at the moment it is read", () => {
    // Otherwise the pill's figure decays while nothing is happening, and the terminal
    // figure on the usage row depends on when the row was written.
    const { meter, at } = metered();
    meter.observeDelta(0, 1_000);
    meter.observeDelta(0, 3_000);
    meter.reconcile(100);

    expect(meter.current()).toBe(50);
    at(60_000);
    expect(meter.current()).toBe(50);
  });
});

describe("a null is not a zero (R13.10, R13.12)", () => {
  it("reports null before any delta has arrived", () => {
    const { meter } = metered();
    expect(meter.current()).toBeNull();
  });

  it("reports null for a Run that produced no output tokens", () => {
    // 9.9's second guard. A `0` here becomes a picker row claiming a model runs at zero
    // tokens per second, which is legible and false.
    const { meter } = metered();
    meter.reconcile(0);
    expect(meter.current()).toBeNull();
  });

  it("reports null for a single delta, because one token spans no interval", () => {
    const { meter } = metered();
    meter.observeDelta(1, 1_000);
    meter.reconcile(1);
    expect(meter.current()).toBeNull();
  });

  it("never divides by zero into an Infinity", () => {
    const { meter } = metered();
    meter.observeDelta(5, 1_000);
    meter.observeDelta(5, 1_000);
    meter.reconcile(10);
    expect(meter.current()).toBeNull();
  });

  it("measures nothing at all through the null meter", () => {
    // Used for the compaction summariser and the title call: provider calls that are
    // not the answer stream, so their tokens must not enter a rate that claims to
    // describe how fast the answer arrived (R27.2).
    const meter = createNullTokenRateMeter();
    meter.observeDelta(1_000, 0);
    meter.reconcile(1_000);
    expect(meter.current()).toBeNull();
    expect(meter.activeMs).toBe(0);
  });
});

describe("the numerator", () => {
  it("estimates from characters until the provider reports", () => {
    const { meter } = metered();
    meter.observeDelta(estimateTokens("a".repeat(400)), 0);
    meter.observeDelta(estimateTokens("a".repeat(400)), 1_000);

    // 800 characters over four is 200 tokens, in one second.
    expect(CHARS_PER_TOKEN).toBe(4);
    expect(meter.current()).toBe(200);
  });

  it("adopts the provider's count in place of the estimate", () => {
    const { meter } = metered();
    meter.observeDelta(estimateTokens("a".repeat(400)), 0);
    meter.observeDelta(estimateTokens("a".repeat(400)), 1_000);
    meter.reconcile(150);

    expect(meter.current()).toBe(150);
  });

  it("ignores a zero report from a provider that omitted usage", () => {
    // Several providers report no usage on a streaming response. Treating a `0` as
    // authoritative would blank the rate for exactly those providers, so the estimate
    // stands — while a Run that genuinely generated nothing still answers null, because
    // it has no deltas either.
    const { meter } = metered();
    meter.observeDelta(50, 0);
    meter.observeDelta(50, 1_000);
    meter.reconcile(0);

    expect(meter.current()).toBe(100);
  });

  it("rounds to one decimal rather than reporting false precision", () => {
    const { meter } = metered();
    meter.observeDelta(0, 0);
    meter.observeDelta(0, 3_000);
    meter.reconcile(100);
    // 33.333… tokens per second.
    expect(meter.current()).toBe(33.3);
  });
});

describe("tool time is not generation time", () => {
  it("excludes the stretch a tool held the loop", () => {
    // Two seconds of generation either side of a five-second tool call. A literal
    // wall-clock span would read 100 tokens over nine seconds — ~11 tok/s for a model
    // doing 25 — which is the fabricated figure R13.8 exists to replace.
    const { meter } = metered();
    meter.observeDelta(0, 0);
    meter.observeDelta(0, 2_000);
    meter.pause(2_100);
    meter.resume(7_100);
    meter.observeDelta(0, 7_200);
    meter.observeDelta(0, 9_200);
    meter.reconcile(100);

    expect(meter.activeMs).toBe(4_000);
    expect(meter.current()).toBe(25);
  });

  it("measures the raw span when the exclusion is switched off", () => {
    const { meter } = metered({ excludeToolTime: false });
    meter.observeDelta(0, 0);
    meter.observeDelta(0, 2_000);
    meter.pause(2_100);
    meter.resume(7_100);
    meter.observeDelta(0, 9_200);
    meter.reconcile(100);

    expect(meter.activeMs).toBe(9_200);
  });

  it("does not count the gap between the last token and the tool starting", () => {
    // That gap is the loop's own latency, not generation, so the stretch closes at the
    // last delta rather than at the pause.
    const { meter } = metered();
    meter.observeDelta(0, 0);
    meter.observeDelta(0, 1_000);
    meter.pause(4_000);
    meter.reconcile(100);
    expect(meter.activeMs).toBe(1_000);
  });

  it("tolerates a pause before anything was generated", () => {
    const { meter } = metered();
    meter.pause(500);
    meter.resume(900);
    meter.observeDelta(0, 1_000);
    meter.observeDelta(0, 2_000);
    meter.reconcile(50);
    expect(meter.current()).toBe(50);
  });
});

describe("meanTokensPerSecond", () => {
  it("averages the recorded runs", () => {
    expect(meanTokensPerSecond([20, 30, 40])).toBe(30);
  });

  it("answers null for a model with no history (R13.12)", () => {
    expect(meanTokensPerSecond([])).toBeNull();
  });

  it("ignores unusable entries rather than averaging them in as zeroes", () => {
    // A run whose rate was never recorded must not drag the mean down; it is absent
    // data, not a slow run.
    expect(meanTokensPerSecond([20, null, undefined, 0, Number.NaN, 40])).toBe(30);
  });

  it("answers null when nothing in the history is usable", () => {
    expect(meanTokensPerSecond([null, 0, Number.NaN])).toBeNull();
  });
});
