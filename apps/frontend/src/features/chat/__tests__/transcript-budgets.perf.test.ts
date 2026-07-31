/**
 * `@perf` — budgets 19.4 and 20.5, and task 17.1's `longtask` guard.
 *
 * Excluded from the default `vitest run` (see `vitest.config.ts`) and run explicitly with
 * `pnpm test:perf` on a fixed runner. Three numbers are asserted, all against headless Chromium
 * driving the shipped `Transcript` through the fixture at `src/features/chat/perf/`:
 *
 *   - **20.5** — a 500-message Session's attributable JavaScript heap stays at or below 400 MB.
 *     Attributable means *after minus before*: the empty page's heap is measured first and subtracted,
 *     because a figure that included React, the markdown pipeline, and Chromium's own allocations would
 *     be a budget on the browser rather than on the transcript.
 *   - **19.4** — the p95 interval between animation frames stays at or below 18.2 ms over a 10 s stream
 *     at 40 parts per second. 18.2 ms is the 55 fps floor the requirement names.
 *   - **17.1's second guard** — zero `longtask` entries over a 30 s stream at the same rate, which is
 *     the primary check on the delta-coalescing design: a task over 50 ms is exactly what R20.3
 *     forbids, and `longtask` is the browser's own report of one.
 *
 * ## Why these three cannot live with the rest of the suite
 *
 * jsdom has no compositor, so `requestAnimationFrame` there is a timer and its intervals measure the
 * timer. It has no `PerformanceObserver` entries at all. And it has no way to force a collection or read
 * a heap, so a memory assertion against it would be an assertion about nothing. The Tauri WebView
 * exposes neither the memory API nor a debugging protocol, which leaves headless Chromium.
 *
 * ## Why a skip rather than a failure when no browser is present
 *
 * A developer without Chromium installed should not see a red suite for a budget that cannot be
 * measured on their machine. The skip is loud — it names the environment variable that fixes it — and
 * the fixed runner sets `ZOC_PERF_CHROME`, so a silent skip in CI is a configuration bug rather than a
 * missing assertion.
 */

// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findChrome, launchPerfBrowser, type PerfBrowser } from "@/features/chat/perf/browser";
import { startFixtureServer, type FixtureServer } from "@/features/chat/perf/server";
import type { LatencyReport, StreamReport } from "@/features/chat/perf/fixture-entry";

/** R20.5's ceiling, in bytes. */
const HEAP_BUDGET_BYTES = 400 * 1024 * 1024;

/** R20.5's Session size. */
const SESSION_MESSAGES = 500;

/** R19.4's 55 fps floor, expressed as the interval it allows. */
const FRAME_INTERVAL_BUDGET_MS = 18.2;

/** R20.3's arrival rate. */
const PARTS_PER_SECOND = 40;

/** Task 16.1's ceiling on receipt-to-commit for one tool entry, in milliseconds. */
const TOOL_ENTRY_BUDGET_MS = 200;

/** R12.2's ceiling on keystroke-to-paint for the mention picker, in milliseconds. */
const MENTION_BUDGET_MS = 100;

/** R12.2's workspace size. */
const INDEXED_PATHS = 20_000;

const chrome = findChrome();

/** Vite's first-run dependency optimisation plus a browser launch is the slow part, not the streams. */
const SETUP_TIMEOUT_MS = 180_000;

