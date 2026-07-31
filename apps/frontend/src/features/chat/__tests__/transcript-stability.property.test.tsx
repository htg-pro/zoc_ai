/**
 * Property 6: Text appends never re-render settled rows. R8.1.
 *
 * *For any* settled transcript and *any* sequence of text deltas landing on the in-flight Run, no row
 * belonging to an earlier message renders again. The in-flight row renders on every commit — that is
 * the delta arriving — and every row above it is left alone.
 *
 * ## Why this is asserted by counting renders rather than by comparing the DOM
 *
 * React reuses DOM nodes across re-renders, so a settled row that re-rendered looks identical in the
 * document to one that did not. Node identity, `innerHTML`, and snapshot comparison are all blind to
 * exactly the thing R8.1 constrains. So `TranscriptRowView` is replaced with a stub that records the
 * row ids it is called with, and the property is a claim about that log.
 *
 * ## The two mechanisms it holds, and how each one fails
 *
 * The memo in `Transcript.tsx` is the visible half. The invisible half is the identity of what it
 * compares: rows come from a per-message cache (`transcript-regions.ts`) and every handler passes
 * through `useStableCallback`. Remove the cache and each commit builds new row objects, so the memo
 * compares unequal props and every mounted row re-renders. Remove the callback wrapper and a caller
 * with an inline `onToolRetry` does the same. Both regressions are invisible on screen and both fail
 * here, which is the whole reason this property is worth its weight.
 *
 * The second test asserts the cache directly, because a property that only watched renders would
 * still pass if the memo were replaced with a hand-written comparator that ignored the row prop.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import fc from "fast-check";

import { transcriptRegions, type RowCache } from "@/features/chat/transcript-regions";
import {
  assistantMessage,
  flushFrame,
  installFakeLayout,
  renderTranscript,
  resetChatSurface,
  userMessage,
} from "./transcript-harness";
import type { TranscriptRowViewProps } from "@/features/chat/TranscriptRowView";
import type { ZocUIMessage } from "@/features/chat/wire/ui-message";

/** Every row id the row renderer was called with, in order. Reset per iteration. */
const renderLog: string[] = [];

vi.mock("@/features/chat/TranscriptRowView", () => ({
  TranscriptRowView: ({ row }: TranscriptRowViewProps) => {
    renderLog.push(row.id);
    // Text content matters: the harness's fake layout derives a row's height from it, so a stub that
    // rendered nothing would give every row the same height and the anchoring would stop moving.
    const text = "text" in row ? row.text : row.kind;
    return <div data-zoc-stub-row={row.kind}>{text}</div>;
  },
}));

let uninstall: () => void;

beforeEach(() => {
  renderLog.length = 0;
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

function settledMessages(count: number): ZocUIMessage[] {
  const messages: ZocUIMessage[] = [];
  for (let index = 0; index < count; index += 1) {
    messages.push(
      index % 2 === 0
        ? userMessage(`u${String(index)}`, `prompt number ${String(index)}`)
        : assistantMessage(`a${String(index)}`, `settled answer number ${String(index)}`),
    );
  }
  return messages;
}

describe("Feature: zoc-agent-chat-rebuild, Property 6: text appends never re-render settled rows", () => {
  it("renders only the in-flight row as deltas arrive (R8.1)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 70, max: 140 }),
        fc.integer({ min: 2, max: 25 }),
        (settledCount, deltas) => {
          cleanup();
          renderLog.length = 0;
          resetChatSurface();

          const settled = settledMessages(settledCount);
          let text = "The answer begins.";
          const harness = renderTranscript({
            messages: [...settled, assistantMessage("tail", text, true)],
            streaming: true,
          });

          // Everything up to here is the first paint, which of course renders rows.
          const settledIds = new Set(renderLog.filter((id) => id !== "tail:0"));
          renderLog.length = 0;

          for (let delta = 0; delta < deltas; delta += 1) {
            text += ` delta ${String(delta)} of the streamed answer.`;
            harness.setProps({
              messages: [...settled, assistantMessage("tail", text, true)],
            });
            flushFrame(harness);
          }

          const rerendered = renderLog.filter((id) => settledIds.has(id));
          expect(rerendered).toEqual([]);
          // And the tail did render, so the assertion above is not passing because nothing rendered.
          expect(renderLog.filter((id) => id === "tail:0").length).toBeGreaterThan(0);

          harness.unmount();
        },
      ),
      { numRuns: 20 },
    );
  });

  it("returns identical row objects for a message that did not change", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), (settledCount) => {
        const settled = settledMessages(settledCount);
        const cache: RowCache = new WeakMap();

        const first = transcriptRegions([...settled, assistantMessage("tail", "a", true)], {
          inFlight: true,
          cache,
        });
        const second = transcriptRegions([...settled, assistantMessage("tail", "ab", true)], {
          inFlight: true,
          cache,
        });

        expect(second.settled.length).toBe(first.settled.length);
        // Identity, not equality: the memo compares with `Object.is`, so structural equality would
        // pass here and still re-render every row in the browser.
        for (const [index, row] of first.settled.entries()) {
          expect(second.settled[index]).toBe(row);
        }
        // The tail is deliberately not cached — its identity changes on every delta, so caching it
        // would fill the map with one dead entry per delta.
        expect(second.streaming[0]).not.toBe(first.streaming[0]);
      }),
      { numRuns: 40 },
    );
  });
});
