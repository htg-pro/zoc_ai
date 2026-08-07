/**
 * The transcript's fake layout — zoc-agent-chat-rebuild task 17.1's guards, Properties 6, 47, 48.
 *
 * Feature: zoc-agent-chat-rebuild, task 17.1.
 *
 * jsdom has no layout engine: `offsetHeight`, `clientHeight`, and `scrollHeight` are 0 for every
 * element and `scrollTop` is a getter that returns 0 and a setter that does nothing. A virtualiser
 * asked to map a scroll offset onto a row range under those conditions reports a viewport of zero
 * height and mounts the overscan window and nothing else — so a test written against unpatched jsdom
 * would assert that virtualisation bounds the mounted row count, pass, and go on passing after the
 * virtualiser was deleted.
 *
 * So this module installs a small, *self-consistent* fake layout rather than a set of stubbed return
 * values. Every row is `rowHeight` tall, the scroll container is `viewportHeight` tall, and the
 * container's `scrollHeight` is computed from what is actually in the DOM: the settled spacer's
 * inline height plus one `rowHeight` per mounted tail row. `scrollTop` is backed by a real store and
 * clamped the way a browser clamps it. That is what makes `scrollHeight - scrollTop - clientHeight`
 * a number the anchoring assertions can mean something about.
 *
 * **What it does not fake.** Frame timing is left to the fake clock, and paint is left out
 * altogether — the two budgets that need real paint (R19.4's frame interval and R20.5's heap) are
 * the `@perf` harness's, not this one's.
 */

import { act, render } from "@testing-library/react";
import { vi } from "vitest";
import type { ReactElement } from "react";

import { ChatMotionProvider } from "@/lib/reduced-motion-provider";
import { Transcript, type TranscriptProps } from "@/features/chat/Transcript";
import { INITIAL_CHAT_SURFACE_STATE, useChatSurface } from "@/features/chat/store";
import type { ZocUIMessage } from "@/features/chat/wire/ui-message";

/** A one-line row's height. Rows are this tall or a multiple of it — never shorter. */
export const FAKE_ROW_HEIGHT = 40;

/** Characters per line in the fake layout, which is what makes a growing text part grow its row. */
const CHARS_PER_LINE = 60;

/** The scroll container's height: fifteen one-line rows, which is a plausible transcript viewport. */
export const FAKE_VIEWPORT_HEIGHT = 600;

export interface FakeLayoutOptions {
  rowHeight?: number;
  viewportHeight?: number;
}

interface Patch {
  readonly target: object;
  readonly property: string;
  readonly saved: PropertyDescriptor | undefined;
}

function isScrollContainer(element: Element): boolean {
  return element.hasAttribute("data-zoc-transcript-scroll");
}

function isRow(element: Element): boolean {
  return element.hasAttribute("data-zoc-row-id");
}

/**
 * Install the fake layout. Returns the uninstaller, which every caller must run in `afterEach` —
 * these are prototype patches, so a leak would silently change the layout every later suite sees.
 */
