/**
 * Property 48: Scroll anchoring holds in both branches. R20.7, R20.8.
 *
 * *For any* interleaving of row appends and scroll gestures, the transcript satisfies exactly one of
 * two guarantees after every append:
 *
 *   - **anchored** — the viewport is within {@link ANCHOR_GUARANTEE_PX} of the bottom, and no
 *     jump-to-latest control is offered;
 *   - **un-anchored** — the scroll offset is exactly where the user left it, and a jump-to-latest
 *     control is offered naming how many rows have arrived since.
 *
 * ## The two numbers are different on purpose, and the property is what keeps them honest
 *
 * `ANCHOR_THRESHOLD_PX` (32) is the *entry* condition: scrolling further than that from the bottom
 * means the user meant to leave. `ANCHOR_GUARANTEE_PX` (8) is what being anchored *promises*. A test
 * asserting the guarantee at 32 px would pass for an implementation that let the newest row sit half
 * off screen, and a test that entered the state at 8 px would un-anchor on a trackpad's inertial
 * overscroll. Both numbers are imported rather than written, so a change to either fails here.
 *
 * ## Why the appends run through the real component rather than the store
 *
 * `store.test.ts` already asserts `observeScroll`'s arithmetic. What is unproven at that level is the
 * part R20.7 actually asks for: that the scroll *write* lands in the same commit as the DOM growth.
 * That is a claim about a layout effect, and the only way to see it is to grow the DOM and read
 * `scrollTop` back.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup } from "@testing-library/react";
import fc from "fast-check";

import { ANCHOR_THRESHOLD_PX, useChatSurface } from "@/features/chat/store";
import { ANCHOR_GUARANTEE_PX } from "@/features/chat/transcript-regions";
import {
  assistantMessage,
  distanceFromBottom,
  flushFrame,
  installFakeLayout,
  renderTranscript,
  resetChatSurface,
  scrollTo,
  settle,
  userMessage,
  type TranscriptHarness,
} from "./transcript-harness";
import type { ZocUIMessage } from "@/features/chat/wire/ui-message";

/** Enough rows that the transcript scrolls, and that R20.4's 60-row floor is cleared. */
const SEED_ROWS = 70;

let uninstall: () => void;

beforeEach(() => {
  resetChatSurface();
  uninstall = installFakeLayout();
  // The transcript commits deltas on an animation frame, so the frame has to be under the test's
  // control. `setTimeout` is faked with it because the virtualiser debounces its scroll-end callback
  // through one, and a real timer firing after the test ended is an update outside `act`.
  vi.useFakeTimers({
    toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout"],
  });
});

afterEach(() => {
  cleanup();
  uninstall();
  vi.useRealTimers();
});

function seed(count: number): ZocUIMessage[] {
  const messages: ZocUIMessage[] = [];
  for (let index = 0; index < count; index += 1) {
    messages.push(
      index % 2 === 0
        ? userMessage(`u${String(index)}`, `prompt ${String(index)}`)
        : assistantMessage(`a${String(index)}`, `answer ${String(index)}`),
    );
  }
  return messages;
}

function append(
  harness: TranscriptHarness,
  messages: ZocUIMessage[],
  rows: number,
): ZocUIMessage[] {
  const next = [...messages];
  for (let index = 0; index < rows; index += 1) {
    next.push(assistantMessage(`late-${String(next.length)}`, `late answer ${String(next.length)}`));
  }
  harness.setProps({ messages: next });
  flushFrame(harness);
  return next;
}

function jumpControl(harness: TranscriptHarness): HTMLElement | null {
  const element = harness.container.querySelector("[data-zoc-jump-to-latest]");
  return element instanceof HTMLElement ? element : null;
}