describe.skipIf(chrome === null)("@perf Feature: zoc-agent-chat-rebuild, transcript budgets", () => {
  let server: FixtureServer;
  let browser: PerfBrowser;

  beforeAll(async () => {
    server = await startFixtureServer();
    // `chrome` is non-null inside a `skipIf(chrome === null)` block; the assertion is for the compiler.
    browser = await launchPerfBrowser(chrome ?? "");
    await browser.navigate(server.url);
    // The fixture installs its handle after the first commit, so a driver that raced it would evaluate
    // against `undefined` and report a protocol error rather than a budget failure.
    await browser.evaluate<boolean>(
      "new Promise((resolve) => { const poll = () => window.__zocPerf ? resolve(true) : setTimeout(poll, 25); poll(); })",
    );
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it(
    "keeps a 500-message Session's attributable heap at or below 400 MB (R20.5)",
    async () => {
      await browser.collectGarbage();
      const baseline = await browser.heapUsedBytes();

      const mounted = await browser.evaluate<number>(
        `window.__zocPerf.setMessageCount(${String(SESSION_MESSAGES)})`,
      );
      expect(mounted).toBe(SESSION_MESSAGES);

      await browser.collectGarbage();
      const loaded = await browser.heapUsedBytes();
      const attributable = loaded - baseline;

      // A negative or zero delta would mean the collection reclaimed more than the Session allocated,
      // which means the fixture did not mount — a pass for the wrong reason.
      expect(attributable).toBeGreaterThan(0);
      expect(attributable).toBeLessThanOrEqual(HEAP_BUDGET_BYTES);
    },
    SETUP_TIMEOUT_MS,
  );

  it(
    "holds the p95 animation-frame interval at or below 18.2 ms over a 10 s stream (R19.4)",
    async () => {
      await browser.evaluate<number>(`window.__zocPerf.setMessageCount(120)`);
      const report = await browser.evaluate<StreamReport>(
        `window.__zocPerf.stream({ partsPerSecond: ${String(PARTS_PER_SECOND)}, durationMs: 10000 })`,
      );

      // The stream has to have run at roughly the rate asked for, or the interval it produced is not
      // the interval the budget is about. 10 s at 40 parts/second is 400 parts; timers drift.
      expect(report.parts).toBeGreaterThan(300);
      expect(report.frameSamples).toBeGreaterThan(300);
      expect(report.p95IntervalMs).toBeLessThanOrEqual(FRAME_INTERVAL_BUDGET_MS);
    },
    120_000,
  );

  it(
    "produces no long task over a 30 s stream at 40 parts/second (task 17.1)",
    async () => {
      // The entry type has to be observable, or a zero count means "not measured" rather than "clean".
      const observable = await browser.evaluate<boolean>(
        "PerformanceObserver.supportedEntryTypes.includes('longtask')",
      );
      expect(observable).toBe(true);

      await browser.evaluate<number>(`window.__zocPerf.setMessageCount(240)`);
      const report = await browser.evaluate<StreamReport>(
        `window.__zocPerf.stream({ partsPerSecond: ${String(PARTS_PER_SECOND)}, durationMs: 30000 })`,
        // The evaluation does not return until the stream ends, so the protocol timeout has to clear
        // the stream's own duration with room for the browser to be slow.
        90_000,
      );

      expect(report.parts).toBeGreaterThan(900);
      expect(report.longTasks).toBe(0);
    },
    180_000,
  );

  it(
    "commits a tool entry within 200 ms of the part's receipt, over 30 calls (task 16.1)",
    async () => {
      await browser.evaluate<number>(`window.__zocPerf.setMessageCount(120)`);
      const report = await browser.evaluate<LatencyReport>(
        "window.__zocPerf.toolCallLatency(30)",
        60_000,
      );

      expect(report.samples).toBe(30);
      // The maximum, not the median: 16.1's guard is about the worst entry a user waits for, and a
      // median under budget with a 400 ms outlier is exactly the case a percentile would hide.
      expect(report.maxMs).toBeLessThan(TOOL_ENTRY_BUDGET_MS);
    },
    120_000,
  );

  it(
    "paints mention results within 100 ms of a keystroke over a 20,000-path index (R12.2)",
    async () => {
      // The paint half of 20.2's guard. The search half runs in the default suite, where jsdom measures
      // pure JavaScript faithfully; this half needs a real DOM, because rendering fifty `cmdk` rows inside
      // a Radix popover costs six times as much in jsdom as it does in Chromium and a browser budget
      // asserted against that number would fail for the wrong reason.
      //
      // The interval includes the composer's 60 ms debounce, deliberately: R12.2 is about how long a user
      // waits after a keystroke, and the wait starts when they press the key.
      const report = await browser.evaluate<LatencyReport>(
        `window.__zocPerf.mentionLatency({ indexed: ${String(INDEXED_PATHS)}, keystrokes: 50 })`,
        120_000,
      );

      // Most of the fifty queries have to have matched something, or the maximum is the cost of an empty
      // result set rather than of a full one.
      expect(report.samples).toBeGreaterThan(25);
      expect(report.maxMs).toBeLessThan(MENTION_BUDGET_MS);
    },
    180_000,
  );
});