export function installFakeLayout(options: FakeLayoutOptions = {}): () => void {
  const rowHeight = options.rowHeight ?? FAKE_ROW_HEIGHT;
  const viewportHeight = options.viewportHeight ?? FAKE_VIEWPORT_HEIGHT;
  const scrollTops = new WeakMap<Element, number>();
  const patches: Patch[] = [];

  const patch = (target: object, property: string, descriptor: PropertyDescriptor) => {
    patches.push({
      target,
      property,
      saved: Object.getOwnPropertyDescriptor(target, property),
    });
    Object.defineProperty(target, property, { configurable: true, ...descriptor });
  };

  /**
   * A row's height: one line per {@link CHARS_PER_LINE} characters of rendered text.
   *
   * Crude, and deliberately not fixed. R20.7's hard case is a row that *grows* — a text part
   * accumulating deltas — and a layout where every row is exactly one row tall cannot produce it, so
   * a test written against a fixed height would assert anchoring against a transcript whose content
   * height never changed between deltas. Every row is still at least `rowHeight`, which is what keeps
   * Property 47's visible-row arithmetic an upper bound.
   */
  const heightOf = (element: Element): number => {
    if (isScrollContainer(element)) return viewportHeight;
    if (!isRow(element)) return 0;
    const characters = element.textContent?.length ?? 0;
    return Math.max(1, Math.ceil(characters / CHARS_PER_LINE)) * rowHeight;
  };

  /**
   * The container's content height, read from the DOM rather than tracked alongside it.
   *
   * The settled region contributes the spacer's inline height, which is the virtualiser's own total
   * size; the tail contributes the sum of its rows. Gaps between rows are ignored, which makes every
   * figure here a slight under-estimate and none of them wrong in a direction that would hide an
   * anchoring failure.
   */
  const contentHeightOf = (element: Element): number => {
    const spacer = element.querySelector("[data-zoc-transcript-settled]");
    const spacerHeight =
      spacer instanceof HTMLElement ? Number.parseFloat(spacer.style.height || "0") : 0;
    let tailHeight = 0;
    for (const row of element.querySelectorAll(
      "[data-zoc-transcript-streaming] [data-zoc-row-id]",
    )) {
      tailHeight += heightOf(row);
    }
    return (Number.isFinite(spacerHeight) ? spacerHeight : 0) + tailHeight;
  };

  patch(HTMLElement.prototype, "offsetHeight", {
    get(this: HTMLElement) {
      return heightOf(this);
    },
  });
  patch(HTMLElement.prototype, "offsetWidth", {
    get(this: HTMLElement) {
      return isScrollContainer(this) || isRow(this) ? 800 : 0;
    },
  });
  patch(HTMLElement.prototype, "clientHeight", {
    get(this: HTMLElement) {
      return isScrollContainer(this) ? viewportHeight : 0;
    },
  });
  patch(HTMLElement.prototype, "scrollHeight", {
    get(this: HTMLElement) {
      if (!isScrollContainer(this)) return 0;
      // Never below the viewport: a container shorter than its viewport does not scroll, and a
      // negative `scrollHeight - clientHeight` would make the clamp below nonsense.
      return Math.max(Math.round(contentHeightOf(this)), viewportHeight);
    },
  });
  patch(HTMLElement.prototype, "scrollTop", {
    get(this: HTMLElement) {
      return scrollTops.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      const maximum = Math.max(0, this.scrollHeight - this.clientHeight);
      scrollTops.set(this, Math.min(Math.max(0, value), maximum));
    },
  });
  patch(Element.prototype, "getBoundingClientRect", {
    value(this: Element) {
      const height = heightOf(this);
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 800,
        bottom: height,
        width: isScrollContainer(this) || isRow(this) ? 800 : 0,
        height,
        toJSON: () => ({}),
      } as DOMRect;
    },
  });

  return () => {
    for (const entry of patches.reverse()) {
      if (entry.saved === undefined) {
        delete (entry.target as Record<string, unknown>)[entry.property];
      } else {
        Object.defineProperty(entry.target, entry.property, entry.saved);
      }
    }
  };
}

/** The measured distance from the bottom, which is the quantity both anchoring branches are about. */
export function distanceFromBottom(element: HTMLElement): number {
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}

/**
 * Scroll the container and tell the page about it.
 *
 * The event matters as much as the offset: React's `onScroll` and the virtualiser's own offset
 * observer are both listeners on this element, and a test that only wrote `scrollTop` would move the
 * viewport without either of them noticing — which is not a state a browser can be in.
 */
