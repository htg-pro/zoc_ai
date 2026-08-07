/**
 * Transcript streaming — zoc-agent-chat-rebuild R22.1, R8.1, R20.4, task 22.13.
 *
 * The "transcript streaming" area of R22.1's unit suite, and the three claims 22.13 names for it: deltas
 * append, settled rows are untouched, and the terminal state commits the tail.
 *
 * ## The two regions are the subject
 *
 * The transcript renders in halves — a virtualised settled region and a live tail — and every claim here
 * is really about the boundary between them. A delta must change the tail and nothing else; the terminal
 * state must move the tail's row into the settled region without the row changing. Asserting on
 * `textContent` alone would pass for an implementation that re-rendered the whole list on every delta,
 * which is the failure R8.1 exists to prevent, so the settled claim is asserted on **node identity**: the
 * same `HTMLElement` object, not merely an element with the same text.
 *
 * ## Why the fake layout and the fake clock
 *
 * jsdom has no layout, so the virtualiser would mount nothing; and the delta coalescer schedules a commit
 * per animation frame, so a delta appended without advancing the clock has not been rendered yet. The
 * harness owns both — `installFakeLayout` and `flushFrame` — and using them is what makes "after the
 * delta" a defined moment rather than a race.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";

import {
  assistantMessage,
  flushFrame,
  installFakeLayout,
  renderTranscript,
  resetChatSurface,
  userMessage,
  type TranscriptHarness,
} from "./transcript-harness";
import type { ZocUIMessage } from "@/features/chat/wire/ui-message";

/** A settled exchange, long enough that the newest row has predecessors to leave alone. */
const HISTORY: readonly ZocUIMessage[] = [
  userMessage("u1", "explain the store"),
  assistantMessage("a1", "The store is Session-scoped."),
  userMessage("u2", "and the transcript?"),
];

const streamingTurn = (text: string): ZocUIMessage => assistantMessage("a2", text, true);

const text = (harness: TranscriptHarness): string => harness.scrollElement().textContent ?? "";

/**
 * Every mounted row, keyed by the id the transcript put on it.
 *
 * Read out of the DOM rather than derived from message ids: a row id belongs to the *row* model — one
 * message becomes an answer row, a tool row, and a usage row — so a test that assumed `message.id` would
 * be asserting a naming scheme the transcript never promised.
 */
const rowNodes = (): Map<string, HTMLElement> =>
  new Map(
    [...document.querySelectorAll<HTMLElement>("[data-zoc-row-id]")].map((node) => [
      node.getAttribute("data-zoc-row-id") ?? "",
      node,
    ]),
  );

const settledRowNodes = (): Map<string, HTMLElement> =>
  new Map(
    [
      ...document.querySelectorAll<HTMLElement>("[data-zoc-transcript-settled] [data-zoc-row-id]"),
    ].map((node) => [node.getAttribute("data-zoc-row-id") ?? "", node]),
  );

const tailRowCount = (): number =>
  document.querySelectorAll("[data-zoc-transcript-streaming] [data-zoc-row-id]").length;

let uninstallLayout: () => void;

beforeEach(() => {
  resetChatSurface();
  uninstallLayout = installFakeLayout();
  vi.useFakeTimers({
    toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout"],
  });
});

afterEach(() => {
  cleanup();
  uninstallLayout();
  vi.useRealTimers();
});

describe("Feature: zoc-agent-chat-rebuild, task 22.13: transcript streaming (R22.1)", () => {
  it("appends deltas in order, keeping everything already received", () => {
    const harness = renderTranscript({
      messages: [...HISTORY, streamingTurn("The transcript ")],
      streaming: true,
    });
    flushFrame(harness);
    // No trailing space in the expectation: the answer row renders markdown, which trims it.
    expect(text(harness)).toContain("The transcript");

    harness.setProps({ messages: [...HISTORY, streamingTurn("The transcript renders ")] });
    flushFrame(harness);
    harness.setProps({
      messages: [...HISTORY, streamingTurn("The transcript renders in halves.")],
    });
    flushFrame(harness);

    // Appended, not replaced: the whole string is present and its words are in the order they arrived.
    const rendered = text(harness);
    expect(rendered).toContain("The transcript renders in halves.");
    expect(rendered.indexOf("transcript")).toBeLessThan(rendered.indexOf("halves"));
    harness.unmount();
  });

  it("leaves every settled row's node untouched as the tail grows", () => {
    const harness = renderTranscript({
      messages: [...HISTORY, streamingTurn("one ")],
      streaming: true,
    });
    flushFrame(harness);

    const before = settledRowNodes();
    expect(before.size, "no settled row was mounted to begin with").toBeGreaterThan(0);

    harness.setProps({ messages: [...HISTORY, streamingTurn("one two ")] });
    flushFrame(harness);
    harness.setProps({ messages: [...HISTORY, streamingTurn("one two three ")] });
    flushFrame(harness);

    // The same objects, not equal markup: a transcript that re-created these nodes would lose selection,
    // scroll position, and any expanded disclosure inside them on every delta (R8.1).
    const after = settledRowNodes();
    for (const [id, node] of before) {
      expect(after.get(id), `settled row ${id} was re-created by a delta`).toBe(node);
    }
    harness.unmount();
  });

  it("commits the tail into the settled region when the Run ends", () => {
    const harness = renderTranscript({
      messages: [...HISTORY, streamingTurn("A partial answer")],
      streaming: true,
    });
    flushFrame(harness);
    expect(tailRowCount(), "a streaming Run renders its newest row in the tail").toBeGreaterThan(0);
    const before = settledRowNodes();

    // What the terminal state is, from the transcript's point of view: the part is done and no Run is in
    // flight. Both, because either alone is a real intermediate state — a finished part while the Run
    // continues is the normal case between two turns.
    harness.setProps({
      messages: [...HISTORY, assistantMessage("a2", "A partial answer")],
      streaming: false,
    });
    flushFrame(harness);

    expect(tailRowCount(), "the tail still holds a row after the Run settled").toBe(0);
    // Committed, not dropped. The text is the thing the user keeps.
    expect(text(harness)).toContain("A partial answer");
    // And the row is mounted somewhere — in the settled region now that the tail is empty.
    expect(rowNodes().size).toBeGreaterThan(before.size);
    harness.unmount();
  });

  it("keeps a settled transcript entirely in the settled region", () => {
    const harness = renderTranscript({
      messages: [...HISTORY, assistantMessage("a2", "Done.")],
      streaming: false,
    });
    flushFrame(harness);
    expect(tailRowCount()).toBe(0);
    expect(text(harness)).toContain("Done.");
    harness.unmount();
  });
});
