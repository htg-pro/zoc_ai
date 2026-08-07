/**
 * Property 47: Virtualization bounds the mounted row count. R20.4.
 *
 * *For any* transcript of more than 60 settled rows, the number of row elements in the document is
 * bounded by the visible range plus the overscan window on each side — never by the transcript's
 * length — and every mounted row is one the current scroll offset can reach.
 *
 * ## What "bounded" is asserted against, and why it is not a magic number
 *
 * The bound is derived from the harness's own fake layout: a viewport of `FAKE_VIEWPORT_HEIGHT`
 * divided by `FAKE_ROW_HEIGHT` gives the visible count, and `OVERSCAN` rows sit above and below it.
 * A test that asserted "fewer than 50 rows" would pass for a viewport that had silently grown and
 * fail for one that had not, so the number is computed from the same two constants the component
 * reads.
 *
 * The second clause is the one that catches the plausible bug. A virtualiser that mounted the first
 * N rows regardless of scroll offset would satisfy a count bound perfectly; what makes the mounted
 * set correct is that it *follows the offset*, which is asserted by scrolling and requiring the
 * mounted indices to move with it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import fc from "fast-check";

import { VIRTUALIZATION_FLOOR_ROWS } from "@/features/chat/transcript-regions";
import {
  FAKE_ROW_HEIGHT,
  FAKE_VIEWPORT_HEIGHT,
  assistantMessage,
  installFakeLayout,
  renderTranscript,
  resetChatSurface,
  scrollTo,
  userMessage,
} from "./transcript-harness";
import type { ZocUIMessage } from "@/features/chat/wire/ui-message";

/** The component's overscan. Mirrored rather than exported, so a change to it fails here loudly. */
const OVERSCAN = 8;

const VISIBLE_ROWS = Math.ceil(FAKE_VIEWPORT_HEIGHT / FAKE_ROW_HEIGHT);

/**
 * The mounted-row ceiling.
 *
 * Visible rows, plus a full overscan window above and below, plus two: a partially visible row at
 * each edge of the viewport belongs to the range even though the arithmetic above counts whole rows.
 */
const MOUNTED_CEILING = VISIBLE_ROWS + 2 * OVERSCAN + 2;

let uninstall: () => void;

beforeEach(() => {
  resetChatSurface();
  uninstall = installFakeLayout();
});

afterEach(() => {
  cleanup();
  uninstall();
  vi.useRealTimers();
});

/** One settled message per turn, so the settled row count equals the message count. */
function settledMessages(count: number): ZocUIMessage[] {
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

function mountedRowIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[data-zoc-transcript-settled] [data-zoc-row-id]")].map(
    (element) => element.getAttribute("data-zoc-row-id") ?? "",
  );
}

describe("Feature: zoc-agent-chat-rebuild, Property 47: virtualization bounds the mounted row count", () => {
  it("mounts the visible range plus overscan rather than the transcript (R20.4)", () => {
    fc.assert(
      fc.property(fc.integer({ min: VIRTUALIZATION_FLOOR_ROWS + 1, max: 600 }), (rowCount) => {
        const harness = renderTranscript({
          messages: settledMessages(rowCount),
          streaming: false,
        });

        const mounted = mountedRowIds(harness.container);
        expect(mounted.length).toBeLessThanOrEqual(MOUNTED_CEILING);
        expect(mounted.length).toBeLessThan(rowCount);
        // The bound has to be a bound and not an empty region: a virtualiser that mounted nothing
        // would also satisfy every ceiling above.
        expect(mounted.length).toBeGreaterThan(0);

        harness.unmount();
      }),
      { numRuns: 25 },
    );
  });

  it("moves the mounted set with the scroll offset rather than pinning it to the head", () => {
    const rowCount = 400;
    const harness = renderTranscript({
      messages: settledMessages(rowCount),
      streaming: false,
    });
    const element = harness.scrollElement();

    // Anchored on mount, so the transcript is already at the bottom. Two distinct offsets, both far
    // from it, are enough to show the set following the viewport.
    scrollTo(element, 0);
    const atTop = mountedRowIds(harness.container);

    scrollTo(element, 200 * FAKE_ROW_HEIGHT);
    const atMiddle = mountedRowIds(harness.container);

    expect(atTop.length).toBeLessThanOrEqual(MOUNTED_CEILING);
    expect(atMiddle.length).toBeLessThanOrEqual(MOUNTED_CEILING);
    // Disjoint, not merely different: 200 rows of separation is far more than the overscan window,
    // so any overlap would mean the mounted set is not the range the offset names.
    expect(atMiddle.some((id) => atTop.includes(id))).toBe(false);
  });

  it("keeps the streaming tail mounted whole, outside the virtualised region", () => {
    const messages = settledMessages(120);
    const tail: ZocUIMessage = {
      id: "tail",
      role: "assistant",
      metadata: assistantMessage("tail", "").metadata,
      parts: [
        { type: "text", text: "thinking out loud", state: "streaming" },
        { type: "reasoning", text: "considering", state: "streaming" },
      ],
    };

    const harness = renderTranscript({ messages: [...messages, tail], streaming: true });

    const tailRows = harness.container.querySelectorAll(
      "[data-zoc-transcript-streaming] [data-zoc-row-id]",
    );
    // Both rows of the in-flight Run, regardless of where the viewport is: the tail is never
    // virtualised, which is what stops the virtualiser from ever seeing a growing item.
    expect(tailRows.length).toBe(2);
    expect(mountedRowIds(harness.container).length).toBeLessThanOrEqual(MOUNTED_CEILING);
  });
});
