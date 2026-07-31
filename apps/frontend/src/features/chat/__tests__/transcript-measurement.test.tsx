/**
 * Task 17.1's measurement guard — R20.3, R20.4.
 *
 * Stream 2,000 Message_Parts at 40 parts per second in fake time and assert that the virtualiser
 * measures fewer than three times as many elements as there are settled rows at the end.
 *
 * ## Why a call count is the right regression signal
 *
 * Measurement thrash is what makes a virtualised transcript feel broken: every delta changes the
 * streaming row's height, `measureElement` reports it, the total size is recomputed, and the scroll
 * offset moves under the reader. "Feels smooth" is not checkable, but the number of measurements is,
 * and it is the quantity the four mechanisms in `Transcript.tsx` exist to bound.
 *
 * A settled row is measured once when it mounts, and it mounts once as it passes through the viewport
 * — so the honest number is close to the settled row count, and 3× is headroom for the re-mounts a
 * changing estimate causes. The failures it catches are large, not marginal:
 *
 *   - the streaming tail inside the virtualiser: one measurement per delta, so ~2,000;
 *   - `getItemKey` returning the index: every append shifts every key below it and invalidates the
 *     whole measurement cache;
 *   - measurement inside the collapsible animation rather than on its completion: one per frame.
 *
 * ## What the fake clock does and does not buy
 *
 * It buys arrival *spacing*: 25 ms between parts is R20.3's rate, and the coalescer's behaviour
 * depends on how many parts land between two frames. It does not buy anything about wall-clock cost —
 * the two budgets that need real time and real paint (R19.4's frame interval and the `longtask`
 * assertion) are the `@perf` harness's, because jsdom has no compositor and no `PerformanceObserver`
 * entries to observe.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup } from "@testing-library/react";

import {
  assistantMessage,
  installFakeLayout,
  renderTranscript,
  resetChatSurface,
  settle,
  userMessage,
} from "./transcript-harness";
import type { ZocUIMessage } from "@/features/chat/wire/ui-message";

/** R20.3's arrival rate, as the interval between two parts. */
const PART_INTERVAL_MS = 25;

/** The guard's stream length. */
const TOTAL_PARTS = 2_000;

/** Parts per Run: 1 user part plus 49 assistant events. */
const PARTS_PER_RUN = 50;

const RUNS = TOTAL_PARTS / PARTS_PER_RUN;

/** How often the harness fires the scroll events a real browser would fire while anchored. */
const SETTLE_EVERY = 8;

let uninstall: () => void;

beforeEach(() => {
  resetChatSurface();
  uninstall = installFakeLayout();
  vi.useFakeTimers({
    toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout"],
  });
});

afterEach(() => {
  cleanup();
  uninstall();
  vi.useRealTimers();
});

/**
 * The assistant message for one Run, `events` events in.
 *
 * Deliberately mixed: a text part that grows on most events, a tool part appended every tenth, and a
 * usage part on the last one. A stream of pure text deltas would exercise only the coalescer, and the
 * measurement cache is what fails when the *row set* changes rather than when one row grows.
 */
function assistantAt(run: number, events: number): ZocUIMessage {
  const settledRun = events >= PARTS_PER_RUN - 1;
  const parts: ZocUIMessage["parts"] = [
    {
      type: "text",
      text: `answer ${String(run)} `.repeat(Math.max(1, Math.ceil(events / 6))),
      state: settledRun ? "done" : "streaming",
    },
  ];
  for (let tool = 0; tool * 10 < events; tool += 1) {
    parts.push({
      type: "dynamic-tool",
      toolName: "workspace_read",
      toolCallId: `call-${String(run)}-${String(tool)}`,
      state: "output-available",
      input: { path: `src/file-${String(tool)}.ts` },
      output: { bytes: 128 },
    } as unknown as ZocUIMessage["parts"][number]);
  }
  if (settledRun) {
    parts.push({
      type: "data-zoc-usage",
      data: {
        type: "usage",
        seq: run,
        runId: `run-${String(run)}`,
        messageId: `assistant-${String(run)}`,
        ts: "2026-07-31T10:00:00.000Z",
        inputTokens: 100,
        outputTokens: 200,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        contextLimit: 200_000,
        estimatedCostCents: 1,
        tokensPerSecond: 40,
        messagesInContext: 2,
        sessionMessageCount: 2,
        messagesOutOfWindow: 0,
        summaryActive: false,
      },
    } as unknown as ZocUIMessage["parts"][number]);
  }
  return {
    id: `assistant-${String(run)}`,
    role: "assistant",
    metadata: assistantMessage(`assistant-${String(run)}`, "").metadata,
    parts,
  };
}

describe("Feature: zoc-agent-chat-rebuild, task 17.1: the measurement guard", () => {
  it("measures fewer than 3× the settled row count over 2,000 parts at 40 parts/second", () => {
    let measurements = 0;
    const settledMessages: ZocUIMessage[] = [];

    const harness = renderTranscript({
      messages: [],
      streaming: false,
      onRowMeasured: () => {
        measurements += 1;
      },
    });
    const element = harness.scrollElement();

    let part = 0;
    for (let run = 0; run < RUNS; run += 1) {
      const prompt = userMessage(`user-${String(run)}`, `prompt number ${String(run)}`);
      settledMessages.push(prompt);
      harness.setProps({ messages: [...settledMessages], streaming: true });
      part += 1;

      for (let event = 1; event < PARTS_PER_RUN; event += 1) {
        harness.setProps({
          messages: [...settledMessages, assistantAt(run, event)],
          streaming: event < PARTS_PER_RUN - 1,
        });
        act(() => {
          vi.advanceTimersByTime(PART_INTERVAL_MS);
        });
        part += 1;
        if (part % SETTLE_EVERY === 0) settle(element);
      }

      // The Run reached a terminal state: its rows join the settled list in one commit.
      settledMessages.push(assistantAt(run, PARTS_PER_RUN - 1));
      harness.setProps({ messages: [...settledMessages], streaming: false });
      act(() => {
        vi.advanceTimersByTime(PART_INTERVAL_MS);
      });
      settle(element);
    }

    expect(part).toBe(TOTAL_PARTS);

    const settledRows = harness.container.querySelectorAll(
      "[data-zoc-transcript-settled] [data-index]",
    ).length;
    // Mounted rows are a fraction of the settled list, so the row *count* comes from the region's
    // total size rather than from the DOM: 4 rows per Run — the prompt, the answer, the timeline, and
    // the usage line.
    const totalSettledRows = RUNS * 4;

    expect(settledRows).toBeGreaterThan(0);
    expect(measurements).toBeGreaterThan(0);
    expect(measurements).toBeLessThan(3 * totalSettledRows);
  });
});