describe("Feature: zoc-agent-chat-rebuild, Property 48: scroll anchoring holds in both branches", () => {
  it("keeps the newest row in view while anchored, across any sequence of appends (R20.7)", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 4 }), (batches) => {
        // Per *iteration*, not per test: the chat-local store is a module singleton, so an iteration
        // that left the view un-anchored with a backlog would seed the next one with both.
        cleanup();
        resetChatSurface();
        let messages = seed(SEED_ROWS);
        const harness = renderTranscript({ messages, streaming: false });
        const element = harness.scrollElement();

        expect(useChatSurface.getState().anchored).toBe(true);

        for (const rows of batches) {
          messages = append(harness, messages, rows);
          expect(distanceFromBottom(element)).toBeLessThanOrEqual(ANCHOR_GUARANTEE_PX);
          // An anchored transcript has nothing to jump to.
          expect(jumpControl(harness)).toBeNull();
        }

        harness.unmount();
      }),
      { numRuns: 200 },
    );
  });

  it("holds the offset and offers the jump control while un-anchored (R20.8)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: ANCHOR_THRESHOLD_PX + 1, max: 4000 }),
        fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 4 }),
        (awayBy, batches) => {
          cleanup();
          resetChatSurface();
          let messages = seed(SEED_ROWS);
          const harness = renderTranscript({ messages, streaming: false });
          const element = harness.scrollElement();

          // Leave the bottom by more than the entry threshold. The target is clamped by the fake
          // layout exactly as a browser clamps it, so a distance larger than the scrollable range
          // lands at the top — which is still un-anchored, and still a case the property covers.
          const target = Math.max(0, element.scrollHeight - element.clientHeight - awayBy);
          scrollTo(element, target);
          const held = element.scrollTop;
          fc.pre(distanceFromBottom(element) > ANCHOR_THRESHOLD_PX);
          expect(useChatSurface.getState().anchored).toBe(false);

          let appended = 0;
          for (const rows of batches) {
            messages = append(harness, messages, rows);
            appended += rows;
            // The whole of R20.8's first half: the position is the user's, not the transcript's.
            expect(element.scrollTop).toBe(held);

            const control = jumpControl(harness);
            expect(control).not.toBeNull();
            expect(control?.textContent ?? "").toContain(String(appended));
          }

          harness.unmount();
        },
      ),
      { numRuns: 200 },
    );
  });

  it("re-anchors from the jump control and lands within the guarantee", () => {
    const messages = seed(SEED_ROWS);
    const harness = renderTranscript({ messages, streaming: false });
    const element = harness.scrollElement();

    scrollTo(element, 0);
    expect(useChatSurface.getState().anchored).toBe(false);

    const control = jumpControl(harness);
    expect(control).not.toBeNull();
    // Inside `act`, because the store write happens in the click handler and the scroll write happens
    // in the layout effect of the render that follows it. `settle` then fires the scroll event the
    // browser would fire for that write; firing it before React had committed would read the old
    // offset and un-anchor the view again.
    act(() => {
      control?.click();
    });
    settle(element);

    expect(useChatSurface.getState().anchored).toBe(true);
    expect(distanceFromBottom(element)).toBeLessThanOrEqual(ANCHOR_GUARANTEE_PX);
    // The control removes itself rather than lingering with a stale count.
    expect(jumpControl(harness)).toBeNull();
  });

  it("keeps a growing streaming row in view while anchored (R20.7)", () => {
    const settled = seed(SEED_ROWS);
    let text = "";
    const messages = [...settled, assistantMessage("tail", text, true)];
    const harness = renderTranscript({ messages, streaming: true });
    const element = harness.scrollElement();

    // Forty deltas is one second of R20.3's arrival rate, and each one lengthens the row rather than
    // adding one — which is the case a virtualiser cannot be handed and the reason the tail exists.
    for (let delta = 0; delta < 40; delta += 1) {
      text += "the model keeps talking. ";
      harness.setProps({ messages: [...settled, assistantMessage("tail", text, true)] });
      flushFrame(harness);
      expect(distanceFromBottom(element)).toBeLessThanOrEqual(ANCHOR_GUARANTEE_PX);
    }
  });
});