export function scrollTo(element: HTMLElement, top: number): void {
  act(() => {
    element.scrollTop = top;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  settle(element);
}

/** How many rounds {@link settle} will run before it gives up on the layout converging. */
const SETTLE_ROUNDS = 6;

/**
 * Fire the scroll events a browser would fire for the transcript's *own* writes to `scrollTop`.
 *
 * A browser dispatches `scroll` after the commit that moved the viewport and before the next paint —
 * never from inside the layout effect that did the moving. Emulating it from the `scrollTop` setter
 * would put the dispatch inside that effect, where the virtualiser's `flushSync` cannot run and React
 * warns about it; so the dispatch happens here instead, after the commit, which is both quieter and
 * closer to the real ordering.
 *
 * It loops because one round can move the viewport again: newly mounted rows are measured, the total
 * size grows past the estimate, the clamp on `scrollTop` changes, and the anchoring effect writes a
 * new offset. Convergence is the normal case and the round cap is there so a bug is a failed
 * assertion rather than a hung test.
 */
export function settle(element: HTMLElement): void {
  let previous = element.scrollTop;
  for (let round = 0; round < SETTLE_ROUNDS; round += 1) {
    act(() => {
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    const current = element.scrollTop;
    if (current === previous) return;
    previous = current;
  }
}

/**
 * Reset the chat-local store. It is a module singleton, so a leak crosses suites — and crosses
 * property *iterations*, where an un-anchored view with a backlog would seed the next iteration.
 *
 * Merged rather than replaced: `replace: true` would drop the actions along with the state, and the
 * transcript would then fail on its first scroll with `observeScroll is not a function`.
 *
 * Wrapped in `act` because a mounted transcript subscribes to this store: an iteration that aborted
 * on a failed precondition leaves its tree mounted, and a bare `setState` would re-render it outside
 * `act` and print a warning that has nothing to do with the property under test.
 */
export function resetChatSurface(): void {
  act(() => {
    useChatSurface.setState(
      {
        ...INITIAL_CHAT_SURFACE_STATE,
        expanded: new Set<string>(),
        mentions: [],
        hunkDecisions: {},
        lastRenderedSeq: {},
      },
      false,
    );
  });
}

// ── Message fixtures ──────────────────────────────────────────────────

export function metadataOf(
  overrides: Partial<ZocUIMessage["metadata"]> = {},
): NonNullable<ZocUIMessage["metadata"]> {
  return {
    runId: "run_1",
    provider: "anthropic",
    model: "claude-opus-5",
    conversationMode: "agent",
    startedAt: "2026-07-31T10:00:00.000Z",
    finishedAt: null,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostCents: null,
    tokensPerSecond: null,
    messagesInContext: 1,
    sessionMessageCount: 1,
    messagesOutOfWindow: 0,
    summaryActive: false,
    rulesSources: [],
    ...overrides,
  };
}

/** A settled user turn. One part, one row. */
export function userMessage(id: string, text: string): ZocUIMessage {
  return { id, role: "user", metadata: metadataOf(), parts: [{ type: "text", text }] };
}

/**
 * An assistant message carrying `text` in one text part.
 *
 * `streaming` drives the part's own state, not the transcript's: the transcript is told a Run is in
 * flight through its `streaming` prop, and the part state is what makes the row draw as unfinished.
 */
export function assistantMessage(id: string, text: string, streaming = false): ZocUIMessage {
  return {
    id,
    role: "assistant",
    metadata: metadataOf({ runId: id }),
    parts: [{ type: "text", text, state: streaming ? "streaming" : "done" }],
  };
}

// ── Rendering ─────────────────────────────────────────────────────────

export interface TranscriptHarness {
  /** The native scroll container. Throws if it is missing, which is a real failure. */
  scrollElement(): HTMLElement;
  setProps(next: Partial<TranscriptProps>): void;
  unmount(): void;
  container: HTMLElement;
}

function wrap(props: TranscriptProps): ReactElement {
  // `budget={null}` disables the dev-only motion concurrency counter: this harness renders hundreds
  // of rows and the counter's warnings would drown the output it is not the subject of.
  return (
    <ChatMotionProvider budget={null}>
      <Transcript {...props} />
    </ChatMotionProvider>
  );
}

/** Render the transcript inside the motion provider, with a prop setter for the update path. */
export function renderTranscript(initial: TranscriptProps): TranscriptHarness {
  let props = initial;
  const view = render(wrap(props));

  const scrollElement = (): HTMLElement => {
    const element = view.container.querySelector("[data-zoc-transcript-scroll]");
    if (!(element instanceof HTMLElement)) {
      throw new Error("The transcript rendered no scroll container.");
    }
    return element;
  };

  settle(scrollElement());

  return {
    container: view.container,
    scrollElement,
    setProps(next) {
      props = { ...props, ...next };
      act(() => {
        view.rerender(wrap(props));
      });
      settle(scrollElement());
    },
    unmount() {
      view.unmount();
    },
  };
}

/**
 * Advance the fake clock far enough to run the pending animation frame, then let React commit.
 *
 * One frame is 16 ms of fake time. The coalescer schedules at most one frame at a time, so a caller
 * that appended several deltas between two calls sees exactly one commit — which is the behaviour
 * under test rather than an artefact of the harness.
 */
export function flushFrame(harness?: TranscriptHarness): void {
  act(() => {
    vi.advanceTimersByTime(17);
  });
  if (harness !== undefined) settle(harness.scrollElement());
}
